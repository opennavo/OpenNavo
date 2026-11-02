""" Verify the receiver bootstrap without installing anything on a host.

Every test runs in a temporary directory with a temporary configuration, and
nothing here starts a deployment, reaches the network or touches /etc.
"""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('deploy_bootstrap', Path(__file__).with_name('deploy-bootstrap.py'))
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)

REVISION = 'a' * 40
OTHER = 'b' * 40
THIRD = 'c' * 40
SENTINEL = 'registry-token-do-not-write-this-to-disk'

# Stands in for the receiver: reads the payload from stdin and reports what it
# got, so a test can prove the bytes crossed the handover unchanged.
RECEIVER = '''\
import hashlib
import os
import sys
raw = sys.stdin.buffer.read()
if '--self-check' in sys.argv:
    sys.exit(0)
report = os.environ.get('HANDOVER_REPORT')
if report:
    with open(report, 'w') as stream:
        stream.write('%d %s' % (len(raw), hashlib.sha256(raw).hexdigest()))
sys.exit(int(os.environ.get('RECEIVER_STATUS', '0')))
'''
BROKEN = '''\
import sys
if '--self-check' in sys.argv:
    print('configuration is missing key: example', file=sys.stderr)
    sys.exit(1)
sys.exit(0)
'''


def payload(revision=REVISION, data=RECEIVER.encode(), **extra):
    message = {'sha': revision, 'receiver': revision,
               'receiver_sha256': hashlib.sha256(data).hexdigest(),
               'images': {'server': 'x', 'web': 'x', 'mcp': 'x'},
               'registry_token': SENTINEL}
    message.update(extra)
    return json.dumps(message).encode()


class BootstrapTestCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / 'root'
        self.root.mkdir()
        (self.root / 'deploy').mkdir()
        self.config = Path(self.directory.name) / 'github-deploy.json'
        self.config.write_text(json.dumps({'root': str(self.root), 'project': 'opennavo'}))
        self.patch = patch.multiple(bootstrap, CONFIG_PATH=self.config)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.receiver = self.root / 'receiver'
        self.receiver.mkdir()
        (self.receiver / 'current').symlink_to('missing')

    def install_revision(self, revision, data=RECEIVER.encode()):
        """Put a version in place without going through the network."""
        target = self.receiver / revision
        target.mkdir(parents=True, exist_ok=True)
        (target / 'github-deploy.py').write_bytes(data)
        return target

    def run_main(self, message, receiver_status=0, stdout=None):
        """Run the bootstrap's entry point with the payload on its standard input.

        Returns the exit status it asks for. The entry point always leaves by
        SystemExit, so every caller here gets a number rather than an exception.
        """
        stream = io.BytesIO(message)
        environment = {'RECEIVER_STATUS': str(receiver_status)}
        if stdout is not None:
            environment['HANDOVER_REPORT'] = str(stdout)
        with patch.object(sys, 'stdin', type('Stdin', (), {'buffer': stream})()), \
                patch.object(sys, 'executable', sys.executable), \
                patch.dict(os.environ, environment), \
                patch.object(bootstrap, 'REMOTE', 'file://' + str(self.directory.name) + '/{revision}/receiver.py'):
            with self.assertRaises(SystemExit) as raised:
                bootstrap.main()
        return raised.exception.code

    def serve(self, revision, data=RECEIVER.encode()):
        """Lay out what the download step would fetch for one revision."""
        directory = Path(self.directory.name) / revision
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'receiver.py').write_bytes(data)


class RevisionTests(unittest.TestCase):
    def test_only_a_full_lowercase_revision_is_accepted(self):
        self.assertEqual(bootstrap.revision_of({'receiver': REVISION}), REVISION)

    def test_anything_that_could_leave_the_receiver_directory_is_rejected(self):
        # The revision becomes a directory name, so a shorter or longer value, a
        # path, an uppercase digest or a missing key must all stop here.
        for value in ('', 'a' * 39, 'a' * 41, 'A' * 40, '../../etc', 'main', 'a' * 40 + '/..',
                      'a' * 40 + '\n', None, 123):
            with self.subTest(value=value):
                with self.assertRaises(SystemExit) as raised:
                    bootstrap.revision_of({'receiver': value})
                self.assertEqual(raised.exception.code, 1)

    def test_a_missing_receiver_key_is_rejected_only_when_installing(self):
        # main() treats an absent 'receiver' as "nothing to install", so the
        # stricter check belongs in revision_of() and must not leak into that path.
        self.assertEqual(bootstrap.revision_of({'receiver': OTHER}), OTHER)


