#!/usr/bin/env python3
""" B3 HTTP verification: connect only to fixed port 18082; read credentials in-process and never print them."""
import json
from pathlib import Path
import sys
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent.parent
BASE = 'http://127.0.0.1:18082'


def main():
    defaults = {}
    for line in (ROOT / 'apps/server/.env.example').read_text().splitlines():
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            defaults[key] = value.strip('"\'')
    gateway = (ROOT / 'apps/server/tmp/e2e/agent-gateway.key').read_text().strip()
    credentials = {'admin': '', 'agent': ''}
    count = 0

    def call(method, path, data=None, *, agent=False, expected='0000', gateway_ok=True):
        nonlocal count
        prefix = '/agent-api' if agent else '/admin-api'
        request_id = str(uuid.uuid4())
        headers = {'Authorization': 'Bearer ' + credentials['agent' if agent else 'admin'],
                   'X-Request-ID': request_id}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        if agent:
            headers.update({'X-Agent-Tool': 'b3_verification', 'X-Agent-Client-IP': '127.0.0.1'})
            if gateway_ok:
                headers['X-Agent-Gateway-Key'] = gateway
        request = urllib.request.Request(BASE + prefix + path,
                                         data=None if data is None else json.dumps(data).encode(),
                                         headers=headers, method=method)
        with urllib.request.urlopen(request, timeout=20) as response:
            result = json.load(response)
        if result.get('code') != expected:
            raise RuntimeError(f'{method} {path}: expected {expected}, got {result.get("code")}')
        count += 1
        return result.get('data'), request_id

    login, _ = call('POST', '/auth/login', {'userName': 'e2e-super', 'password': defaults['E2E_ADMIN_PASSWORD']})
    credentials['admin'] = login['token']
    previous, _ = call('GET', '/agent/clients?q=B3%20isolated%20verification&size=100')
    for old in previous['records']:
        if old['name'] == 'B3 isolated verification' and old['notes'] == '18082 only':
            tokens, _ = call('GET', f'/agent/clients/{old["id"]}/tokens?size=100')
            for old_token in tokens['records']:
                if old_token['status'] != 'revoked':
                    call('POST', f'/agent/tokens/{old_token["id"]}/revoke')
            call('PUT', f'/agent/clients/{old["id"]}', {'enabled': False})
    client, _ = call('POST', '/agent/clients', {'name': 'B3 isolated verification', 'notes': '18082 only'})
    settings, _ = call('GET', '/agent/settings')
    issued, _ = call('POST', f'/agent/clients/{client["id"]}/tokens',
                     {'name': 'B3 disposable', 'permissions': settings['grantablePermissions'],
                      'allowDelete': True, 'ipAllowlist': ['127.0.0.1/32']})
    credentials['agent'] = issued['plaintext']
    try:
        call('POST', '/introspect', agent=True)
        call('POST', '/introspect', agent=True, gateway_ok=False, expected='1004')
        call('GET', '/app-config', agent=True, expected='1004')
        call('POST', '/desktop-releases', {}, agent=True, expected='1004')
        packages, _ = call('GET', '/packages?size=1', agent=True)
        package_id = packages['records'][0]['id']
        text = {'sourceLocale': 'zh-CN', 'displayName': 'B3 演练应用', 'summary': '隔离环境的接口演练', 'description': '## 功能\n验证文字与翻译接口。'}
        preview, _ = call('PUT', f'/packages/{package_id}/text?dryRun=true', text, agent=True)
        if not preview['dryRun'] or not preview['changes']:
            raise RuntimeError('preview missing changes')
        mutation, _ = call('PUT', f'/packages/{package_id}/text', text, agent=True)
        call('GET', f'/translations/status?entity=package&id={package_id}', agent=True)
        call('PUT', '/translations/fix', {'ref': {'entity': 'package', 'id': package_id}, 'locale': 'en-US',
                                        'fields': {'summary': 'An isolated backend verification'}}, agent=True)
        call('POST', '/translations/retranslate', {'ref': {'entity': 'package', 'id': package_id}, 'locales': ['en-US']}, agent=True)
        versions, _ = call('GET', f'/versions?packageId={package_id}', agent=True)
        version = versions['records'][0]['versionBase']
        call('PUT', f'/packages/{package_id}/versions/{version}/notes',
             {'sourceLocale': 'zh-CN', 'summary': '验证版本说明', 'sections': [{'area': '改进', 'items': ['验证更新说明写入。']}]}, agent=True)
        cleared, _ = call('PUT', f'/packages/{package_id}/versions/{version}/notes', {'clear': True}, agent=True)
        call('POST', f'/content/requests/{cleared["requestId"]}/revert', {}, agent=True)
        call('POST', f'/content/revisions/{mutation["revisionId"]}/restore', {}, agent=True)
        call('PUT', '/announcement', {'enabled': True, 'sourceLocale': 'zh-CN', 'title': 'B3 演练', 'body': '隔离环境公告。'}, agent=True)
        call('GET', '/announcement', agent=True)
        desktops, _ = call('GET', '/desktop-releases', agent=True)
        if desktops['records']:
            call('PUT', f'/desktop-releases/{desktops["records"][0]["id"]}/notes',
                 {'sourceLocale': 'zh-CN', 'notes': '隔离环境更新说明。'}, agent=True)
        suffix = uuid.uuid4().hex[:12]
        collection, _ = call('POST', '/collections', {'slug': 'b3-' + suffix, 'sort': 0, 'sourceLocale': 'zh-CN',
                             'i18n': {'zh-CN': {'title': 'B3 演练合集'}}}, agent=True)
        _, deletion = call('DELETE', f'/collections/{collection["id"]}', agent=True)
        trash, _ = call('GET', f'/content/trash?requestId={deletion}', agent=True)
        call('POST', f'/content/trash/{trash["records"][0]["id"]}/restore', {}, agent=True)
        restored, _ = call('GET', f'/collections/{collection["id"]}', agent=True)
        if restored['id'] != collection['id']:
            raise RuntimeError('restoration changed identity')
        _, glossary_request = call('PUT', '/glossary', {'term': 'B3-' + suffix, 'translations': {}, 'doNotTranslate': True}, agent=True)
        call('POST', f'/content/requests/{glossary_request}/revert', {}, agent=True)
        for path in ['/catalog/changes', '/packages?gaps=zhSummary&gapMode=all', '/translations?status=missing',
                     '/translations?stale=true', '/content/revisions', '/content/trash', '/agent/calls', '/translations/logs', '/dashboard/overview']:
            call('GET', path, agent=True)
    finally:
        call('POST', f'/agent/tokens/{issued["token"]["id"]}/revoke')
    call('POST', '/introspect', agent=True, expected='7777')
    print(f'B3 backend E2E passed: {count} requests; disposable token revoked; no live LLM used')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, IndexError, urllib.error.URLError) as error:
        print(str(error) if isinstance(error, RuntimeError) else f'B3 verification failed: {type(error).__name__}', file=sys.stderr)
        sys.exit(1)
