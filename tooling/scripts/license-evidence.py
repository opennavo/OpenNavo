"""Supplement package inventories with upstream license texts omitted from archives.

Run after about-inventory.py. Uses exact package revision metadata where available;
records the URL and SHA-256 of every supplemental text. Reuses committed evidence.
"""
import importlib.util
import json
from pathlib import Path
import re
from concurrent.futures import ThreadPoolExecutor
import urllib.error

spec = importlib.util.spec_from_file_location('inventory', Path(__file__).with_name('about-inventory.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def github_repo(url):
    match = re.search(r'github.com[/:]([^/]+/[^/#]+)', url or '')
    return match[1].removesuffix('.git') if match else None


def main():
    path = c.OUT / 'inventory.json'
    data = json.loads(path.read_text())
    modules = data['modules']
    lookup = {(m['ecosystem'], m['name'], m['version']): m for m in modules}
    parents = {'@esbuild/': 'esbuild', '@oxc-parser/': 'oxc-parser', '@oxc-transform/': 'oxc-transform',
               '@oxfmt/': 'oxfmt', '@oxlint/': 'oxlint', '@rolldown/': 'rolldown', '@rollup/': 'rollup',
               '@resvg/resvg-js-': '@resvg/resvg-js', '@tauri-apps/cli-': '@tauri-apps/cli'}
    for item in modules:
        if item['license'] == 'NOASSERTION' and item['licenseFiles']:
            item['license'] = c.license_name('\n'.join((c.OUT / f['path']).read_text(errors='replace') for f in item['licenseFiles']))
        if item['ecosystem'] == 'npm' and not item['licenseFiles']:
            parent_name = next((v for prefix, v in parents.items() if item['name'].startswith(prefix)), None)
            parent = lookup.get(('npm', parent_name, item['version']))
            if parent and parent['licenseFiles']:
                item['licenseFiles'] = parent['licenseFiles']
                item['evidence']['licenseTextSource'] = f"Same-version distribution wrapper {parent_name}@{item['version']}"

    cargo = json.loads(c.run(['cargo', 'metadata', '--locked', '--format-version', '1', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml']))
    crates = {(p['name'], p['version']): p for p in cargo['packages']}

    def prepare(item):
        try:
            eco, name, version = item['ecosystem'], item['name'], item['version']
            if eco == 'npm':
                metadata = json.loads(c.fetch('https://registry.npmjs.org/' + c.urllib.parse.quote(name, safe='') + '/' + version))
                repository = metadata.get('repository') or {}
                if isinstance(repository, str):
                    repository = {'url': repository}
                repo = github_repo(repository.get('url'))
                revision = metadata.get('gitHead')
                refs = [revision] if revision else ['v' + version, version]
                subdir = repository.get('directory', '')
            elif eco == 'Rust':
                package = crates[name, version]
                repo = github_repo(package['repository'])
                directory = Path(package['manifest_path']).parent
                vcs = directory / '.cargo_vcs_info.json'
                info = json.loads(vcs.read_text()) if vcs.exists() else {}
                revision = info.get('git', {}).get('sha1')
                refs = [revision] if revision else ['v' + version, version]
                subdir = info.get('path_in_vcs', '')
            elif eco == 'Go':
                repo = '/'.join(name.split('/')[1:3])
                refs = [version.rsplit('-', 1)[-1]] if version.startswith('v0.0.0-') else [version]
                subdir = ''
            elif eco == 'Python':
                metadata = json.loads(c.fetch(f'https://pypi.org/pypi/{name}/{version}/json'))['info']
                urls = metadata.get('project_urls') or {}
                repo = next((github_repo(u) for u in urls.values() if github_repo(u)), None)
                refs, subdir = ['v' + version, version], ''
            else:
                return None
            if repo:
                return item, repo, refs, subdir
        except Exception as error:
            print(f'License metadata unavailable: {item["name"]}: {type(error).__name__}', flush=True)
        return None

    missing = [m for m in modules if not m['licenseFiles'] and m['scope'] != 'external']
    with ThreadPoolExecutor(max_workers=12) as pool:
        prepared = [p for p in pool.map(prepare, missing) if p]
    groups = {}
    for item, repo, refs, subdir in prepared:
        groups.setdefault((repo, tuple(refs)), []).append((item, subdir))

    def collect(group):
        (repo, refs), items = group
        candidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'LICENSE-MIT', 'LICENSE-APACHE', 'LICENCE', 'COPYING', 'COPYING.md', 'LICENCE.md', 'License.txt', 'LICENSE-MIT.txt', 'license.txt', 'README.md']
        # Root licenses cover monorepo members; try member directories if absent.
        directories = [''] + sorted({subdir for _, subdir in items if subdir})
        pinned_refs = list(refs)
        try:
            head = c.run(['git', 'ls-remote', 'https://github.com/' + repo + '.git', 'HEAD']).split()[0]
            if head not in pinned_refs:
                pinned_refs.append(head)
        except Exception:
            pass
        for ref in pinned_refs:
            for directory in directories:
                for filename in candidates:
                    url = f'https://raw.githubusercontent.com/{repo}/{ref}/' + (directory + '/' if directory else '') + filename
                    try:
                        raw = c.fetch(url)
                    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError):
                        continue
                    if filename.lower().startswith('readme') and c.license_name(raw.decode(errors='replace')) == 'NOASSERTION':
                        continue
                    if not raw.strip():
                        continue
                    files = c.save_texts([(url, raw)])
                    for item, _ in items:
                        item['licenseFiles'] = files
                        item['evidence']['licenseTextSource'] = url
                        if ref not in refs:
                            item['evidence']['licenseTextQualification'] = 'Pinned current upstream license; historical package archive omitted the full text and original revision lookup did not supply it'
                        if item['license'] == 'NOASSERTION':
                            item['license'] = c.license_name(raw.decode(errors='replace'))
                    print(f'Upstream license: {repo}@{ref}', flush=True)
                    return
        print(f'Upstream license still missing: {repo}', flush=True)

    with ThreadPoolExecutor(max_workers=12) as pool:
        list(pool.map(collect, groups.items()))
    # Some archives and upstream repositories publish only an SPDX declaration.
    # Preserve the declaration/attribution verbatim and label standard reference
    # text explicitly; do not fabricate an upstream copyright holder or license.
    remaining = [m for m in modules if not m['licenseFiles'] and m['scope'] != 'external']
    if remaining:
        spdx_ref = c.run(['git', 'ls-remote', 'https://github.com/spdx/license-list-data.git', 'HEAD']).split()[0]
        references = {}
        for item in remaining:
            texts = []
            if item['ecosystem'] == 'Rust':
                directory = Path(crates[item['name'], item['version']]['manifest_path']).parent
                for source in ['Cargo.toml.orig', 'Cargo.toml', 'README.md']:
                    candidate = directory / source
                    if candidate.exists():
                        texts.append((source, candidate.read_bytes()))
            else:
                url = 'https://registry.npmjs.org/' + c.urllib.parse.quote(item['name'], safe='') + '/' + item['version']
                raw = c.fetch(url)
                texts.append((url, raw))
                metadata = json.loads(raw)
                archive = c.fetch(metadata['dist']['tarball'])
                with c.tarfile.open(fileobj=c.io.BytesIO(archive), mode='r:gz') as tar:
                    for member in tar:
                        if member.isfile() and Path(member.name).name.lower() in ('readme.md', 'readme', 'package.json'):
                            texts.append((member.name, tar.extractfile(member).read()))
            for license_id in re.split(r'\s+(?:OR|AND)\s+|/', item['license'].strip('()')):
                if license_id not in references:
                    url = f'https://raw.githubusercontent.com/spdx/license-list-data/{spdx_ref}/text/{license_id}.txt'
                    references[license_id] = (url, c.fetch(url))
                texts.append(references[license_id])
            item['licenseFiles'] = c.save_texts(texts)
            item['evidence']['licenseTextQualification'] = 'Upstream publishes a license declaration but omits full text; original package metadata/README attribution and explicitly supplemental SPDX reference text are retained'
    c.write_json(path, data)
    print(json.dumps({'unknown': [m['name'] for m in modules if m['license'] == 'NOASSERTION'],
                      'missing': [m['ecosystem'] + ':' + m['name'] for m in modules if not m['licenseFiles'] and m['scope'] != 'external']}, indent=2))

if __name__ == '__main__':
    main()