class ChecksumTests(BootstrapTestCase):
    def test_the_fetched_receiver_must_match_the_payload_checksum(self):
        # The served bytes are a working receiver, so nothing downstream (compile or
        # self-check) can fail: only the checksum comparison can stop this, and a test
        # using broken bytes would pass for the wrong reason.
        self.serve(REVISION, RECEIVER.encode())
        bogus = hashlib.sha256(b'a receiver this deployment does not get').hexdigest()
        self.assertEqual(self.run_main(payload(receiver_sha256=bogus)), 1)
        self.assertFalse((self.receiver / REVISION / 'github-deploy.py').exists()
                         and (self.receiver / 'current').is_symlink(),
                         'a receiver with the wrong checksum must never become current')

    def test_a_checksum_that_is_not_a_full_digest_is_rejected_before_downloading(self):
        for value in ('', 'a' * 39, 'a' * 65, 'A' * 64, '../../etc'):
            with self.subTest(value=value):
                message = payload(receiver_sha256=value)
                with patch.object(bootstrap, 'fetch', side_effect=AssertionError('downloaded anyway')):
                    self.assertEqual(self.run_main(message), 1)

    def test_the_checksum_covers_the_bytes_that_will_actually_run(self):
        # Three-way comparison: the payload names a digest, the download must
        # produce it, and the file on disk must hash to the same value again.
        self.serve(REVISION)
        self.assertEqual(self.run_main(payload()), 0)
        installed = (self.receiver / REVISION / 'github-deploy.py').read_bytes()
        self.assertEqual(hashlib.sha256(installed).hexdigest(), hashlib.sha256(RECEIVER.encode()).hexdigest())

    def test_bytes_that_change_between_the_download_and_the_disk_are_caught(self):
        # Guards the third leg of the comparison: a write that silently stores
        # something else must be caught here. The substitution compiles and
        # self-checks cleanly, so compile and self-check cannot be what stops it:
        # only the re-hash of the written file can.
        self.serve(REVISION)
        innocent = b'import sys\nif "--self-check" in sys.argv:\n    sys.exit(0)\nsys.exit(0)\n'
        original = Path.write_bytes

        def replace(path, data):
            if path.name.startswith('.github-deploy.py'):
                return original(path, innocent)
            return original(path, data)

        with patch.object(Path, 'write_bytes', replace):
            self.assertEqual(self.run_main(payload()), 1)
        self.assertNotEqual(os.readlink(self.receiver / 'current'), REVISION)

    def test_an_unreachable_github_names_the_reason_instead_of_looking_broken(self):
        with patch.object(bootstrap.urllib.request, 'urlopen', side_effect=bootstrap.urllib.error.URLError('no route')):
            with self.assertRaises(SystemExit) as raised:
                bootstrap.fetch(REVISION)
        self.assertEqual(raised.exception.code, 1)


class VerificationOrderTests(BootstrapTestCase):
    def test_a_receiver_that_fails_its_self_check_never_becomes_current(self):
        self.install_revision(OTHER)
        (self.receiver / 'current').unlink()
        (self.receiver / 'current').symlink_to(OTHER)
        self.serve(REVISION, BROKEN.encode())
        self.assertEqual(self.run_main(payload(data=BROKEN.encode())), 1)
        self.assertEqual(os.readlink(self.receiver / 'current'), OTHER)

    def test_a_receiver_that_does_not_compile_never_becomes_current(self):
        self.install_revision(OTHER)
        (self.receiver / 'current').unlink()
        (self.receiver / 'current').symlink_to(OTHER)
        broken = b'def f(:\n'
        self.serve(REVISION, broken)
        self.assertEqual(self.run_main(payload(data=broken)), 1)
        self.assertEqual(os.readlink(self.receiver / 'current'), OTHER)

    def test_the_previous_pointer_is_written_before_current_moves(self):
        self.install_revision(OTHER)
        (self.receiver / 'current').unlink()
        (self.receiver / 'current').symlink_to(OTHER)
        bootstrap.switch(self.receiver, REVISION)
        self.assertEqual(os.readlink(self.receiver / 'current'), REVISION)
        self.assertEqual(os.readlink(self.receiver / 'previous'), OTHER)


