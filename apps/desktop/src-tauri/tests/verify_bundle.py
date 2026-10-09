#!/usr/bin/python3 -I
"""Verify native packaging using built frontend artifacts and temporary development update keys only."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--frontend-dist', type=Path, required=True)
parser.add_argument('--version', default='0.0.2')
args = parser.parse_args()
source = args.frontend_dist.resolve()
if not (source / 'index.html').is_file():
    raise SystemExit('frontend distribution missing index.html')
root = Path(__file__).resolve().parents[1]
repo = root.parents[2]
key = root / 'target/dev_updater/development.key'
if subprocess.run(['git', 'check-ignore', '-q', str(key)], cwd=repo,
                  capture_output=True).returncode or not key.is_file():
    raise SystemExit('ignored development key required; generate public fixtures first')
key.chmod(0o600)
work = root / 'target/dev_updater/bundle_verify'
work.mkdir(parents=True, exist_ok=True)
frontend = work / 'frontend'
shutil.copytree(source, frontend, dirs_exist_ok=True)
overlay = work / 'tauri.verify.json'
overlay.write_text(json.dumps({
    'version': args.version,
    'build': {'beforeBuildCommand': None, 'frontendDist': str(frontend)},
    'plugins': {'updater': {'pubkey': Path(str(key) + '.pub').read_text().strip()}},
}))
environment = os.environ.copy()
for name in ('APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY',
             'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_PATH',
             'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH',
             'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'):
    environment.pop(name, None)
environment['CI'] = 'true'
environment['TAURI_SIGNING_PRIVATE_KEY'] = key.read_text()
environment['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'] = ''
redactions = [part for part in key.read_text().splitlines() if len(part) > 20]
command = ['pnpm', '--filter', '@opennavo/desktop', 'exec', 'tauri', 'build',
           '--ci', '--no-sign', '--bundles', 'app,dmg', '--config', str(overlay)]
bundle = root / 'target/release/bundle'
if bundle.is_dir():
    # Clean only this script's bundle output directory to exclude stale artifacts from acceptance checks.
    shutil.rmtree(bundle)
with subprocess.Popen(command, cwd=repo, env=environment, stdout=subprocess.PIPE,
                      stderr=subprocess.STDOUT, text=True) as process:
    # Consume raw output only in memory, never logs; report only fixed nonsensitive stages or crate names.
    for line in process.stdout:
        stripped = line.strip()
        if stripped.startswith(('Compiling ', 'Finished ', 'Bundling ')):
            print(stripped, flush=True)
        elif 'error' in stripped.lower():
            if stripped.startswith(('error:', 'error[')) and not any(word in stripped.lower() for word in ('key', 'password', 'signature')):
                for part in redactions:
                    stripped = stripped.replace(part, '[redacted]')
                print(stripped[:500], flush=True)
            else:
                print('Native bundle verification reported an error; raw output suppressed.', flush=True)
    code = process.wait()
if code:
    raise SystemExit(f'native bundle verification failed with exit {code}')
# Notices must be present in the shipped App, not only in the source resource directory.
notice_source = root / 'resources/third-party'
if not (notice_source / 'inventory.json').is_file():
    raise SystemExit('source third-party notice inventory missing')
apps = list((bundle / 'macos').glob('*.app'))
if not apps:
    raise SystemExit('native App artifact missing')
for app in apps:
    notice_target = app / 'Contents/Resources/resources/third-party'
    for source_file in notice_source.rglob('*'):
        if not source_file.is_file():
            continue
        packaged_file = notice_target / source_file.relative_to(notice_source)
        if not packaged_file.is_file() or hashlib.sha256(packaged_file.read_bytes()).digest() != hashlib.sha256(source_file.read_bytes()).digest():
            raise SystemExit(f'packaged third-party notice missing or changed: {source_file.relative_to(notice_source)}')
print('Packaged third-party notices match the source bundle.', flush=True)
# --no-sign also skips updater signing; sign only the updater archive separately to avoid Apple signing/notarization.
version = args.version
archives = list((bundle / 'macos').glob('*.app.tar.gz'))
if not archives:
    raise SystemExit('native updater archive missing')
for archive in archives:
    signing_environment = environment.copy()
    for name in ('TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH',
                 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'):
        signing_environment.pop(name, None)
    result = subprocess.run([
        'pnpm', '--filter', '@opennavo/desktop', 'exec', 'tauri', 'signer', 'sign',
        '--private-key-path', str(key), '--password', '', '--app-version', version,
        str(archive),
    ], cwd=repo, env=signing_environment, capture_output=True)
    if result.returncode:
        raise SystemExit('development updater signing failed; output suppressed')
    result = subprocess.run([
        'cargo', 'run', '--quiet', '--manifest-path', str(root / 'Cargo.toml'),
        '--example', 'updater_verify', '--', '--install-archive', str(archive),
        version, str(key) + '.pub',
    ], cwd=repo, env=signing_environment, capture_output=True)
    if result.returncode:
        raise SystemExit('native updater plugin verification failed; output suppressed')
    print('Native updater verified and installed only into a temporary App; no App launched.', flush=True)
report = [{'file': str(path.relative_to(bundle)), 'bytes': path.stat().st_size}
          for path in bundle.rglob('*') if path.is_file()
          and (path.suffix in ('.dmg', '.gz', '.sig') or path.name == 'opennavo-desktop')]
if not any(item['file'].endswith('.dmg') for item in report):
    raise SystemExit('native disk image artifact missing')
if not any(item['file'].endswith('.tar.gz.sig') for item in report):
    raise SystemExit('signed development updater artifact missing')
(work / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
print('Unsigned App/DMG and development-signed updater artifacts verified.', flush=True)
