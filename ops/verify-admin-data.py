#!/usr/bin/env python3
""" Verify admin fields and workflows against exclusive E2E data, without browsers, external requests, or LLM calls."""
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import urllib.parse
import urllib.request

SPEC = importlib.util.spec_from_file_location('e2e', Path(__file__).with_name('e2e.py'))
e2e = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(e2e)
CALLS = []
TOKENS = {}


def api(path, *, method='GET', role='super', body=None, code='0000', fields=(), **params):
    query = '?' + urllib.parse.urlencode(params) if params else ''
    headers = {'Content-Type': 'application/json'}
    if role and role in TOKENS:
        headers['Authorization'] = 'Bearer ' + TOKENS[role]
    request = urllib.request.Request(e2e.API_BASE + path + query, method=method,
                                    data=json.dumps(body).encode() if body is not None else None,
                                    headers=headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        result = json.load(response)
        assert response.status == 200, path
        assert result['code'] == code, (method, path, role, result['code'])
        if code == '0000':
            assert result['msg'] == 'ok', path
        data = result['data']
        if fields:
            assert isinstance(data, dict) and set(fields) <= data.keys(), (path, fields)
        CALLS.append({'method': method, 'path': path + query, 'role': role, 'code': code,
                      'fields': list(fields)})
        return data


def fields(row, *names):
    assert set(names) <= row.keys(), names
    return row


def stamp(offset):
    return (datetime.now(timezone.utc) + timedelta(hours=offset)).isoformat().replace('+00:00', 'Z')


def logins():
    password = e2e.environment(False)['E2E_ADMIN_PASSWORD']
    for role in ('super', 'admin', 'editor', 'reviewer', 'ops'):
        login = api('/admin-api/auth/login', role=None, method='POST',
                    body={'userName': 'e2e-' + role, 'password': password})
        TOKENS[role] = login['token']
        info = api('/admin-api/auth/getUserInfo', role=role, fields=('roles', 'buttons', 'userName'))
        assert info['roles'] == ['R_' + role.upper()]
    # Page routes use role checks; write buttons additionally require permission codes.
    pages = {
        '/collections': {'super', 'admin', 'editor'},
        '/features': {'super', 'admin', 'editor'},
        '/search/insights/top': {'super', 'admin', 'editor', 'ops'},
        '/search/synonyms': {'super', 'admin', 'editor', 'ops'},
        '/feedback': {'super', 'admin', 'editor', 'ops'},
        '/releases': {'super', 'admin', 'editor', 'reviewer', 'ops'},
        '/translations/queue?type=release': {'super', 'admin', 'editor', 'reviewer'},
        '/desktop-releases': {'super', 'admin', 'ops'},
        '/mirrors': {'super', 'admin', 'ops'},
        '/app-config': {'super', 'admin', 'ops'},
    }
    for path, allowed in pages.items():
        for role in TOKENS:
            api('/admin-api' + path, role=role, code='0000' if role in allowed else '1004')


def content():
    packages = api('/admin-api/packages', q='visual-studio-code')['records']
    vscode = next(p for p in packages if p['token'] == 'visual-studio-code')
    ghostty = api('/admin-api/packages', q='ghostty')['records'][0]
    published = api('/admin-api/collections')['records'][0]
    detail = api('/admin-api/collections/' + str(published['id']))
    fields(detail, 'coverUrl', 'publishAt', 'unpublishAt', 'updateBy', 'updateTime', 'i18n', 'items')
    assert len(detail['items']) == 15 and detail['coverUrl']
    fields(detail['items'][0], 'packageId', 'kind', 'token', 'name', 'iconUrl', 'disabled', 'sort', 'noteZh', 'noteEn')
    body = {'slug': 'e2e-audit-collection', 'sort': 2, 'coverAssetId': detail['coverAssetId'],
            'unpublishAt': stamp(24), 'i18n': {'zh-CN': {'title': '后台验收合集', 'subtitle': '预览副标题',
                                                       'body': '## 推荐工具\n支持 **Markdown** 正文。'},
                                             'en-US': {'title': 'Admin audit collection', 'body': 'Recommended tools.'}}}
    cid = api('/admin-api/collections', method='POST', role='editor', body=body)['id']
    root = '/admin-api/collections/' + str(cid)
    api(root + '/publish', method='POST', role='editor', body={}, code='1004')
    api(root + '/publish', method='POST', body={}, code='1006')
    items = [{'packageId': ghostty['id'], 'noteZh': '快速终端', 'noteEn': 'Fast terminal'},
             {'packageId': vscode['id'], 'noteZh': '编辑器', 'noteEn': 'Editor'}]
    api(root + '/items', method='PUT', role='editor', body={'items': items})
    rows = api(root)['items']
    assert [r['packageId'] for r in rows] == [r['packageId'] for r in items]
    api(root + '/items', method='PUT', role='editor', body={'items': list(reversed(items))})
    assert api(root)['items'][0]['packageId'] == vscode['id']
    body['i18n']['zh-CN']['title'] = '后台验收合集（已编辑）'
    api(root, method='PUT', role='editor', body=body)
    api(root + '/publish', method='POST', role='admin', body={'publishAt': stamp(1)})
    assert api(root)['status'] == 'scheduled'
    assert all(r['slug'] != body['slug'] for r in api('/api/v1/collections')['records'])
    api(root + '/publish', method='POST', role='admin', body={})
    assert api('/api/v1/collections/' + body['slug'])['itemCount'] == 2
    feature = {'placement': 'home_secondary', 'targetType': 'collection', 'collectionId': cid,
               'glowColor': '#4AA8FF', 'status': 'scheduled', 'sort': 1,
               'startsAt': stamp(1), 'endsAt': stamp(2),
               'i18n': {'zh-CN': {'badge': '精选', 'title': '验收精选', 'subtitle': '实时预览',
                                  'body': '支持 **加粗** 的正文。', 'ctaLabel': '查看合集'}}}
    fid = api('/admin-api/features', method='POST', role='editor', body=feature)['id']
    froot = '/admin-api/features/' + str(fid)
    preview = api(froot)
    fields(preview, 'placement', 'collectionTitle', 'glowColor', 'startsAt', 'endsAt', 'i18n')
    assert preview['collectionTitle'] == body['i18n']['zh-CN']['title']
    assert all(f['id'] != fid for f in api('/api/v1/home')['features'])
    feature.update(status='published', startsAt=stamp(-1))
    api(froot, method='PUT', role='editor', body=feature)
    assert any(f['id'] == fid for f in api('/api/v1/home')['features'])
    feature.update(startsAt=stamp(-2), endsAt=stamp(-1))
    api(froot, method='PUT', role='editor', body=feature)
    assert all(f['id'] != fid for f in api('/api/v1/home')['features'])
    api(froot, method='DELETE', role='editor')
    api(root + '/unpublish', method='POST', role='admin')
    api(root, method='DELETE', role='editor')
    return vscode['id']


def operations():
    for days in (7, 30, 90):
        for endpoint in ('top', 'zero'):
            data = api('/admin-api/search/insights/' + endpoint, role='ops', days=days)
            assert data['records'], (endpoint, days)
            for row in data['records']:
                fields(row, 'query', 'count', 'zeroResultCount', 'clickCount', 'topClicked')
    assert any(r['topClicked'] == 'visual-studio-code'
               for r in api('/admin-api/search/insights/top', role='ops', days=7)['records'])
    sid = api('/admin-api/search/synonyms', method='POST', role='editor',
              body={'terms': ['e2e-alias', 'ghostty'], 'enabled': True})['id']
    api('/admin-api/search/synonyms/' + str(sid), method='PUT', role='editor',
        body={'terms': ['e2e-alias', 'ghostty', 'e2e-terminal'], 'enabled': False})
    rows = api('/admin-api/search/synonyms', role='ops')['records']
    fields(next(r for r in rows if r['id'] == sid), 'terms', 'enabled', 'updateBy', 'updateTime')
    api('/admin-api/search/synonyms/' + str(sid), method='DELETE', role='editor')
    feedback = api('/admin-api/feedback', role='ops', status='open')['records'][0]
    root = '/admin-api/feedback/' + str(feedback['id'])
    fields(api(root, role='ops'), 'packageKind', 'packageToken', 'packageName', 'platform', 'appVersion',
           'errorCode', 'contact', 'status', 'createTime')
    for status in ('in_progress', 'resolved', 'rejected'):
        api(root, method='PUT', role='ops', body={'status': status, 'handlerNote': '后台固定数据验收'})
        row = api(root, role='ops')
        assert row['status'] == status and row['handledBy'] == 'e2e-ops' and row['handledAt']


def translations(pid):
    root = '/admin-api/packages/' + str(pid)
    versions = api(root + '/versions', role='reviewer')['records']
    assert len(versions) == 6 and all(r['brewCommitSha'] and r['releaseId'] for r in versions)
    fields(versions[0], 'version', 'firstSeenAt', 'brewCommittedAt', 'brewCommitSha', 'releaseId')
    sources = api(root + '/changelog-sources', role='ops')
    assert len(sources) == 3
    for row in sources:
        fields(row, 'type', 'config', 'priority', 'enabled', 'resolvedBy', 'lastStatus', 'lastError', 'nextFetchAt')
    manual = [{k: r[k] for k in ('type', 'config', 'priority', 'enabled')} for r in sources]
    manual[0]['priority'] = 5
    api(root + '/changelog-sources', method='PUT', role='ops', body={'manual': manual, 'autoEnabled': {}})
    # Verify enqueueing only; do not start workers or fetch external pages.
    for action in ('resolve', 'fetch'):
        api(root + '/changelog/' + action, method='POST', role='ops')
    queue = api('/admin-api/translations/queue', role='reviewer', type='release')['records']
    sample = next(row for row in queue if row['token'] == 'visual-studio-code')
    fields(sample, 'original', 'translated', 'rank30d', 'version', 'status')
    rid = sample['id']
    rr = '/admin-api/releases/' + str(rid)
    release = api(rr, role='reviewer')
    fields(release, 'sourceUrl', 'bodyMarkdown', 'i18n')
    assert len(release['i18n']) == 2 and not any(i['stale'] for i in release['i18n'])
    api('/admin-api/translations/approve', method='POST', role='reviewer', body={'type': 'release', 'ids': [rid]})
    api(rr + '/i18n/zh-CN', method='PUT', role='reviewer', body={'summary': '人工审核后的版本摘要。',
        'sections': [{'area': '修复', 'items': ['改善恢复工作区的稳定性。']}], 'bodyMarkdown': '## 修复\n\n改善恢复工作区。'})
    assert next(i for i in api(rr, role='reviewer')['i18n'] if i['locale'] == 'zh-CN')['reviewedBy'] == 'e2e-reviewer'
    api(rr, method='PUT', role='editor', body={'hidden': True, 'title': 'E2E 标题'})
    assert api(rr, role='reviewer')['hidden']
    api(rr, method='PUT', role='editor', body={'hidden': False})
    api(rr + '/retranslate', method='POST', role='reviewer')
    assert api(rr, role='reviewer')['translationStatus'] == 'pending'


def configuration():
    releases = api('/admin-api/desktop-releases', role='ops')['records']
    assert len(releases) == 5
    fields(releases[0], 'version', 'channel', 'status', 'minMacos', 'artifacts', 'pubDate', 'publishedBy', 'createTime')
    root = '/admin-api/desktop-releases/' + str(releases[0]['id'])
    api(root, method='PUT', role='ops', body={'notesZh': '后台编辑的说明', 'notesEn': 'Edited release notes.'})
    assert api(root, role='ops')['notesZh'] == '后台编辑的说明'
    api(root + '/publish', method='POST', role='ops', code='1004')
    previous = []
    for version in ('0.99.1', '0.99.2'):
        original = releases[0]['artifacts'][0]
        artifacts = [dict(original, target=target, signature='E2E fixture; not a real signature')
                     for target in ('darwin-aarch64', 'darwin-x86_64')]
        rid = api('/admin-api/desktop-releases', method='POST', body={'version': version, 'channel': 'beta',
                  'artifacts': artifacts, 'notesZh': '纯 E2E 测试产物，请勿安装。', 'notesEn': 'E2E fixture only.'})['id']
        api('/admin-api/desktop-releases/' + str(rid) + '/publish', method='POST', role='admin')
        previous.append(rid)
    api('/admin-api/desktop-releases/' + str(previous[-1]) + '/rollback', method='POST', role='admin')
    assert api('/admin-api/desktop-releases/' + str(previous[-1]), role='ops')['status'] == 'rolled_back'
    url = e2e.frontend_environment(False)['NUXT_PUBLIC_CDN_BASE'] + '/desktop/beta/latest.json'
    with urllib.request.urlopen(url, timeout=10) as response:
        manifest = json.load(response)
        assert manifest['version'] == '0.99.1' and len(manifest['platforms']) == 2
    mirrors = api('/admin-api/mirrors', role='ops')
    mirror = dict(mirrors[0], key='e2e-audit', nameZh='本地验收镜像', nameEn='E2E audit mirror', sort=99)
    mid = api('/admin-api/mirrors', method='POST', role='ops', body=mirror)['id']
    mirror['enabled'] = False
    api('/admin-api/mirrors/' + str(mid), method='PUT', role='ops', body=mirror)
    saved = next(r for r in api('/admin-api/mirrors', role='ops') if r['id'] == mid)
    fields(saved, 'apiDomain', 'bottleDomain', 'brewGitRemote', 'coreGitRemote', 'probeUrl', 'recommended', 'enabled', 'updateBy')
    assert saved['updateBy'] == 'e2e-ops' and not saved['enabled']
    api('/admin-api/mirrors/' + str(mid), method='DELETE', role='ops')
    config = api('/admin-api/app-config', role='ops')
    original = next(r for r in config if r['key'] == 'desktop.announcement')
    fields(original, 'key', 'value', 'description', 'updateBy', 'updateTime')
    for value in ({'title': 'E2E 公告', 'enabled': True}, None, original['value']):
        api('/admin-api/app-config/desktop.announcement', method='PUT', role='ops', body={'value': value})
        saved = next(r for r in api('/admin-api/app-config', role='ops') if r['key'] == original['key'])
        assert saved['value'] == value


def main():
    before = e2e.compose(False, 'exec', '-T', 'postgres', 'psql', '-U', 'opennavo', '-d', 'opennavo',
                         '-Atc', 'SELECT count(*) FROM packages').strip()
    try:
        e2e.command(['node', 'tooling/scripts/tasks/server.mjs', 'e2e-reset'], capture=False)
        e2e.command(['node', 'tooling/scripts/tasks/server.mjs', 'e2e-up'], capture=False)
        logins()
        pid = content()
        operations()
        translations(pid)
        configuration()
        after = e2e.compose(False, 'exec', '-T', 'postgres', 'psql', '-U', 'opennavo', '-d', 'opennavo',
                            '-Atc', 'SELECT count(*) FROM packages').strip()
        assert before == after
        report = {'calls': CALLS, 'apiCalls': len(CALLS), 'roles': 5,
                  'developmentPackagesBefore': int(before), 'developmentPackagesAfter': int(after)}
        (e2e.STATE / 'admin-audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({k: v for k, v in report.items() if k != 'calls'}, ensure_ascii=False))
    finally:
        e2e.command(['node', 'tooling/scripts/tasks/server.mjs', 'e2e-down'], capture=False)


if __name__ == '__main__':
    main()