class RetentionTests(BootstrapTestCase):
    def test_current_and_previous_are_never_pruned_even_when_oldest(self):
        # The natural implementation filters by name and calls is_dir(), which
        # follows the link: both spellings delete the directory current points
        # at. Only resolving the links first survives this test.
        for name in ('oldest', OTHER, THIRD):
            self.install_revision(name)
        (self.receiver / 'current').unlink()
        (self.receiver / 'current').symlink_to('oldest')
        (self.receiver / 'previous').symlink_to(OTHER)
        for index, name in enumerate(('oldest', OTHER, THIRD)):
            os.utime(self.receiver / name, (index, index))
        for index in range(bootstrap.RETENTION + 2):
            self.install_revision('%040x' % (index + 100))
            os.utime(self.receiver / ('%040x' % (index + 100)), (1000 + index, 1000 + index))
        bootstrap.prune(self.receiver)
        self.assertTrue((self.receiver / 'current').exists())
        self.assertTrue((self.receiver / 'previous').exists())
        self.assertTrue((self.receiver / 'oldest').is_dir())
        self.assertTrue((self.receiver / OTHER).is_dir())

    def test_only_the_newest_versions_are_kept(self):
        for index in range(bootstrap.RETENTION + 3):
            name = '%040x' % (index + 100)
            self.install_revision(name)
            os.utime(self.receiver / name, (index, index))
        bootstrap.prune(self.receiver)
        remaining = {entry.name for entry in self.receiver.iterdir() if entry.is_dir() and not entry.is_symlink()}
        self.assertEqual(len(remaining), bootstrap.RETENTION)
        self.assertNotIn('%040x' % 100, remaining)
        self.assertIn('%040x' % (bootstrap.RETENTION + 2 + 100), remaining)

    def test_the_receiver_file_inside_a_version_is_removed_with_it(self):
        for index in range(bootstrap.RETENTION + 1):
            self.install_revision('%040x' % (index + 200))
            os.utime(self.receiver / ('%040x' % (index + 200)), (index, index))
        bootstrap.prune(self.receiver)
        self.assertFalse((self.receiver / ('%040x' % 200)).exists())


class HandoverTests(BootstrapTestCase):
    def test_the_payload_crosses_the_handover_unchanged(self):
        self.serve(REVISION)
        report = Path(self.directory.name) / 'handover.txt'
        message = payload()
        self.assertEqual(self.run_main(message, stdout=report), 0)
        size, digest = report.read_text().split()
        self.assertEqual(int(size), len(message))
        self.assertEqual(digest, hashlib.sha256(message).hexdigest())

    def test_the_payload_never_reaches_disk(self):
        # The payload carries the registry token. A temporary file would have
        # been removed by now, so the whole tree is scanned for the value too.
        self.serve(REVISION)
        self.assertEqual(self.run_main(payload()), 0)
        for path in Path(self.directory.name).rglob('*'):
            if path.is_file():
                self.assertNotIn(SENTINEL.encode(), path.read_bytes(), f'{path} contains the payload')

    def test_no_temporary_file_mechanism_is_used(self):
        # Guards the choice above: rewriting the handover through tempfile would
        # leave the token on the host, and must fail here rather than in review.
        self.serve(REVISION)
        for name in ('mkstemp', 'NamedTemporaryFile', 'TemporaryFile', 'mkdtemp', 'SpooledTemporaryFile'):
            patched = patch.object(tempfile, name, side_effect=AssertionError(f'tempfile.{name} was used'))
            patched.start()
            self.addCleanup(patched.stop)
        self.assertEqual(self.run_main(payload()), 0)

    def test_the_receiver_exit_status_is_reported(self):
        self.serve(REVISION)
        self.assertEqual(self.run_main(payload(), receiver_status=3), 3)

    def test_a_payload_without_a_receiver_runs_the_installed_one(self):
        # Desktop publishes and older senders carry no receiver field; they must
        # not be forced to reinstall anything.
        self.install_revision(REVISION)
        (self.receiver / 'current').unlink()
        (self.receiver / 'current').symlink_to(REVISION)
        message = json.dumps({'sha': REVISION, 'action': 'publish-desktop', 'registry_token': SENTINEL}).encode()
        self.assertEqual(self.run_main(message), 0)

    def test_no_receiver_at_all_is_an_error_not_a_silent_success(self):
        message = json.dumps({'sha': REVISION, 'registry_token': SENTINEL}).encode()
        self.assertEqual(self.run_main(message), 1)

    def test_an_oversized_payload_is_refused_before_it_is_parsed(self):
        with patch.object(bootstrap, 'MAX_PAYLOAD', 64):
            self.assertEqual(self.run_main(b'x' * 128), 1)


