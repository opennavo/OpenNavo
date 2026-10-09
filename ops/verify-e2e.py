#!/usr/bin/env python3
""" Exercise E2E up/reset/down and verify that the development database package count stays unchanged."""
import importlib.util
import json
from pathlib import Path
import socket
import urllib.request

SPEC = importlib.util.spec_from_file_location('e2e', Path(__file__).with_name('e2e.py'))
e2e = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(e2e)


def package_count():
    return int(e2e.compose(False, 'exec', '-T', 'postgres', 'psql', '-U', 'opennavo', '-d', 'opennavo',
                           '-Atc', 'SELECT count(*) FROM packages'))


def task(name):
    e2e.command(['node', 'tooling/scripts/tasks/server.mjs', 'e2e-' + name], capture=False)


def api(path, body=None, origin=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {'Content-Type': 'application/json'}
    if origin:
        headers['Origin'] = origin
    with urllib.request.urlopen(urllib.request.Request(e2e.API_BASE + path, data=data, headers=headers), timeout=10) as reply:
        result = json.load(reply)
        assert result['code'] == '0000', path
        if origin:
            assert reply.headers['Access-Control-Allow-Origin'] == origin
        return result['data']


def verify():
    before = package_count()
    try:
        for _ in range(2):
            task('up')
            first = e2e.owned_process()['pid']
            task('up')
            assert e2e.owned_process()['pid'] == first
            for host in ('localhost', '127.0.0.1'):
                for port in (3000, 9527, 1420):
                    home = api('/api/v1/home', origin=f'http://{host}:{port}')
                    assert len(home['popularApps']) >= 3
                login = api('/admin-api/auth/login', {'userName': 'e2e-super',
                            'password': e2e.environment(False)['E2E_ADMIN_PASSWORD']}, origin=f'http://{host}:9527')
                assert login['token']
            for query, expected in (('vscode', 'visual-studio-code'), ('%E5%BE%AE%E4%BF%A1', 'wechat'), ('rg', 'ripgrep')):
                result = api('/api/v1/search?q=' + query)
                assert result['records'][0]['package']['token'] == expected
            task('reset')
            assert e2e.ready()
            task('down')
            task('down')
            for port in (18082, 19090):
                with socket.socket() as sock:
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    sock.bind(('127.0.0.1', port))
        after = package_count()
        assert before == after, 'development catalog was modified'
        report = {'developmentPackagesBefore': before, 'developmentPackagesAfter': after,
                  'cycles': 2, 'upAndDownIdempotent': True, 'resetHealthy': True,
                  'publicOrigins': 6, 'adminOrigins': 2, 'portsReleased': [18082, 19090]}
        (e2e.STATE / 'verification.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(report))
    finally:
        task('down')


if __name__ == '__main__':
    verify()
