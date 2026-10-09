"""Send build artifacts to a forced-command SSH deployment receiver."""
import base64
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def main():
    os.umask(0o077)
    host, user = os.environ['DEPLOY_HOST'], os.environ['DEPLOY_USER']
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*', host) or not re.fullmatch(r'[a-z_][a-z0-9_-]*', user):
        raise ValueError('invalid SSH destination')
    parser = argparse.ArgumentParser()
    parser.add_argument('--desktop-version')
    args = parser.parse_args()
    if args.desktop_version:
        payload = {'action': 'publish-desktop', 'version': args.desktop_version}
    else:
        images = {}
        for path in Path('deployment/images').glob('*.json'):
            images.update(json.loads(path.read_text()))
        archive = Path('deployment/admin-dist.tar.gz').read_bytes()
        payload = {'sha': os.environ['RELEASE_SHA'], 'run_id': os.environ['GITHUB_RUN_ID'], 'run_attempt': os.environ['GITHUB_RUN_ATTEMPT'],
                   'images': images, 'admin_sha256': hashlib.sha256(archive).hexdigest(),
                   'admin_archive': base64.b64encode(archive).decode(),
                   'registry_token': os.environ['REGISTRY_TOKEN'], 'registry_username': os.environ['REGISTRY_USERNAME']}
    with tempfile.TemporaryDirectory() as directory:
        key, known = Path(directory) / 'key', Path(directory) / 'known_hosts'
        key.write_text(os.environ['DEPLOY_SSH_KEY'] + '\n')
        known.write_text(os.environ['DEPLOY_KNOWN_HOSTS'] + '\n')
        subprocess.run(['ssh', '-i', str(key), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
                        '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(known),
                        '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30', user + '@' + host],
                       input=json.dumps(payload).encode(), check=True, timeout=1500)
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        if args.desktop_version:
            summary.write('Desktop update published: `' + args.desktop_version + '`\n')
            return
        summary.write('Production deployed and health-checked: `' + payload['sha'] + '`\n')
        for kind, image in sorted(images.items()):
            summary.write(f'- {kind}: `{image}`\n')


if __name__ == '__main__':
    main()