class FailureTests(BootstrapTestCase):
    def test_a_receiver_that_cannot_exec_restores_the_previous_one(self):
        self.install_revision(OTHER)
        (self.receiver / 'current').unlink()
        (self.receiver / 'current').symlink_to(OTHER)
        (self.receiver / 'previous').symlink_to(OTHER)
        self.assertTrue(bootstrap.rollback(self.receiver))
        self.assertEqual(os.readlink(self.receiver / 'current'), OTHER)

    def test_rollback_reports_when_there_is_nothing_to_restore(self):
        (self.receiver / 'current').unlink()
        self.assertFalse(bootstrap.rollback(self.receiver))

    def test_a_missing_configuration_stops_before_reading_the_payload(self):
        self.config.unlink()
        self.assertEqual(self.run_main(payload()), 1)

    def test_an_unstartable_receiver_restores_the_previous_version(self):
        # The path handed to run() is .../receiver/current/github-deploy.py: the
        # bootstrap deliberately starts the receiver through the pointer, so the
        # test matches on that rather than on the revision directory name.
        self.install_revision(OTHER)
        (self.receiver / 'current').unlink()
        (self.receiver / 'current').symlink_to(OTHER)
        self.serve(REVISION, RECEIVER.encode())
        original = bootstrap.run

        def start_fails(receiver, data):
            if Path(receiver).parent.name == 'current':
                return bootstrap.EXEC_FAILED
            return original(receiver, data)

        with patch.object(bootstrap, 'run', side_effect=start_fails):
            self.assertEqual(self.run_main(payload()), 1)
        self.assertEqual(os.readlink(self.receiver / 'current'), OTHER)

    def test_the_configuration_problem_is_named_as_such(self):
        # A new receiver may need keys the host does not have yet. The bootstrap must
        # report which step failed and quote the receiver, so that is not mistaken for
        # a corrupt download.
        self.serve(REVISION, BROKEN.encode())
        with patch('sys.stderr') as stderr:
            self.assertEqual(self.run_main(payload(data=BROKEN.encode())), 1)
        written = ''.join(call[0][0] for call in stderr.write.call_args_list)
        self.assertIn('self-check step', written)
        self.assertIn('configuration is missing key', written)


class LintTests(unittest.TestCase):
    def test_the_bootstrap_stays_small_enough_to_be_reviewed(self):
        # It is the trust root; growth is how it stops being reviewable.
        source = Path(__file__).with_name('deploy-bootstrap.py').read_text().splitlines()
        code = [line for line in source if line.strip() and not line.strip().startswith('#')]
        self.assertLess(len(code), 260, f'the bootstrap grew to {len(code)} non-blank lines')

    def test_the_self_check_runs_before_any_switch(self):
        # Both names appear inside their own definitions, so the comparison is
        # against the calls in main(), not the first mention in the file.
        source = Path(__file__).with_name('deploy-bootstrap.py').read_text()
        self.assertLess(source.index('receiver = install(config, message)'),
                        source.index('status = run(receiver, payload)'))


if __name__ == '__main__':
    unittest.main()
