#!/usr/bin/python3 -I
"""只为本地测试生成签名夹具；私钥始终在被忽略的 target 中。"""
from pathlib import Path
import gzip
import io
import os
import plistlib
import subprocess
import tarfile

root = Path(__file__).resolve().parents[3]
repo = root.parents[2]
key = root / 'target/dev_updater/development.key'
if subprocess.run(['git', 'check-ignore', '-q', str(key)], cwd=repo,
                  capture_output=True).returncode:
    raise SystemExit('development private path must be ignored')
key.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
key.parent.chmod(0o700)


def cli(args):
    # Signing tools may print keys; never log success or failure output.
    environment = os.environ.copy()
    for name in ('TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH',
                 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'):
        environment.pop(name, None)
    result = subprocess.run(['pnpm', '--filter', '@opennavo/desktop', 'exec',
                             'tauri', 'signer', *args], cwd=repo,
                            env=environment, capture_output=True)
    if result.returncode:
        raise SystemExit('development signing command failed; output suppressed')


if not key.exists():
    cli(['generate', '--ci', '--password', '', '--write-keys', str(key)])
key.chmod(0o600)
files = {
    'OpenNavo_demo.app/Contents/Info.plist': plistlib.dumps({
        'CFBundleIdentifier': 'com.opennavo.desktop.dev_verify',
        'CFBundleShortVersionString': '0.0.2',
        'CFBundleVersion': '2',
        'CFBundleExecutable': 'opennavo_demo',
    }),
    'OpenNavo_demo.app/Contents/MacOS/opennavo_demo': b'OpenNavo test fixture 0.0.2\n',
}
raw = io.BytesIO()
with tarfile.open(fileobj=raw, mode='w', format=tarfile.USTAR_FORMAT) as archive:
    for path, data in files.items():
        entry = tarfile.TarInfo(path)
        entry.size = len(data)
        entry.mode = 0o755 if '/MacOS/' in path else 0o644
        archive.addfile(entry, io.BytesIO(data))
fixture = Path(__file__).parent / 'OpenNavo_demo.app.tar.gz'
fixture.write_bytes(gzip.compress(raw.getvalue(), mtime=0))
cli(['sign', '--private-key-path', str(key), '--password', '',
     '--app-version', '0.0.2', str(fixture)])
(Path(__file__).parent / 'development.pub').write_text(
    Path(str(key) + '.pub').read_text())
print('Public updater fixtures generated; no private material is printed or tracked.')
