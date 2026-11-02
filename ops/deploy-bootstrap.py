#!/usr/bin/env python3
"""Verify, install and start the deployment receiver.

This file is the trust root of the deployment channel: it is the one program on
the host that a deployment may not replace, because it decides which revision of
ops/github-deploy.py runs next. It therefore stays small, and it never holds the
receiver's lock across the handover -- the receiver keeps that logic unchanged.

The receiver reads its payload from standard input. This program must read that
payload first to learn which revision to install, so it hands the bytes on
through a pipe and never through a temporary file: the payload carries the
registry token, and writing it out would leave the token on the host's disk.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request

CONFIG_PATH = Path('/etc/opennavo/github-deploy.json')
REMOTE = 'https://raw.githubusercontent.com/opennavo/OpenNavo/{revision}/ops/github-deploy.py'
REVISION = re.compile(r'[0-9a-f]{40}\Z')
CHECKSUM = re.compile(r'[0-9a-f]{64}\Z')
# Mirrors the receiver's own stdin bound so a payload cannot grow here unnoticed.
MAX_PAYLOAD = 80 * 1024 * 1024
RETENTION = 5
# The child uses this only when exec itself failed; the receiver never exits 127.
EXEC_FAILED = 127


def fail(message):
    print('Receiver bootstrap failed: ' + message, file=sys.stderr)
    sys.exit(1)


def revision_of(payload):
    revision = payload.get('receiver', '')
    if not isinstance(revision, str) or not REVISION.fullmatch(revision):
        # The revision becomes a directory name, so anything but 40 lowercase hex
        # characters could step outside the receiver directory.
        fail('the payload does not name a full 40-character receiver revision')
    return revision


def fetch(revision):
    url = REMOTE.format(revision=revision)
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            data = response.read(MAX_PAYLOAD + 1)
    except urllib.error.URLError as error:
        # Named explicitly: an unreachable host looks like a broken receiver otherwise.
        fail(f'cannot fetch the receiver for revision {revision} from GitHub ({error.reason}); '
             'the host may be unable to reach raw.githubusercontent.com')
    if len(data) > MAX_PAYLOAD:
        fail(f'the receiver for revision {revision} is larger than the limit')
    return data


def stage(directory, revision, data):
    """Write the receiver for one revision; content-addressed, so a re-run rewrites identical bytes."""
    target = directory / revision
    target.mkdir(parents=True, exist_ok=True)
    temporary = target / ('.github-deploy.py.%d' % os.getpid())
    temporary.write_bytes(data)
    os.replace(temporary, target / 'github-deploy.py')
    installed = (target / 'github-deploy.py').read_bytes()
    if hashlib.sha256(installed).hexdigest() != hashlib.sha256(data).hexdigest():
        fail(f'the receiver written for revision {revision} does not match the verified bytes')
    return target / 'github-deploy.py'


def check(receiver):
    """Compile and self-check the staged receiver before it can become current.

    Both run before the current pointer moves, so a receiver that cannot even
    load never replaces one that works.
    """
    steps = ((['-I', '-m', 'py_compile', str(receiver)], 'compile'),
             ([str(receiver), '--self-check'], 'self-check'))
    for arguments, name in steps:
        try:
            subprocess.run([sys.executable, *arguments], check=True, capture_output=True, text=True, timeout=120)
        except subprocess.CalledProcessError as error:
            detail = (error.stderr or error.stdout or '').strip().splitlines()
            reason = detail[-1] if detail else 'exit %d' % error.returncode
            fail('the receiver failed its %s step, so the current receiver was left in place: %s' % (name, reason))
        except subprocess.TimeoutExpired:
            fail('the receiver %s step timed out, so the current receiver was left in place' % name)


def point(path, target):
    """Replace one symlink atomically, so no reader ever sees it missing."""
    temporary = path.with_name('.%s.%d' % (path.name, os.getpid()))
    try:
        temporary.unlink()
    except FileNotFoundError:
        pass
    os.symlink(target, temporary)
    os.replace(temporary, path)


def switch(directory, revision):
    current, previous = directory / 'current', directory / 'previous'
    if current.is_symlink():
        replaced = os.readlink(current)
        if replaced != revision:
            point(previous, replaced)
    point(current, revision)


def rollback(directory):
    """Point current back at previous; used when the receiver just installed cannot start."""
    current, previous = directory / 'current', directory / 'previous'
    if not previous.is_symlink():
        return False
    point(current, os.readlink(previous))
    return True


def prune(directory):
    """Keep the newest versions, never the two current and previous point at.

    Path.is_dir() follows symlinks, so the protected versions are resolved first:
    filtering by name alone would delete the very directory current points at.
    """
    protected = {Path(os.readlink(directory / name)).name
                 for name in ('current', 'previous') if (directory / name).is_symlink()}
    versions = [entry for entry in directory.iterdir()
                if entry.is_dir() and not entry.is_symlink() and REVISION.fullmatch(entry.name)]
    versions.sort(key=lambda entry: entry.stat().st_mtime, reverse=True)
    for entry in versions[RETENTION:]:
        if entry.name in protected:
            continue
        for child in sorted(entry.iterdir()):
            child.unlink()
        entry.rmdir()


def run(receiver, payload):
    """Start the receiver with the original payload on its standard input.

    A pipe, not a temporary file: the payload carries the registry token. The
    receiver may exit before reading it (a busy lock does that), which closes the
    pipe early; that is its exit status to report, not a bootstrap failure.
    """
    if not receiver.is_file():
        return EXEC_FAILED
    process = subprocess.Popen([sys.executable, str(receiver)], stdin=subprocess.PIPE)
    try:
        process.communicate(payload)
    except BrokenPipeError:
        process.wait()
    return process.returncode


def install(config, payload):
    """Fetch, verify, check and switch; returns the receiver that should run."""
    revision = revision_of(payload)
    expected = payload.get('receiver_sha256', '')
    if not isinstance(expected, str) or not CHECKSUM.fullmatch(expected):
        fail('the payload does not carry a full 64-character receiver checksum')
    data = fetch(revision)
    if hashlib.sha256(data).hexdigest() != expected:
        fail('the receiver fetched for revision %s does not match the checksum in the payload' % revision)
    directory = Path(config['root']) / 'receiver'
    directory.mkdir(parents=True, exist_ok=True)
    check(stage(directory, revision, data))
    # Only the switch and the prune run under the lock: a concurrent deployment
    # must not see current between two revisions, and the receiver takes the
    # lock itself once it starts.
    with (Path(config['root']) / 'deploy/github-deploy.lock').open('w') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        switch(directory, revision)
        prune(directory)
    print('receiver: installed ' + revision, flush=True)
    return directory / 'current/github-deploy.py'


def main():
    os.umask(0o077)
    try:
        config = json.loads(CONFIG_PATH.read_text())
    except (OSError, ValueError) as error:
        fail('cannot read the host configuration at %s: %s' % (CONFIG_PATH, type(error).__name__))
    payload = sys.stdin.buffer.read(MAX_PAYLOAD + 1)
    if len(payload) > MAX_PAYLOAD:
        fail('the deployment payload exceeds the limit')
    message = json.loads(payload)
    if 'receiver' not in message:
        # Nothing to install: a desktop publish, or a sender older than this file.
        receiver = Path(config['root']) / 'receiver/current/github-deploy.py'
        if not receiver.exists():
            fail('no receiver is installed and this payload installs none')
        sys.exit(run(receiver, payload))
    receiver = install(config, message)
    status = run(receiver, payload)
    if status == EXEC_FAILED and rollback(Path(config['root']) / 'receiver'):
        fail('the receiver installed for this deployment could not start, so the previous one was restored')
    sys.exit(status)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never echo the payload: it carries the registry token.
        print('Receiver bootstrap failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
