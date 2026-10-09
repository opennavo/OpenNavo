#!/usr/bin/env python3
""" Verify API data for web and desktop browsing using the dedicated E2E stack; stop the owned API on exit."""
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import socket
import urllib.parse
import urllib.request

SPEC = importlib.util.spec_from_file_location('e2e', Path(__file__).with_name('e2e.py'))
e2e = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(e2e)
CALLS = []


def task(name):
    e2e.command(['node', 'tooling/scripts/tasks/server.mjs', 'e2e-' + name], capture=False)


def api(path, *, locale='zh-CN', body=None, token=None, **params):
    if path.startswith('/api/v1/'):
        params['locale'] = locale
    query = '?' + urllib.parse.urlencode(params) if params else ''
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(e2e.API_BASE + path + query,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers=headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        result = json.load(response)
        assert result['code'] == '0000', path
        assert result['msg'] == 'ok', path
        CALLS.append({'method': request.get_method(), 'path': path + query, 'status': response.status})
        return result['data']


def download(url):
    # Read only the dedicated object bucket to prevent fixture data from triggering external requests.
    assert url.startswith(e2e.frontend_environment(False)['NUXT_PUBLIC_CDN_BASE'] + '/')
    with urllib.request.urlopen(url, timeout=15) as response:
        assert response.status == 200
        return response.read()


def nodes(tree):
    return [node for root in tree for node in [root, *nodes(root['children'])]]


def summary(package):
    for field in ('kind', 'token', 'name', 'displayName', 'version', 'installs30d',
                  'autoUpdates', 'deprecated', 'disabled', 'versionChangedAt'):
        assert field in package, field
    assert package['displayName'] and package['summary']
    if package.get('iconUrl'):
        assert package['iconUrl'].startswith('http://127.0.0.1:9000/opennavo-e2e/')


def verify_locale(locale):
    home = api('/api/v1/home', locale=locale)
    assert home['stats']['casks'] == 40 and home['stats']['formulae'] == 20
    assert home['features'][0]['target']['token'] == 'ghostty'
    for name in ('popularApps', 'popularCli', 'recentlyUpdated'):
        assert len(home[name]) >= 8
        for item in home[name]:
            summary(item)
    tree = api('/api/v1/categories', locale=locale)
    categories = nodes(tree)
    assert len(categories) == 22
    by_slug = {item['slug']: item for item in categories}
    assert by_slug['developer-tools']['packageCount'] > 0
    assert by_slug['fonts']['hiddenByDefault'] and by_slug['libraries']['hiddenByDefault']
    for kind, total in (('cask', 37), ('formula', 17)):
        first = api('/api/v1/packages', locale=locale, kind=kind, size=24)
        assert first['total'] == total
        assert first['current'] == 1 and first['size'] == 24
        if total > 24:
            second = api('/api/v1/packages', locale=locale, kind=kind, size=24, current=2)
            assert len(first['records']) + len(second['records']) == total
        for sort in ('popular', 'updated', 'name'):
            page = api('/api/v1/packages', locale=locale, kind=kind, sort=sort, size=3)
            assert len(page['records']) == 3
    for category, total in (('developer-tools', None), ('fonts', 3), ('libraries', 3)):
        page = api('/api/v1/packages', locale=locale, category=category,
                   includeFonts='true', includeLibraries='true', size=100)
        assert page['total'] > 0
        if total:
            assert page['total'] == total
    for kind, total in (('cask', 37), ('formula', 20)):
        for period in ('30d', '90d', '365d'):
            page = api('/api/v1/rankings', locale=locale, kind=kind, period=period, size=100)
            assert page['total'] == total
            assert [item['rank'] for item in page['records']] == list(range(1, total + 1))
            amounts = [item['installs'] for item in page['records']]
            assert amounts == sorted(amounts, reverse=True)
    for query, expected in (('vscode', 'visual-studio-code'), ('微信', 'wechat'), ('rg', 'ripgrep')):
        result = api('/api/v1/search', locale=locale, q=query)
        assert result['records'][0]['package']['token'] == expected
        assert result['expandedTerms']
        suggestions = api('/api/v1/search/suggest', locale=locale, q=query)
        assert any(item.get('token') == expected for item in suggestions)
    empty = api('/api/v1/search', locale=locale, q='e2ezzzznomatchingpackage')
    assert not empty['records'] and empty['total'] == 0
    for kind, name in (('cask', 'visual-studio-code'), ('formula', 'ripgrep')):
        root = '/api/v1/packages/' + kind + '/' + name
        detail = api(root, locale=locale)
        summary(detail)
        assert detail['installCommand'] == 'brew install --' + kind + ' ' + name
        assert detail['supports']['arm64'] and detail['supports']['x86_64']
        assert detail['sourceUrl'].startswith('https://github.com/homebrew/')
        assert detail['formulaeUrl'] == 'https://formulae.brew.sh/' + kind + '/' + name
        assert detail['artifacts']['binaries'] and detail['minMacos'] == '13.0'
        assert all(detail['installs'][period] > 0 for period in ('d30', 'd90', 'd365'))
        payload = download(detail['downloadUrl'])
        assert len(payload) == detail['downloadSize']
        assert hashlib.sha256(payload).hexdigest() == detail['downloadSha256']
        related = api(root + '/related', locale=locale)
        assert related and all(item['token'] != name for item in related)
        deps = api(root + '/dependencies', locale=locale, depth=2)
        assert deps['dependencies']
        if kind == 'cask':
            assert detail['caveats'] and detail['developer'] and detail['license']
            assert detail['dependsOn']['macos'] == '>= 13.0'
            assert len(detail['screenshots']) == 2 and detail['releaseCount'] == 8
            assert detail['releaseStats']['cadence']
            assert detail['latestRelease']['summary'] and detail['latestRelease']['sections']
            assert detail['artifacts']['uninstallNotes']
            assert deps['conflictsWith']['casks']
            for shot in detail['screenshots']:
                for field in ('url', 'thumbUrl'):
                    assert download(shot[field]).startswith(bytes.fromhex('89504e470d0a1a0a'))
            assert download(detail['iconUrl']).startswith(bytes.fromhex('89504e470d0a1a0a'))
        else:
            assert detail['onRequest']['d30'] > 0
    for token, total in (('visual-studio-code', 8), ('ghostty', 3)):
        page = api('/api/v1/packages/cask/' + token + '/releases', locale=locale, size=2)
        assert page['total'] == total
        records = []
        for current in range(1, (total + 1) // 2 + 1):
            records.extend(api('/api/v1/packages/cask/' + token + '/releases',
                               locale=locale, size=2, current=current)['records'])
        assert len(records) == total and sum(bool(item['isLatest']) for item in records) == 1
        statuses = {item['translation']['status'] for item in records}
        if locale == 'zh-CN':
            assert {'machine', 'reviewed'} <= statuses
        else:
            assert statuses == {'reviewed'}
        for release in records:
            assert release['hasNotes'] and release['bodyMarkdown'] and release['summary']
            assert len(release['sections']) == 2 and release['sourceUrl'].startswith('https://')
    dependencies = api('/api/v1/packages/formula/node/dependencies', locale=locale, depth=2)
    assert dependencies['dependencies'][0]['children'][0]['token'] == 'zlib'
    dependents = api('/api/v1/packages/formula/zlib/dependencies', locale=locale, depth=2)
    assert dependents['dependents']['count'] == 2 and len(dependents['dependents']['top']) == 2
    assert api('/api/v1/packages/formula/openssl@3', locale=locale)['kegOnly']
    collections = api('/api/v1/collections', locale=locale)
    assert collections['records'][0]['slug'] == 'new-mac'
    collection = api('/api/v1/collections/new-mac', locale=locale)
    assert collection['itemCount'] == 15 and len(collection['items']) == 15
    assert download(collection['coverUrl']).startswith(bytes.fromhex('89504e470d0a1a0a'))
    latest = api('/api/v1/desktop/releases/latest', locale=locale, channel='stable')
    assert latest['version'] == '0.3.0' and latest['minMacos'] == '13.0'
    assert len(latest['recentReleases']) == 5 and latest['recentReleases'][0]['version'] == latest['version']
    for release in latest['recentReleases']:
        assert release['notes'] and release['pubDate'].endswith('Z')
    artifact = latest['downloads'][0]
    assert artifact['target'] == 'dmg-universal'
    content = download(artifact['url'])
    assert len(content) == artifact['bytes'] and hashlib.sha256(content).hexdigest() == artifact['sha256']
    lookup = api('/api/v1/packages/lookup', locale=locale, body={'items': [
        {'kind': 'cask', 'token': 'visual-studio-code'}, {'kind': 'cask', 'token': 'ghostty'},
        {'kind': 'formula', 'token': 'node'}, {'kind': 'formula', 'token': 'missing-e2e-package'}]})
    for item in lookup[:2]:
        assert item['found'] and item['latestRelease']['summary']
        assert item['versionBase'] and item['autoUpdates']
    assert lookup[2]['found'] and not lookup[2]['autoUpdates'] and not lookup[3]['found']
    config = api('/api/v1/config/client', locale=locale, platform='desktop', version='0.1.0')
    assert config['latestVersion'] == latest['version'] and config['mirrors']
    assert config['links']['privacy'].endswith('/about') and config['links']['download'].endswith('/download')


def verify_sync_and_sitemap():
    metadata = api('/api/v1/catalog/snapshot')
    raw = download(metadata['url'])
    assert metadata['bytes'] == len(raw) and metadata['sha256'] == hashlib.sha256(raw).hexdigest()
    document = json.loads(gzip.decompress(raw))
    assert len(document['items']) == 60 and len(document['categories']) == 22
    for item in document['items']:
        assert item['downloadSize'] > 0 and item['installs90d'] > 0 and item['installs365d'] > 0
        if item['kind'] == 'formula':
            assert item['onRequest']['d30'] > 0
    delta = api('/api/v1/catalog/changes', since=metadata['cursor'])
    assert not delta['changes'] and not delta['hasMore'] and delta['nextCursor'] == metadata['cursor']
    records = []
    for current in range(1, 4):
        page = api('/api/v1/sitemap/packages', current=current, size=23)
        assert page['total'] == 60
        records.extend(page['records'])
    assert len({(item['kind'], item['token']) for item in records}) == 60
    with urllib.request.urlopen(e2e.API_BASE + '/api/v1/collections/new-mac/brewfile', timeout=10) as response:
        lines = response.read().decode().splitlines()
        entries = [line for line in lines if re.match(r'^(brew|cask) "', line)]
        assert len(entries) == 15 and 'cask "visual-studio-code"' in entries and 'brew "ripgrep"' in entries
        CALLS.append({'method': 'GET', 'path': '/api/v1/collections/new-mac/brewfile', 'status': response.status})


def verify_roles_and_feedback():
    for name, role in (('super', 'R_SUPER'), ('admin', 'R_ADMIN'), ('editor', 'R_EDITOR'),
                       ('reviewer', 'R_REVIEWER'), ('ops', 'R_OPS')):
        login = api('/admin-api/auth/login', body={'userName': 'e2e-' + name,
                    'password': e2e.environment(False)['E2E_ADMIN_PASSWORD']})
        info = api('/admin-api/auth/getUserInfo', token=login['token'])
        assert info['roles'] == [role]
        if name == 'reviewer':
            queue = api('/admin-api/translations/queue', token=login['token'], type='release')
            assert {row['version'] for row in queue['records'] if row['token'] == 'visual-studio-code'} == {
                '1.135.0', '1.134.0', '1.133.0'}
    feedback = api('/api/v1/feedback', body={'type': 'wrong_info', 'packageKind': 'cask',
                   'packageToken': 'visual-studio-code', 'content': '完整页面数据核对的本地 E2E 反馈样本。',
                   'contact': 'e2e@opennavo.example', 'platform': 'web', 'website': ''})
    assert feedback['id'] > 0


def main():
    before = int(e2e.compose(False, 'exec', '-T', 'postgres', 'psql', '-U', 'opennavo', '-d', 'opennavo',
                            '-Atc', 'SELECT count(*) FROM packages'))
    try:
        task('reset')
        task('up')
        for locale in ('zh-CN', 'en-US'):
            verify_locale(locale)
        verify_sync_and_sitemap()
        verify_roles_and_feedback()
        after = int(e2e.compose(False, 'exec', '-T', 'postgres', 'psql', '-U', 'opennavo', '-d', 'opennavo',
                               '-Atc', 'SELECT count(*) FROM packages'))
        assert before == after
        report = {'locales': ['zh-CN', 'en-US'], 'calls': CALLS, 'apiCalls': len(CALLS),
                  'developmentPackagesBefore': before, 'developmentPackagesAfter': after,
                  'catalogPackages': 60, 'categories': 22, 'releaseEntries': 9, 'collectionItems': 15,
                  'desktopHistory': 5, 'roles': 5, 'sitemapShards': 3}
        (e2e.STATE / 'page-audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({key: value for key, value in report.items() if key != 'calls'}, ensure_ascii=False))
    finally:
        task('down')
        for port in (18082, 19090):
            with socket.socket() as sock:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind(('127.0.0.1', port))


if __name__ == '__main__':
    main()
