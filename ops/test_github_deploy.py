import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import subprocess
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
import unittest.mock
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('github_deploy', Path(__file__).with_name('github-deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def archive(name='index.html', kind=tarfile.REGTYPE):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as tar:
        entry = tarfile.TarInfo(name)
        entry.type = kind
        entry.linkname = '/etc/passwd' if kind == tarfile.SYMTYPE else ''
        body = b'<html>fixture</html>'
        entry.size = len(body) if kind == tarfile.REGTYPE else 0
        tar.addfile(entry, io.BytesIO(body))
    return output.getvalue()


def payload():
    data = archive()
    return {'sha': 'a' * 40, 'run_id': '123', 'images': {kind: 'ghcr.io/example/opennavo-' + kind + '@sha256:' + 'b' * 64 for kind in ['server', 'web', 'mcp']},
            'admin_archive': base64.b64encode(data).decode(), 'admin_sha256': hashlib.sha256(data).hexdigest()}



GOOD_CADDY = b'{$WEB_DOMAIN} {\n\treverse_proxy web:3000\n}\n'
TRUNCATED_CADDY = b'{$WEB_DOMAIN} {\n\treverse_proxy'


class FakeCaddy:
    """Fake docker/caddy: validate reads the real file it was pointed at; contents in `good` pass."""

    def __init__(self, live, good=(GOOD_CADDY,), validator='ok', signal_ok=True):
        self.live, self.good, self.validator, self.signal_ok = live, set(good), validator, signal_ok
        self.staged, self.events = {}, []

    def __call__(self, args):
        if args[:2] == ['docker', 'cp']:
            self.staged[args[3].split(':', 1)[1]] = Path(args[2]).read_bytes()
            return ''
        if 'validate' in args:
            target = args[args.index('--config') + 1]
            content = self.live.read_bytes() if target == '/etc/caddy/Caddyfile' else self.staged[target]
            self.events.append(('validate', target, content))
            if self.validator == 'timeout':
                raise deploy.subprocess.TimeoutExpired(args, 1)
            if self.validator == 'daemon':
                raise RuntimeError('command failed: docker (exit 125); inspect privately on host')
            if self.validator == 'missing' or content not in self.good:
                raise RuntimeError('command failed: docker (exit 1); inspect privately on host')
            return ''
        if 'version' in args:
            if self.validator == 'missing':
                raise RuntimeError('command failed: docker (exit 1); inspect privately on host')
            return 'v2'
        if '--signal=USR1' in args:
            self.events.append(('signal', self.live.read_bytes()))
            if not self.signal_ok:
                raise RuntimeError('fixture reload failure')
        return ''


def prepare_on_host(root, api_environment, include_public_mcp=False):
    """Prepare a release on a minimal existing host and return the deployment and its candidate overlay."""
    directory = Path(root)
    # Pin host configuration so lint's isolated verification environment cannot change it.
    (directory / '.env').write_text('PUBLIC_MCP_PROXY_IP=172.30.80.3\nPUBLIC_MCP_PROXY_IP_ALT=172.30.80.4\n')
    for name in ['deploy', 'releases', 'assets']:
        (directory / name).mkdir()
    (directory / 'admin.caddy').write_text(':8081 {}')
    kinds = ['api', 'web', 'mcp', 'admin'] + (['public-mcp'] if include_public_mcp else [])
    services = {kind: kind + '_previous' for kind in kinds}
    (directory / 'deploy/github-state.json').write_text(json.dumps({'services': services}))
    overlay = {'services': {name: {'environment': {}, 'networks': {}} for name in services.values()}}
    overlay['services'][services['api']]['environment'] = dict(api_environment)
    overlay['services'][services['web']]['volumes'] = [{'source': str(directory / 'assets'), 'target': '/app/.output/public/_nuxt'}]
    overlay['services'][services['admin']]['volumes'] = [
        {'source': str(directory / 'admin.caddy'), 'target': '/etc/caddy/Caddyfile'},
        {'source': str(directory / 'admin'), 'target': '/srv/admin'}]
    if include_public_mcp:
        overlay['services'][services['api']]['networks'] = {'proxy': {'aliases': ['api-proxy']}}
        overlay['services'][services['public-mcp']].update({
            'entrypoint': ['opennavo-public-mcp'],
            'environment': {'OPENNAVO_PUBLIC_API_BASE': 'http://api-proxy:8080/api/v1'},
            'networks': {'proxy': {'aliases': ['public-mcp-proxy']}},
        })
    (directory / 'deploy/rolling.compose.json').write_text(json.dumps(overlay))
    (directory / 'current-release.env').write_text('SERVER_IMAGE=old\n')
    route = ('{$WEB_DOMAIN} {\n'
             '\timport security-web\n'
             '\tencode zstd gzip\n'
             '\treverse_proxy {\n'
             '\t\tdynamic a\n'
             '\t}\n'
             '}\n')
    (directory / 'live.caddy').write_text(route)
    obj = deploy.Deployment({'root': root, 'caddy_file': 'live.caddy', 'caddy_container': 'fixture-caddy',
                             'compose_file': 'compose.yml', 'project': 'fixture'}, payload())
    with patch.object(deploy, 'command', return_value='fixture-container'):
        obj.prepare(archive())
    return obj, json.loads((obj.directory / 'rolling.compose.json').read_text())


class DeployTests(unittest.TestCase):
    def test_merge_web_assets_keeps_recent_old_files_and_expires_stale_files(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            previous, current, destination = (root / name for name in ['previous', 'current', 'destination'])
            previous.mkdir(); current.mkdir(); destination.mkdir()
            now = deploy.WEB_ASSET_RETENTION_SECONDS + 100
            (previous / 'old.js').write_text('old')
            (previous / 'stale.js').write_text('stale')
            os.utime(previous / 'old.js', (now - 86400, now - 86400))
            os.utime(previous / 'stale.js', (now - deploy.WEB_ASSET_RETENTION_SECONDS - 1, now - deploy.WEB_ASSET_RETENTION_SECONDS - 1))
            shutil.copytree(previous, destination, dirs_exist_ok=True)
            (current / 'new.js').write_text('new')
            deploy.merge_web_assets(current, destination, now=now, previous_current={'old.js'})
            self.assertTrue((destination / 'old.js').exists())
            self.assertTrue((destination / 'new.js').exists())
            self.assertFalse((destination / 'stale.js').exists())
            self.assertEqual((destination / 'new.js').stat().st_mtime, now)

    def test_merge_web_assets_refreshes_the_previous_live_release_after_eight_days(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            current, destination = (root / name for name in ['current', 'destination'])
            current.mkdir(); destination.mkdir()
            now = deploy.WEB_ASSET_RETENTION_SECONDS * 2
            (destination / 'previous.js').write_text('previous')
            (destination / 'earlier.js').write_text('earlier')
            os.utime(destination / 'previous.js', (now - deploy.WEB_ASSET_RETENTION_SECONDS - 86400,) * 2)
            os.utime(destination / 'earlier.js', (now - deploy.WEB_ASSET_RETENTION_SECONDS * 2,) * 2)
            (current / 'new.js').write_text('new')

            deploy.merge_web_assets(current, destination, now=now, previous_current={'previous.js'})

            self.assertTrue((destination / 'previous.js').exists())
            self.assertEqual((destination / 'previous.js').stat().st_mtime, now)
            self.assertTrue((destination / 'new.js').exists())
            self.assertFalse((destination / 'earlier.js').exists())

    def test_merge_web_assets_does_not_refresh_older_retained_assets(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            current, destination = (root / name for name in ['current', 'destination'])
            current.mkdir(); destination.mkdir()
            now = deploy.WEB_ASSET_RETENTION_SECONDS + 100
            (destination / 'live.js').write_text('live')
            (destination / 'retained.js').write_text('retained')
            retained_mtime = now - deploy.WEB_ASSET_RETENTION_SECONDS - 1
            os.utime(destination / 'live.js', (now - 86400,) * 2)
            os.utime(destination / 'retained.js', (retained_mtime,) * 2)
            (current / 'new.js').write_text('new')

            deploy.merge_web_assets(current, destination, now=now, previous_current={'live.js'})

            self.assertTrue((destination / 'live.js').exists())
            self.assertFalse((destination / 'retained.js').exists())

    def test_merge_web_assets_refreshes_all_files_when_legacy_manifest_is_missing(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            current, destination = (root / name for name in ['current', 'release/web-assets'])
            current.mkdir(); destination.mkdir(parents=True)
            now = deploy.WEB_ASSET_RETENTION_SECONDS + 100
            for index, name in enumerate(['old-a.js', 'old-b.js', 'old-c.js']):
                path = destination / name
                path.write_text(name)
                # Keep each file on a different whole-second timestamp, all
                # older than the retention window.
                mtime = now - deploy.WEB_ASSET_RETENTION_SECONDS - 10 - index
                os.utime(path, (mtime, mtime))
            (current / 'new.js').write_text('new')

            deploy.merge_web_assets(current, destination, now=now)

            for name in ['old-a.js', 'old-b.js', 'old-c.js']:
                path = destination / name
                self.assertTrue(path.exists())
                self.assertEqual(path.stat().st_mtime, now)
            self.assertTrue((destination / 'new.js').exists())

    def test_previous_web_asset_paths_uses_the_release_manifest(self):
        with tempfile.TemporaryDirectory() as root:
            release = Path(root) / 'release'
            destination = release / 'web-assets'
            destination.mkdir(parents=True)
            (destination / 'live.js').write_text('live')
            (destination / 'retained.js').write_text('retained')
            os.utime(destination / 'live.js', (1, 1))
            os.utime(destination / 'retained.js', (2, 2))
            (release / 'manifest.json').write_text(json.dumps({'web_assets': ['live.js']}))

            self.assertEqual(deploy.previous_web_asset_paths(destination), {'live.js'})

    def test_prepare_moves_cache_notifier_to_new_web_and_preserves_rollback(self):
        for use_alias in [False, True]:
            with self.subTest(use_alias=use_alias), tempfile.TemporaryDirectory() as root:
                directory = Path(root)
                (directory / 'deploy').mkdir()
                (directory / 'releases').mkdir()
                assets = directory / 'assets'
                assets.mkdir()
                caddy = directory / 'admin.caddy'
                caddy.write_text(':8081 {}')
                services = {kind: kind + '_previous' for kind in ['api', 'web', 'mcp', 'admin']}
                (directory / 'deploy/github-state.json').write_text(json.dumps({'services': services}))
                overlay = {'services': {name: {'environment': {}, 'networks': {}} for name in services.values()}}
                overlay['services'][services['web']].update({
                    'networks': {'default': {'aliases': ['web-previous-alias']}},
                    'volumes': [{'source': str(assets), 'target': '/app/.output/public/_nuxt'}]})
                overlay['services'][services['admin']]['volumes'] = [
                    {'source': str(caddy), 'target': '/etc/caddy/Caddyfile'},
                    {'source': str(directory / 'admin'), 'target': '/srv/admin'}]
                old_host = 'web-previous-alias' if use_alias else services['web']
                overlay['services']['worker'] = {'environment': {
                    'WEB_INTERNAL_URL': 'http://' + old_host + ':9091',
                    'WEB_INTERNAL_SECRET': '${WEB_INTERNAL_SECRET}', 'OTHER_SETTING': 'unchanged'}}
                rolling = directory / 'deploy/rolling.compose.json'
                rolling.write_text(json.dumps(overlay))
                (directory / 'current-release.env').write_text('SERVER_IMAGE=old\n')
                (directory / 'live.caddy').write_text(
                    '{$WEB_DOMAIN} {\n\treverse_proxy {\n\t dynamic a\n\t}\n}\n')
                obj = deploy.Deployment({'root': root, 'caddy_file': 'live.caddy',
                                         'compose_file': 'compose.yml', 'project': 'fixture'}, payload())
                with patch.object(deploy, 'command', return_value='fixture-container'):
                    obj.prepare(archive())
                candidate = json.loads((obj.directory / 'rolling.compose.json').read_text())
                self.assertEqual(candidate['services'][obj.services['web']]['environment']['NUXT_IMAGE_REDIS_URL'], 'redis://image-cache:6379/0')
                self.assertNotIn('volumes', candidate['services']['image-cache'])
                self.assertNotIn('ports', candidate['services']['image-cache'])
                expected_host = 'web-default-' + obj.release if use_alias else obj.services['web']
                self.assertEqual(candidate['services']['worker']['environment'], {
                    'WEB_INTERNAL_URL': 'http://' + expected_host + ':9091',
                    'WEB_INTERNAL_SECRET': '${WEB_INTERNAL_SECRET}', 'OTHER_SETTING': 'unchanged'})
                self.assertEqual(json.loads(rolling.read_text()), overlay)
                self.assertEqual(candidate['services'][services['web']], overlay['services'][services['web']])

    def test_prepare_gives_an_old_api_service_the_usage_country_proxy_and_keeps_host_values(self):
        # A host provisioned before the setting gets the same value as a fresh install from the base compose.
        default = '${CADDY_PROXY_IP:-172.30.80.2}'
        public_proxy = '${PUBLIC_MCP_PROXY_IP:-172.30.80.3}/32'
        public_proxy_alt = '${PUBLIC_MCP_PROXY_IP_ALT:-172.30.80.4}/32'
        trusted_default = '${CADDY_PROXY_IP:-172.30.80.2},' + public_proxy + ',' + public_proxy_alt + ',${SSR_PROXY_SUBNET:-172.30.81.0/24}'
        base = Path(__file__).with_name('docker-compose.prod.yml').read_text()
        self.assertIn('USAGE_COUNTRY_TRUSTED_PROXIES: ' + default + '\n', base)
        cases = [
            ({}, trusted_default, default),
            ({'TRUSTED_PROXIES': '172.30.80.2'}, '172.30.80.2,' + public_proxy + ',' + public_proxy_alt, default),
            ({'TRUSTED_PROXIES': '192.0.2.10'}, '192.0.2.10,' + public_proxy + ',' + public_proxy_alt, default),
            ({'TRUSTED_PROXIES': '192.0.2.10,' + public_proxy}, '192.0.2.10,' + public_proxy + ',' + public_proxy_alt, default),
            ({'TRUSTED_PROXIES': '192.0.2.10,172.30.80.3'}, '192.0.2.10,172.30.80.3,' + public_proxy_alt, default),
            ({'USAGE_COUNTRY_TRUSTED_PROXIES': '192.0.2.10'}, trusted_default, '192.0.2.10'),
            ({'USAGE_COUNTRY_TRUSTED_PROXIES': ''}, trusted_default, ''),
        ]
        for environment, trusted_expected, usage_expected in cases:
            with self.subTest(environment=environment), tempfile.TemporaryDirectory() as root:
                obj, candidate = prepare_on_host(root, environment)
                self.assertEqual(candidate['services'][obj.services['api']]['environment'], {
                    'TRUSTED_PROXIES': trusted_expected,
                    'USAGE_COUNTRY_TRUSTED_PROXIES': usage_expected,
                })
                # The rollback service stays exactly as it ran.
                self.assertEqual(candidate['services']['api_previous']['environment'],
                                 environment)

    def test_prepare_uses_host_proxy_addresses_with_conflicting_process_environment(self):
        with patch.dict(os.environ, {'PUBLIC_MCP_PROXY_IP': '10.250.90.3',
                                     'PUBLIC_MCP_PROXY_IP_ALT': '10.250.90.4'}), \
                tempfile.TemporaryDirectory() as root:
            obj, candidate = prepare_on_host(root, {})
            self.assertEqual(obj.public_mcp_proxy_ips(), ('172.30.80.3', '172.30.80.4'))
            self.assertEqual(candidate['services'][obj.services['public-mcp']]['networks']['proxy']['ipv4_address'],
                             '172.30.80.3')
            self.assertEqual(candidate['services'][obj.services['api']]['environment']['TRUSTED_PROXIES'],
                             deploy.DEFAULT_TRUSTED_PROXIES)

    def test_prepare_creates_public_mcp_candidate_with_alias_and_health_check(self):
        with tempfile.TemporaryDirectory() as root:
            obj, candidate = prepare_on_host(root, {
                'TRUSTED_PROXIES': '172.30.80.2',
            }, include_public_mcp=True)
            service = candidate['services'][obj.services['public-mcp']]
            self.assertEqual(service['image'], payload()['images']['mcp'])
            self.assertEqual(service['entrypoint'], ['opennavo-public-mcp'])
            self.assertIn("127.0.0.1:8790/healthz", service['healthcheck']['test'][-1])
            self.assertEqual(service['environment']['OPENNAVO_PUBLIC_API_BASE'],
                             'http://api-proxy-' + obj.release + ':8080/api/v1')
            self.assertEqual(obj.services['public-mcp'], 'public-mcp_' + obj.release.replace('-', '_'))
            self.assertIn('public-mcp-proxy-' + obj.release, (obj.directory / 'Caddyfile.next').read_text())
            self.assertIn(obj.services['public-mcp'], obj.candidate_up_args())

    def test_public_mcp_proxy_preflight_rotates_reserved_addresses(self):
        for old_ip, expected in [(None, '172.30.80.3'), ('172.30.80.3', '172.30.80.4'),
                                 ('172.30.80.4', '172.30.80.3')]:
            with self.subTest(old_ip=old_ip), tempfile.TemporaryDirectory() as root:
                root = Path(root)
                (root / '.env').write_text('PUBLIC_MCP_PROXY_IP=172.30.80.3\nPUBLIC_MCP_PROXY_IP_ALT=172.30.80.4\n')
                old = 'public-mcp_previous'
                (root / 'rolling.json').write_text(json.dumps({'services': {
                    old: {'networks': {'proxy': ({'ipv4_address': old_ip} if old_ip else {})}}
                }}))
                obj = object.__new__(deploy.Deployment)
                obj.root = root
                obj.rolling = root / 'rolling.json'
                obj.state = {'services': {'public-mcp': old}}
                obj.config = {'project': 'fixture'}
                containers = {}
                if old_ip:
                    containers['old-id'] = {'Name': 'fixture-public-mcp_previous-1', 'IPv4Address': old_ip + '/24'}

                def command(args, output=None):
                    if args[:3] == ['docker', 'network', 'inspect']:
                        return json.dumps([{'Containers': containers}])
                    if args[:2] == ['docker', 'inspect']:
                        return json.dumps([{'Id': 'old-id', 'Config': {'Labels': {
                            'com.docker.compose.project': 'fixture',
                            'com.docker.compose.service': old}}}])
                    raise AssertionError(args)

                with patch.object(deploy, 'command', side_effect=command):
                    obj.public_mcp_preflight()
                self.assertEqual(obj.public_mcp_proxy_ip, expected)

    def test_public_mcp_proxy_preflight_rejects_foreign_or_exhausted_addresses(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            (root / '.env').write_text('PUBLIC_MCP_PROXY_IP=172.30.80.3\nPUBLIC_MCP_PROXY_IP_ALT=172.30.80.4\n')
            obj = object.__new__(deploy.Deployment)
            obj.root = root
            obj.rolling = root / 'missing-rolling.json'
            obj.state = {'services': {}}
            obj.config = {'project': 'fixture'}
            foreign = {'foreign': {'Name': 'fixture-redis-1', 'IPv4Address': '172.30.80.3/24'}}
            def foreign_command(args, output=None):
                if args[:3] == ['docker', 'network', 'inspect']:
                    return json.dumps([{'Containers': foreign}])
                if args[:2] == ['docker', 'inspect']:
                    return json.dumps([{'Id': 'foreign', 'Config': {'Labels': {
                        'com.docker.compose.project': 'fixture', 'com.docker.compose.service': 'redis'}}}])
                raise AssertionError(args)
            with patch.object(deploy, 'command', side_effect=foreign_command), \
                    self.assertRaisesRegex(RuntimeError, 'non-public-mcp'):
                obj.public_mcp_preflight()

            occupied = {
                'old-a': {'Name': 'fixture-public-mcp_a-1', 'IPv4Address': '172.30.80.3/24'},
                'old-b': {'Name': 'fixture-public-mcp_b-1', 'IPv4Address': '172.30.80.4/24'},
            }
            def full_command(args, output=None):
                if args[:3] == ['docker', 'network', 'inspect']:
                    return json.dumps([{'Containers': occupied}])
                if args[:2] == ['docker', 'inspect']:
                    return json.dumps([{'Id': item, 'Config': {'Labels': {
                        'com.docker.compose.project': 'fixture',
                        'com.docker.compose.service': 'public-mcp_' + item}}} for item in occupied])
                raise AssertionError(args)
            with patch.object(deploy, 'command', side_effect=full_command), \
                    self.assertRaisesRegex(RuntimeError, 'both reserved addresses'):
                obj.public_mcp_preflight()

    def test_public_mcp_trusted_proxies_use_two_host_routes(self):
        value = deploy.merge_public_mcp_trusted_proxy(None)
        self.assertIn('${PUBLIC_MCP_PROXY_IP:-172.30.80.3}/32', value)
        self.assertIn('${PUBLIC_MCP_PROXY_IP_ALT:-172.30.80.4}/32', value)
        self.assertNotIn('172.30.80.0/24', value)
        self.assertEqual(deploy.merge_public_mcp_trusted_proxy('192.0.2.1,192.0.2.1').count('192.0.2.1'), 1)

    def test_public_mcp_preflight_reclaims_failed_and_retained_project_peers(self):
        for running in [True, False]:
            with self.subTest(running=running), tempfile.TemporaryDirectory() as root:
                obj = object.__new__(deploy.Deployment)
                obj.root, obj.rolling = Path(root), Path(root) / 'rolling.json'
                obj.config = {'project': 'fixture', 'public_mcp_proxy_ips': ['172.30.80.3', '172.30.80.4']}
                obj.state = {'public_mcp_proxy_ip': '172.30.80.3', 'services': {'public-mcp': 'public-mcp_live'}}
                entries = {name: {'Name': 'fixture-' + name + '-1', 'IPv4Address': ip + '/24'}
                           for name, ip in [('live', '172.30.80.3'), ('failed', '172.30.80.4')]}
                details = [{'Id': name, 'State': {'Running': running if name == 'live' else False},
                            'Config': {'Labels': {'com.docker.compose.project': 'fixture',
                                                 'com.docker.compose.service': 'public-mcp_' + name}}}
                           for name in entries]
                disconnected = []
                def command(args):
                    if args[:3] == ['docker', 'network', 'inspect']:
                        return json.dumps([{'Containers': entries}])
                    if args[:2] == ['docker', 'inspect']:
                        return json.dumps(details)
                    self.assertEqual(args[:4], ['docker', 'network', 'disconnect', 'fixture_proxy'])
                    self.assertFalse(next(item for item in details if item['Id'] == args[4])['State']['Running'])
                    disconnected.append(args[4])
                    return ''
                with patch.object(deploy, 'command', side_effect=command):
                    obj.public_mcp_preflight()
                self.assertEqual(obj.public_mcp_proxy_ip, '172.30.80.4')
                self.assertEqual(set(disconnected), {'failed'} if running else {'live', 'failed'})

    def test_public_mcp_preflight_never_reclaims_foreign_or_unlabelled_peers(self):
        for labels in [{}, {'com.docker.compose.project': 'other', 'com.docker.compose.service': 'public-mcp_old'},
                       {'com.docker.compose.project': 'fixture', 'com.docker.compose.service': 'redis'}]:
            with self.subTest(labels=labels), tempfile.TemporaryDirectory() as root:
                obj = object.__new__(deploy.Deployment)
                obj.root = Path(root)
                obj.config = {'project': 'fixture', 'public_mcp_proxy_ips': ['172.30.80.3', '172.30.80.4']}
                responses = [json.dumps([{'Containers': {'foreign': {
                    'Name': 'fixture-public-mcp-old-1', 'IPv4Address': '172.30.80.4/24'}}}]),
                    json.dumps([{'Id': 'foreign', 'State': {'Running': False}, 'Config': {'Labels': labels}}])]
                with patch.object(deploy, 'command', side_effect=responses) as run, \
                        self.assertRaisesRegex(RuntimeError, 'non-public-mcp'):
                    obj.public_mcp_preflight()
                self.assertEqual(run.call_count, 2)

    def test_public_mcp_address_change_preserves_entries_without_ownership_evidence(self):
        value = '192.0.2.1,172.30.80.3/32,172.30.80.4/32'
        result = deploy.merge_public_mcp_trusted_proxy(value, ['172.30.82.3', '172.30.82.4'])
        self.assertEqual(result, value + ',172.30.82.3/32,172.30.82.4/32')

    def test_compose_up_restores_reclaimed_public_mcp_proxy_idempotently(self):
        for candidate, address_source in [(False, 'state'), (False, 'overlay'),
                                          (False, 'compose'), (True, 'compose')]:
            with self.subTest(candidate=candidate, address_source=address_source), tempfile.TemporaryDirectory() as root:
                obj, _ = prepare_on_host(root, {}, include_public_mcp=True)
                service = (obj.services if candidate else obj.state['services'])['public-mcp']
                address = '172.30.80.4' if candidate else '172.30.80.3'
                if address_source == 'state':
                    obj.state['public_mcp_proxy_ip'] = address
                    obj.config['proxy_network'] = 'custom-proxy'
                elif address_source == 'overlay':
                    overlay = json.loads(obj.rolling.read_text())
                    overlay['services'][service]['networks']['proxy']['ipv4_address'] = address
                    obj.rolling.write_text(json.dumps(overlay))
                network = obj.config.get('proxy_network', 'fixture_proxy')
                aliases = ['public-mcp-proxy-' + ('candidate' if candidate else 'previous')]
                resolved = {'services': {service: {'networks': {'proxy': {
                    # A rollback's recorded address takes precedence over a changed base file.
                    'ipv4_address': '172.30.80.4' if address_source == 'state' else address,
                    'aliases': aliases}}}}}
                networks, events = {}, []
                up = ('up', '-d', '--no-deps', '--wait', '--wait-timeout', '240', service)

                def command(args):
                    if args[:2] == ['docker', 'compose']:
                        action = tuple(args[args.index('automation') + 1:])
                        events.append(action)
                        if action == up:
                            # Starting a retained container does not restore its endpoint.
                            return 'started'
                        if action == ('ps', '-q', service):
                            return 'target-id'
                        self.assertEqual(action, ('config', '--format', 'json'))
                        return json.dumps(resolved)
                    events.append(tuple(args))
                    if args[:2] == ['docker', 'inspect']:
                        self.assertEqual(args[2:], ['target-id'])
                        return json.dumps([{'Id': 'target-id', 'State': {'Running': True},
                                            'NetworkSettings': {'Networks': networks}}])
                    self.assertEqual(args, ['docker', 'network', 'connect', '--ip', address,
                                            '--alias', service, '--alias', *aliases, network, 'target-id'])
                    networks[network] = {'IPAddress': address}
                    return ''

                with patch.object(deploy, 'command', side_effect=command):
                    self.assertEqual(obj.compose(*up, candidate=candidate), 'started')
                    self.assertEqual(obj.compose(*up, candidate=candidate), 'started')
                connects = [event for event in events if event[:3] == ('docker', 'network', 'connect')]
                self.assertEqual(len(connects), 1)
                self.assertEqual(networks[network]['IPAddress'], address)
                self.assertLess(events.index(up), events.index(connects[0]))

    def test_compose_up_leaves_other_services_and_commands_alone(self):
        with tempfile.TemporaryDirectory() as root:
            obj, _ = prepare_on_host(root, {})
            calls = [
                (('up', '-d', '--no-deps', 'worker'), False),
                (('up', '-d', '--no-deps', obj.state['services']['mcp']), False),
                (('up', '-d', '--no-deps', obj.services['web']), True),
                (('stop', obj.services['public-mcp']), True),
            ]
            with patch.object(deploy, 'command', return_value='unchanged') as run:
                for args, candidate in calls:
                    self.assertEqual(obj.compose(*args, candidate=candidate), 'unchanged')
            self.assertEqual(run.call_count, len(calls))
            self.assertTrue(all(call.args[0][:2] == ['docker', 'compose'] for call in run.call_args_list))

    def test_public_mcp_proxy_restore_refuses_wrong_or_unrecorded_addresses(self):
        for attached in [False, True]:
            with self.subTest(attached=attached):
                obj = object.__new__(deploy.Deployment)
                obj.config = {'project': 'fixture'}
                resolved = {'services': {'public-mcp_new': {'networks': {'proxy': {
                    'ipv4_address': '172.30.80.4'} if attached else {}}}}}
                obj.compose = unittest.mock.Mock(side_effect=['target-id', json.dumps(resolved)])
                networks = {'fixture_proxy': {'IPAddress': '172.30.80.99'}} if attached else {}
                info = [{'Id': 'target-id', 'NetworkSettings': {'Networks': networks}}]
                message = 'unexpected fixed address' if attached else 'requires a recorded fixed address'
                with patch.object(deploy, 'command', return_value=json.dumps(info)) as run, \
                        self.assertRaisesRegex(RuntimeError, message):
                    obj.restore_public_mcp_proxy('public-mcp_new', candidate=True)
                run.assert_called_once_with(['docker', 'inspect', 'target-id'])

    def test_rollback_reconnects_public_mcp_before_switching_routes_and_retiring_candidates(self):
        for failure in [False, True]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as root:
                obj, _ = prepare_on_host(root, {}, include_public_mcp=True)
                obj.state['public_mcp_proxy_ip'] = '172.30.80.3'
                service = obj.state['services']['public-mcp']
                obj.live_caddy.write_text('candidate route')
                resolved = {'services': {service: {'networks': {'proxy': {
                    'ipv4_address': '172.30.80.3', 'aliases': ['public-mcp-proxy-previous']}}}}}
                events = []

                def command(args):
                    if args[:2] == ['docker', 'compose']:
                        action = tuple(args[args.index('automation') + 1:])
                        events.append(action)
                        if action == ('ps', '-q', service):
                            return 'old-id'
                        if action == ('config', '--format', 'json'):
                            return json.dumps(resolved)
                        self.assertIn(action[0], ('up', 'stop', 'rm'))
                        return ''
                    if args[:2] == ['docker', 'inspect']:
                        self.assertEqual(args[2:], ['old-id'])
                        return json.dumps([{'Id': 'old-id', 'NetworkSettings': {'Networks': {}}}])
                    if args[:3] == ['docker', 'network', 'connect']:
                        self.assertEqual(args, ['docker', 'network', 'connect', '--ip', '172.30.80.3',
                                                '--alias', service, '--alias', 'public-mcp-proxy-previous',
                                                'fixture_proxy', 'old-id'])
                        events.append('reconnect')
                        self.assertEqual(obj.live_caddy.read_text(), 'candidate route')
                        if failure:
                            raise RuntimeError('fixture reconnect failure')
                        return ''
                    self.assertEqual(args[:3], ['docker', 'ps', '-q'])
                    return 'candidate-id'

                with patch.object(deploy, 'command', side_effect=command), \
                        patch.object(obj, 'reload', side_effect=lambda: events.append('reload')) as reload, \
                        patch.object(obj, 'verify') as verify, \
                        patch.object(obj, 'verify_public_mcp', side_effect=lambda: events.append('handshake')) as handshake, \
                        patch.object(obj, 'update_monitoring') as monitoring, \
                        patch.object(obj, 'drain_retired', return_value=True), \
                        contextlib.redirect_stdout(io.StringIO()):
                    if failure:
                        with self.assertRaisesRegex(RuntimeError, 'degraded rollback') as error:
                            obj.rollback()
                        self.assertIn('fixture reconnect failure', str(error.exception.__cause__))
                        self.assertTrue(obj.degraded_path.is_file())
                        self.assertEqual(obj.live_caddy.read_text(), 'candidate route')
                        self.assertEqual(obj.env.read_bytes(), (obj.directory / 'release.env').read_bytes())
                        self.assertEqual(obj.rolling.read_bytes(), (obj.directory / 'rolling.compose.json').read_bytes())
                        for mock in [reload, verify, handshake, monitoring]:
                            mock.assert_not_called()
                        self.assertFalse(any(isinstance(event, tuple) and event[0] in ('stop', 'rm') for event in events))
                    else:
                        obj.rollback()
                        self.assertLess(events.index('reconnect'), events.index('reload'))
                        self.assertLess(events.index('reload'), events.index('handshake'))
                        stop = ('stop', '--timeout', '90', *obj.services.values())
                        remove = ('rm', '--force', '--stop', *obj.services.values())
                        self.assertLess(events.index('handshake'), events.index(stop))
                        self.assertLess(events.index(stop), events.index(remove))

    def test_rollback_keeps_previous_public_mcp_address_and_removes_candidate(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            obj = object.__new__(deploy.Deployment)
            obj.config = {'project': 'fixture', 'local_origin': 'http://127.0.0.1:80',
                          'public_mcp_host': 'web.example.test', 'checks': []}
            obj.state = {'sha': 'c' * 40, 'services': {'public-mcp': 'public-mcp_old'}}
            obj.services = {'public-mcp': 'public-mcp_new'}
            obj.directory = root
            obj.live_caddy, obj.env, obj.rolling = (root / name for name in ['live', 'env', 'rolling'])
            obj.live_caddy.write_text('candidate')
            (root / 'before-caddy').write_text('old')
            (root / 'before-release.env').write_text('old-env')
            previous_overlay = {'services': {'public-mcp_old': {'networks': {
                'proxy': {'ipv4_address': '172.30.80.3'}}}}}
            (root / 'before-rolling.json').write_text(json.dumps(previous_overlay))
            events = []
            obj.compose = lambda *args, **kwargs: events.append(args)
            obj.reload = lambda: events.append('reload')
            obj.verify = lambda expected=None: events.append(('verify', expected))
            obj.update_monitoring = lambda services: events.append('monitoring')
            obj.drain_retired = lambda *args, **kwargs: True
            requests = []
            def urlopen(request, timeout):
                requests.append(json.loads(request.data)['method'])
                response = io.BytesIO(json.dumps({'result': {'tools': [{'name': 'search_apps'}]}}).encode())
                response.status, response.headers = 200, {}
                return response
            with patch.object(deploy, 'command', return_value='candidate-id'), \
                    patch.object(deploy.urllib.request, 'urlopen', side_effect=urlopen):
                obj.rollback()
            self.assertEqual(requests, ['initialize', 'tools/list'])
            self.assertLess(events.index('reload'), events.index('monitoring'))
            self.assertIn(('up', '-d', '--no-deps', '--wait', '--wait-timeout', '240',
                           'public-mcp_old', 'worker'), events)
            self.assertIn(('stop', '--timeout', '90', 'public-mcp_new'), events)
            self.assertIn(('rm', '--force', '--stop', 'public-mcp_new'), events)
            self.assertEqual(json.loads((root / 'before-rolling.json').read_text()), previous_overlay)
            events.clear()
            with patch.object(deploy, 'command') as run, \
                    patch.object(deploy.urllib.request, 'urlopen', side_effect=RuntimeError('handshake failed')), \
                    self.assertRaisesRegex(RuntimeError, 'handshake failed'):
                obj.rollback()
            run.assert_not_called()
            self.assertNotIn('monitoring', events)
            self.assertFalse(any(isinstance(event, tuple) and event[0] in ('stop', 'rm') for event in events))

    def test_public_mcp_route_is_inserted_idempotently_and_excludes_www(self):
        source = ("http://{$WEB_DOMAIN} {\n"
                  "\timport security-web\n"
                  "\t@private path /agent-api /agent-api/*\n"
                  "\trespond @private 404\n"
                  "\treverse_proxy {\n\t\tdynamic a\n\t}\n"
                  "}\n"
                  "http://www.{$WEB_DOMAIN} {\n\treverse_proxy {\n\t}\n}\n")
        routed = deploy.install_public_mcp_route(source, 'public-mcp-proxy-gh-test')
        self.assertEqual(routed.count(deploy.PUBLIC_MCP_BEGIN), 1)
        self.assertIn('reverse_proxy public-mcp-proxy-gh-test:8790', routed)
        self.assertLess(routed.index(deploy.PUBLIC_MCP_END), routed.index('\treverse_proxy {'))
        www = routed[routed.index('http://www.{$WEB_DOMAIN}'):]
        self.assertNotIn(deploy.PUBLIC_MCP_BEGIN, www)
        self.assertEqual(deploy.install_public_mcp_route(routed, 'public-mcp-proxy-gh-test'), routed)

    def test_public_mcp_route_replaces_an_older_marked_block(self):
        source = "{$WEB_DOMAIN} {\n" + deploy.public_mcp_route('public-mcp-proxy-old') + "\treverse_proxy {\n}\n}\n"
        routed = deploy.install_public_mcp_route(source, 'public-mcp-proxy-new')
        self.assertEqual(routed.count(deploy.PUBLIC_MCP_BEGIN), 1)
        self.assertNotIn('public-mcp-proxy-old', routed)
        self.assertIn('public-mcp-proxy-new:8790', routed)

    def test_public_mcp_route_real_repo_and_unmarked_legacy_are_idempotent(self):
        source = Path(__file__).with_name('caddy').joinpath('Caddyfile').read_text()
        self.assertEqual(source.count(deploy.PUBLIC_MCP_BEGIN), 1)
        for legacy in [False, True]:
            with self.subTest(legacy=legacy):
                fixture = source
                if legacy:
                    fixture = fixture.replace('\t' + deploy.PUBLIC_MCP_BEGIN + '\n', '').replace(
                        '\t' + deploy.PUBLIC_MCP_END + '\n', '')
                routed = deploy.install_public_mcp_route(fixture, 'public-mcp-proxy-new')
                for _ in range(2):
                    self.assertEqual(routed.count('@publicMcp path /mcp'), 1)
                    self.assertEqual(routed.count('handle @publicMcp {'), 1)
                    self.assertEqual(routed.count('@publicMcpOther path /mcp/*'), 1)
                    self.assertEqual(routed.count(deploy.PUBLIC_MCP_BEGIN), 1)
                    self.assertNotIn('reverse_proxy public-mcp-proxy:8790', routed)
                    again = deploy.install_public_mcp_route(routed, 'public-mcp-proxy-new')
                    self.assertEqual(again, routed)
                    routed = again

    def _caddy_obj(self, root, live=GOOD_CADDY, backup=None):
        obj = object.__new__(deploy.Deployment)
        obj.root = obj.directory = Path(root)
        (obj.root / 'deploy').mkdir(exist_ok=True)
        obj.config = {'caddy_container': 'fixture-caddy'}
        obj.release, obj.payload = 'fixture', {'sha': 'a' * 40}
        obj.live_caddy = obj.root / 'Caddyfile'
        obj.live_caddy.write_bytes(live)
        if backup is not None:
            (obj.root / 'Caddyfile.bak').write_bytes(backup)
        return obj

    def test_validate_live_caddy_leaves_files_when_validator_cannot_run(self):
        for mode in ['timeout', 'daemon', 'missing']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as root:
                newer = GOOD_CADDY + b'# newer\n'
                obj = self._caddy_obj(root, live=newer, backup=GOOD_CADDY)
                fake = FakeCaddy(obj.live_caddy, good=(GOOD_CADDY, newer), validator=mode)
                with patch.object(deploy, 'command', side_effect=fake), \
                        contextlib.redirect_stdout(io.StringIO()) as output, \
                        self.assertRaises(deploy.CaddyValidatorUnavailable):
                    obj.validate_live_caddy()
                self.assertEqual(obj.live_caddy.read_bytes(), newer)
                self.assertNotIn('restoring', output.getvalue())

    def test_valid_new_caddy_is_never_replaced_by_stale_backup(self):
        with tempfile.TemporaryDirectory() as root:
            newer = GOOD_CADDY + b'# newer\n'
            obj = self._caddy_obj(root, live=newer, backup=GOOD_CADDY)
            fake = FakeCaddy(obj.live_caddy, good=(GOOD_CADDY, newer))
            with patch.object(deploy, 'command', side_effect=fake), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                obj.reload()
            self.assertEqual(obj.live_caddy.read_bytes(), newer)
            self.assertEqual(fake.events[-1], ('signal', newer))
            self.assertNotIn('restoring', output.getvalue())

    def test_invalid_live_caddy_restored_only_from_valid_backup(self):
        for backup in [GOOD_CADDY, TRUNCATED_CADDY, None]:
            with self.subTest(backup=backup), tempfile.TemporaryDirectory() as root:
                obj = self._caddy_obj(root, live=TRUNCATED_CADDY, backup=backup)
                inode = obj.live_caddy.stat().st_ino
                fake = FakeCaddy(obj.live_caddy)
                with patch.object(deploy, 'command', side_effect=fake), \
                        contextlib.redirect_stdout(io.StringIO()) as output:
                    if backup == GOOD_CADDY:
                        obj.validate_live_caddy()
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'missing' if backup is None else 'invalid too'):
                            obj.validate_live_caddy()
                self.assertEqual(obj.live_caddy.read_bytes(), GOOD_CADDY if backup == GOOD_CADDY else TRUNCATED_CADDY)
                self.assertEqual(obj.live_caddy.stat().st_ino, inode)
                if backup == GOOD_CADDY:
                    self.assertIn('restoring', output.getvalue())
                    self.assertIn('validation passed', output.getvalue())

    def test_interrupted_in_place_write_is_detected_even_if_it_validates(self):
        with tempfile.TemporaryDirectory() as root:
            prefix = b'{$WEB_DOMAIN} {\n}\n'
            obj = self._caddy_obj(root, live=prefix, backup=GOOD_CADDY)
            deploy.write_atomic(deploy.caddy_intent_path(obj.live_caddy),
                                (deploy.hashlib.sha256(GOOD_CADDY + b'# more\n').hexdigest() + '\n').encode())
            fake = FakeCaddy(obj.live_caddy, good=(GOOD_CADDY, prefix))
            with patch.object(deploy, 'command', side_effect=fake), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                obj.validate_live_caddy()
            self.assertEqual(obj.live_caddy.read_bytes(), GOOD_CADDY)
            self.assertIn('interrupted write', output.getvalue())
            self.assertFalse(deploy.caddy_intent_path(obj.live_caddy).exists())

    def test_completed_write_clears_intent_and_keeps_inode(self):
        with tempfile.TemporaryDirectory() as root:
            obj = self._caddy_obj(root, live=b'before')
            inode = obj.live_caddy.stat().st_ino
            newer = GOOD_CADDY + b'# newer\n'
            fake = FakeCaddy(obj.live_caddy, good=(newer,))
            with patch.object(deploy, 'command', side_effect=fake):
                obj.install_caddy(newer)
            self.assertEqual(obj.live_caddy.read_bytes(), newer)
            self.assertEqual(obj.live_caddy.stat().st_ino, inode)
            self.assertEqual((obj.root / 'Caddyfile.bak').read_bytes(), b'before')
            self.assertFalse(deploy.caddy_intent_path(obj.live_caddy).exists())
            self.assertEqual(list(obj.root.glob('.Caddyfile-*')), [])

    def test_install_caddy_invalid_or_unvalidated_candidate_never_touches_live(self):
        for mode in ['invalid', 'timeout', 'daemon']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as root:
                obj = self._caddy_obj(root, live=GOOD_CADDY)
                before = obj.live_caddy.stat()
                fake = FakeCaddy(obj.live_caddy, validator='ok' if mode == 'invalid' else mode)
                with patch.object(deploy, 'command', side_effect=fake), self.assertRaises(RuntimeError):
                    obj.install_caddy(TRUNCATED_CADDY)
                self.assertEqual(obj.live_caddy.read_bytes(), GOOD_CADDY)
                self.assertEqual(obj.live_caddy.stat().st_mtime_ns, before.st_mtime_ns)
                self.assertEqual(list(obj.root.glob('.Caddyfile-*')), [])

    def test_install_caddy_partial_write_restores_backup(self):
        with tempfile.TemporaryDirectory() as root:
            obj = self._caddy_obj(root, live=GOOD_CADDY)
            newer = GOOD_CADDY + b'# newer\n'
            real = deploy.write_caddy_in_place
            calls = []
            def partial(path, content):
                calls.append(content)
                if len(calls) == 1:
                    path.write_bytes(b'partial')
                    raise OSError('fixture partial write')
                real(path, content)
            with patch.object(deploy, 'command', side_effect=FakeCaddy(obj.live_caddy, good=(newer,))), \
                    patch.object(deploy, 'write_caddy_in_place', side_effect=partial), \
                    contextlib.redirect_stdout(io.StringIO()), \
                    self.assertRaisesRegex(OSError, 'fixture partial write'):
                obj.install_caddy(newer)
            self.assertEqual(obj.live_caddy.read_bytes(), GOOD_CADDY)

    def test_reload_signal_failure_restores_validated_backup_and_marks_degraded(self):
        with tempfile.TemporaryDirectory() as root:
            newer = GOOD_CADDY + b'# newer\n'
            obj = self._caddy_obj(root, live=newer, backup=GOOD_CADDY)
            fake = FakeCaddy(obj.live_caddy, good=(GOOD_CADDY, newer), signal_ok=False)
            with patch.object(deploy, 'command', side_effect=fake), \
                    contextlib.redirect_stdout(io.StringIO()), \
                    self.assertRaisesRegex(RuntimeError, 'fixture reload failure'):
                obj.reload()
            self.assertEqual(obj.live_caddy.read_bytes(), GOOD_CADDY)
            self.assertTrue(obj.degraded_path.exists())

    def test_public_mcp_route_requires_one_web_block_and_catch_all_proxy(self):
        for source in ['reverse_proxy {\n}\n', '{$WEB_DOMAIN} {\nreverse_proxy web:3000\n}\n']:
            with self.subTest(source=source), self.assertRaises(ValueError):
                deploy.install_public_mcp_route(source, 'public-mcp-proxy-new')

    def test_verify_public_mcp_handshake_propagates_session_and_requires_tools(self):
        obj = object.__new__(deploy.Deployment)
        obj.config = {'local_origin': 'http://127.0.0.1:80',
                      'public_mcp_host': 'opennavo.com', 'checks': []}
        responses = []

        class Response(io.BytesIO):
            status = 200
            def __init__(self, body, session=None):
                super().__init__(body)
                self.headers = {'Mcp-Session-Id': session} if session else {}

        def urlopen(request, timeout):
            responses.append(request)
            if len(responses) == 1:
                return Response(b'{"result":{"protocolVersion":"2025-06-18"}}', 'session-1')
            return Response(b'{"result":{"tools":[{"name":"search_apps"}]}}')

        with patch.object(deploy.urllib.request, 'urlopen', side_effect=urlopen):
            obj.verify_public_mcp()
        self.assertEqual(responses[0].get_header('Host'), 'opennavo.com')
        self.assertEqual(responses[1].get_header('Mcp-session-id'), 'session-1')
        self.assertEqual(responses[0].get_header('Accept'), 'application/json, text/event-stream')

        with patch.object(deploy.urllib.request, 'urlopen', side_effect=[
                Response(b'{"result":{}}'), Response(b'{"result":{"tools":[]}}')]):
            with self.assertRaisesRegex(RuntimeError, 'no tools'):
                obj.verify_public_mcp()

    def test_monitoring_targets_preserves_other_jobs_and_follows_release_and_rollback(self):
        source = """global:
  scrape_interval: 15s
rule_files: [/etc/prometheus/rules.yml]
scrape_configs:
  - job_name: api
    static_configs:
      - targets: ['api_old:9090']
  - job_name: custom
    static_configs:
      - targets: ['custom:1234']
        labels: {purpose: custom}
"""
        after = deploy.monitoring_targets(source, {'api': 'api_new', 'web': 'web_new'})
        self.assertIn("targets: ['api_new:9090']", after)
        self.assertIn('dns_sd_configs:', after)
        self.assertIn('names: [web_new]', after)
        self.assertIn("targets: ['custom:1234']\n        labels: {purpose: custom}", after)
        self.assertEqual(after.count('job_name: web'), 1)
        self.assertEqual(deploy.monitoring_targets(after, {'api': 'api_new', 'web': 'web_new'}), after)
        restored = deploy.monitoring_targets(after, {'api': 'api_old', 'web': 'web_old'})
        self.assertNotIn('api_new', restored)
        self.assertIn('names: [web_old]', restored)
        with self.assertRaises(ValueError):
            deploy.monitoring_targets(source.replace('    static_configs:', '    relabel_configs:', 1), {'api': 'a', 'web': 'b'})
        with self.assertRaises(ValueError):
            deploy.monitoring_targets(source, {'api': 'a\nmalicious', 'web': 'b'})

    def test_monitoring_health_checks_dns_identity_and_all_replicas(self):
        def target(job, service, ip, health='up', dns=True):
            port = 9090 if job == 'api' else 9091
            return {'labels': {'job': job}, 'health': health,
                    'discoveredLabels': {'job': job, '__meta_dns_name': service} if dns else {'job': job},
                    'scrapeUrl': f'http://{ip if dns else service}:{port}/metrics'}

        good = [target('api', 'api_new', '172.20.0.2'), target('web', 'web_new', '172.20.0.3')]
        cases = [
            ('dns IP targets', good, 0),
            ('static targets', [target('api', 'api_new', '', dns=False), target('web', 'web_new', '', dns=False)], 0),
            ('multiple replicas', good + [target('web', 'web_new', '172.20.0.4')], 0),
            ('unhealthy replica', good + [target('web', 'web_new', '172.20.0.4', 'down')], 1),
            ('old release', [target('api', 'api_old', '172.20.0.2'), good[1]], 1),
            ('missing job', good[:1], 1),
            ('stale replica', good + [target('web', 'web_old', '172.20.0.4')], 1),
            ('static unhealthy replica', [target('api', 'api_new', '', dns=False),
                                          target('web', 'web_new', '', dns=False),
                                          target('web', 'web_new', '', 'down', dns=False)], 1),
            ('wrong port', [dict(good[0], scrapeUrl='http://172.20.0.2:9091/metrics'), good[1]], 1),
        ]
        for name, targets, expected in cases:
            with self.subTest(name=name):
                # Execute the actual deployed Node script; only HTTP and retry timing are replaced.
                prelude = ('globalThis.fetch = async () => ({json: async () => (' +
                           json.dumps({'status': 'success', 'data': {'activeTargets': targets}}) +
                           ')}); globalThis.setTimeout = (callback) => { callback(); };\n')
                result = subprocess.run(['node', '--input-type=module', '-e', prelude + deploy.MONITORING_HEALTH_SCRIPT,
                                         json.dumps({'api': 'api_new:9090', 'web': 'web_new:9091'})],
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, expected, result.stderr)

    def test_candidate_warmup_records_retired_statuses_but_rejects_server_failures(self):
        prelude = """
let calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  const status = calls <= 2 ? (calls === 1 ? 404 : 410) : 200;
  return { status, arrayBuffer: async () => new ArrayBuffer(0) };
};
globalThis.setTimeout = callback => { callback(); };
"""
        result = subprocess.run(
            ['node', '--input-type=module', '-e', prelude + deploy.WARM_SCRIPT,
             json.dumps(['/apps/retired']), deploy.WARM_ORIGIN, deploy.WARM_HOST, deploy.WARM_INTERNAL_ORIGIN],
            capture_output=True, text=True, timeout=10
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('status=404', result.stdout)
        self.assertIn('status=410', result.stdout)
        failure = subprocess.run(
            ['node', '--input-type=module', '-e',
             "globalThis.fetch = async () => ({status: 503, arrayBuffer: async () => new ArrayBuffer(0)});" + deploy.WARM_SCRIPT,
             json.dumps(['/apps/broken']), deploy.WARM_ORIGIN, deploy.WARM_HOST, deploy.WARM_INTERNAL_ORIGIN],
            capture_output=True, text=True, timeout=10
        )
        self.assertEqual(failure.returncode, 1)

    def test_drain_script_falls_back_to_the_existing_load_shed_metric(self):
        script = """
globalThis.fetch = async () => ({ ok: true, text: async () => '# HELP opennavo_web_in_flight\\nopennavo_web_in_flight 0\\n' });
""" + deploy.DRAIN_SCRIPT
        result = subprocess.run(
            ['node', '--input-type=module', '-e', script, deploy.WARM_INTERNAL_ORIGIN],
            capture_output=True, text=True, timeout=10
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), '0')

    def test_monitoring_default_dns_config_release_and_rollback(self):
        source = Path(__file__).with_name('prometheus').joinpath('prometheus.yml').read_text()
        after = deploy.monitoring_targets(source, {'api': 'api_new', 'web': 'web_new'})
        expected = source.replace('names: [api]', 'names: [api_new]').replace('names: [web]', 'names: [web_new]')
        self.assertEqual(after, expected)
        self.assertEqual(deploy.monitoring_targets(after, {'api': 'api_new', 'web': 'web_new'}), after)
        self.assertEqual(deploy.monitoring_targets(after, {'api': 'api', 'web': 'web'}), source)

    def test_monitoring_validation_or_scrape_failure_restores_config_without_leaking_it(self):
        for failure in ['validate', 'scrape', None]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as root:
                directory = Path(root)
                config = directory / 'prometheus.yml'
                original = "global:\n  scrape_interval: 15s\nscrape_configs:\n  - job_name: api\n    static_configs:\n      - targets: ['api_old:9090']\n"
                config.write_text(original)
                inode = config.stat().st_ino
                obj = object.__new__(deploy.Deployment)
                obj.directory, obj.config = directory, {'project': 'example-prod'}
                def command(args):
                    if args[1] == 'ps': return 'monitor'
                    if args[1] == 'inspect':
                        return json.dumps([{'Mounts': [{'Source': str(config), 'Destination': '/etc/prometheus/prometheus.yml', 'Type': 'bind'}]}])
                    if 'promtool' in args:
                        self.assertIn('names: [web_new]', config.read_text())
                        if failure == 'validate': raise RuntimeError('validation failed')
                    if 'node' in args and failure == 'scrape': raise RuntimeError('scrape failed')
                    return ''
                with patch.object(deploy, 'command', side_effect=command) as run:
                    if failure:
                        with self.assertRaises(RuntimeError):
                            obj.update_monitoring({'api': 'api_new', 'web': 'web_new'})
                        self.assertEqual(config.read_text(), original)
                    else:
                        obj.update_monitoring({'api': 'api_new', 'web': 'web_new'})
                        self.assertIn('names: [web_new]', config.read_text())
                        self.assertTrue(any('node' in call.args[0] for call in run.call_args_list))
                    self.assertEqual(config.stat().st_ino, inode)
                    self.assertEqual((directory / 'before-prometheus.yml').read_text(), original)
                    self.assertTrue(any(call.args[0][:3] == ['docker', 'kill', '--signal=HUP'] for call in run.call_args_list))

    def test_cleanup_stops_previous_release_and_removes_only_older_app_containers(self):
        obj = object.__new__(deploy.Deployment)
        obj.config = {'project': 'example-prod'}
        obj.services = {kind: kind + '_new' for kind in ['api', 'web', 'mcp', 'admin']}
        previous = {'services': {kind: kind + '_previous' for kind in obj.services}}
        def container(service, running=True, project='example-prod'):
            return {'Id': service, 'State': {'Running': running}, 'Config': {'Labels': {
                'com.docker.compose.project': project, 'com.docker.compose.service': service}}}
        containers = [container(s) for s in obj.services.values()]
        containers += [container(s) for s in previous['services'].values()]
        containers += [container('api_older'), container('web_ancient', False), container('api')]
        containers += [container(s) for s in ['worker', 'postgres', 'redis', 'web-cache', 'minio', 'caddy', 'prometheus']]
        containers += [container('api_foreign', project='other-project')]
        def cmd(args):
            if args[1] == 'ps': return '\n'.join(c['Id'] for c in containers)
            if args[1] == 'inspect': return json.dumps(containers)
            if args[1] == 'exec': return '0'
            return ''
        with patch.object(deploy, 'command', side_effect=cmd) as run:
            obj.cleanup(previous)
        mutations = [call.args[0] for call in run.call_args_list if call.args[0][1] in ['stop', 'rm']]
        self.assertEqual(mutations, [
            ['docker', 'stop', '--timeout', '90', *previous['services'].values(), 'api_older', 'api'],
            ['docker', 'rm', 'api_older', 'web_ancient', 'api']])

    def test_cleanup_does_not_remove_containers_if_stop_fails(self):
        obj = object.__new__(deploy.Deployment)
        obj.config = {'project': 'example-prod'}
        obj.services = {'api': 'api_new'}
        containers = [{'Id': 'old', 'State': {'Running': True}, 'Config': {'Labels': {
            'com.docker.compose.project': 'example-prod', 'com.docker.compose.service': 'api_old'}}}]
        with patch.object(deploy, 'command', side_effect=['old', json.dumps(containers), RuntimeError('stop failed')]) as run:
            with self.assertRaises(RuntimeError): obj.cleanup({})
        self.assertFalse(any(call.args[0][1] == 'rm' for call in run.call_args_list))

    def test_cleanup_stops_undrained_containers_by_default(self):
        obj = object.__new__(deploy.Deployment)
        obj.config = {'project': 'example-prod'}
        obj.services = {'api': 'api_new', 'web': 'web_new', 'mcp': 'mcp_new', 'admin': 'admin_new'}
        containers = [{
            'Id': 'web_old', 'State': {'Running': True},
            'Config': {'Labels': {'com.docker.compose.project': 'example-prod', 'com.docker.compose.service': 'web_old'}}
        }]
        def command(args):
            if args[1] == 'ps': return 'web_old'
            if args[1] == 'inspect': return json.dumps(containers)
            if args[1] == 'exec': raise RuntimeError('old metric unavailable')
            return ''
        with patch.object(deploy, 'command', side_effect=command) as run, contextlib.redirect_stdout(io.StringIO()) as output:
            obj.cleanup({})
        self.assertTrue(any(call.args[0] == ['docker', 'stop', '--timeout', '90', 'web_old']
                            for call in run.call_args_list))
        self.assertIn('stopping retired containers', output.getvalue())

    def test_cleanup_can_retain_undrained_containers_only_when_explicitly_configured(self):
        obj = object.__new__(deploy.Deployment)
        obj.config = {'project': 'example-prod', 'retain_undrained_containers': True}
        obj.services = {'api': 'api_new', 'web': 'web_new', 'mcp': 'mcp_new', 'admin': 'admin_new'}
        containers = [{
            'Id': 'web_old', 'State': {'Running': True},
            'Config': {'Labels': {'com.docker.compose.project': 'example-prod', 'com.docker.compose.service': 'web_old'}}
        }]
        def command(args):
            if args[1] == 'ps': return 'web_old'
            if args[1] == 'inspect': return json.dumps(containers)
            if args[1] == 'exec': raise RuntimeError('old metric unavailable')
            return ''
        with patch.object(deploy, 'command', side_effect=command) as run:
            obj.cleanup({})
        self.assertFalse(any(call.args[0][1] in ('stop', 'rm') for call in run.call_args_list))

    def test_rollback_stops_undrained_candidates_by_default(self):
        for sha in ['c' * 40, None]:
            with self.subTest(sha=sha):
                self.check_rollback_stops_undrained_candidates(sha)

    def check_rollback_stops_undrained_candidates(self, sha):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            obj = object.__new__(deploy.Deployment)
            obj.config = {'project': 'example-prod'}
            obj.state = {'services': {k: k + '_previous' for k in ['api', 'web', 'admin', 'mcp']}}
            if sha is not None:
                obj.state['sha'] = sha
            obj.services = {k: k + '_new' for k in ['api', 'web', 'admin', 'mcp']}
            obj.directory = directory
            obj.live_caddy = directory / 'live'
            obj.env = directory / 'env'
            obj.rolling = directory / 'rolling'
            obj.live_caddy.write_text('candidate')
            for name in ['before-caddy', 'before-release.env', 'before-rolling.json']:
                (directory / name).write_text('old')
            events = []
            obj.compose = lambda *args, **kwargs: events.append(args)
            obj.reload = lambda: events.append('reload')
            obj.verify = lambda expected=None: events.append(('verify', expected))
            obj.update_monitoring = lambda services: events.append('monitoring')
            obj.drain_retired = lambda *args, **kwargs: False
            with patch.object(deploy, 'command', return_value='candidate'):
                obj.rollback()
            self.assertIn(('verify', sha[:12] if sha else ''), events)
            self.assertIn(('stop', '--timeout', '90', *obj.services.values()), events)

    def test_failed_old_service_start_restores_candidate_config_and_reports_degraded(self):
        for promoted in [False, True]:
            with self.subTest(promoted=promoted), tempfile.TemporaryDirectory() as root:
                obj, _ = prepare_on_host(root, {})
                candidate_env = (obj.directory / 'release.env').read_bytes()
                candidate_rolling = (obj.directory / 'rolling.compose.json').read_bytes()
                if promoted:
                    obj.env.write_bytes(candidate_env)
                    obj.rolling.write_bytes(candidate_rolling)
                obj.live_caddy.write_text('candidate route')
                before_state = obj.state_path.read_bytes()

                def fail_old_start(*args, **kwargs):
                    self.assertEqual(obj.env.read_bytes(), (obj.directory / 'before-release.env').read_bytes())
                    self.assertEqual(obj.rolling.read_bytes(), (obj.directory / 'before-rolling.json').read_bytes())
                    self.assertFalse(kwargs['candidate'])
                    raise RuntimeError('old services unavailable')

                obj.compose = unittest.mock.Mock(side_effect=fail_old_start)
                obj.reload = unittest.mock.Mock()
                obj.verify = unittest.mock.Mock()
                obj.update_monitoring = unittest.mock.Mock()
                obj.drain_retired = unittest.mock.Mock()
                with contextlib.redirect_stdout(io.StringIO()) as output, \
                        patch.object(deploy, 'command') as run, \
                        self.assertRaisesRegex(RuntimeError, 'degraded rollback'):
                    obj.rollback()

                self.assertEqual(obj.env.read_bytes(), candidate_env)
                self.assertEqual(obj.rolling.read_bytes(), candidate_rolling)
                self.assertEqual(obj.live_caddy.read_text(), 'candidate route')
                self.assertEqual(obj.state_path.read_bytes(), before_state)
                self.assertIn('DEGRADED', output.getvalue())
                self.assertIn('routing unconfirmed', output.getvalue())
                self.assertNotIn('Caddy still routes to the candidate', output.getvalue())
                marker = json.loads(obj.degraded_path.read_text())
                self.assertEqual(marker['release'], obj.release)
                self.assertEqual(marker['sha'], obj.payload['sha'])
                self.assertIn('previous services failed to start', marker['reason'])
                self.assertEqual(obj.degraded_path.stat().st_mode & 0o777, 0o600)
                obj.compose.assert_called_once_with(
                    'up', '-d', '--no-deps', '--wait', '--wait-timeout', '240',
                    *obj.state['services'].values(), 'worker', candidate=False)
                for mock in [obj.reload, obj.verify, obj.update_monitoring, obj.drain_retired, run]:
                    mock.assert_not_called()

                # A new receiver process must reject the next deployment without touching Docker.
                retry = deploy.Deployment(obj.config, payload())
                with patch.object(deploy, 'command') as run, \
                        self.assertRaisesRegex(RuntimeError, 'Manual intervention required') as failure:
                    retry.apply(archive())
                self.assertIn(f'remove {obj.degraded_path}', str(failure.exception))
                run.assert_not_called()

    def test_degraded_marker_blocks_new_deploys_and_same_sha_retries_until_manually_removed(self):
        for same_sha in [False, True]:
            for content in ['', 'not valid JSON', '{"reason":"routing unconfirmed"}']:
                with self.subTest(same_sha=same_sha, content=content), tempfile.TemporaryDirectory() as root:
                    obj, _ = prepare_on_host(root, {})
                    if same_sha:
                        obj.state['sha'] = obj.payload['sha']
                        deploy.write_private(obj.state_path, obj.state)
                    obj.degraded_path.write_text(content)
                    retry = deploy.Deployment(obj.config, payload())
                    with patch.object(retry, 'capacity_gate', side_effect=RuntimeError('deployment resumed')) as capacity, \
                            patch.object(retry, 'verify', side_effect=RuntimeError('deployment resumed')) as verify, \
                            patch.object(retry, 'prepare') as prepare, \
                            patch.object(retry, 'cleanup') as cleanup, \
                            patch.object(deploy, 'command') as run:
                        with self.assertRaisesRegex(RuntimeError, 'Manual intervention required') as failure:
                            retry.apply(archive())
                        self.assertIn(f'remove {obj.degraded_path}', str(failure.exception))
                        self.assertEqual(obj.degraded_path.read_text(), content)
                        for mock in [capacity, verify, prepare, cleanup, run]:
                            mock.assert_not_called()
                        obj.degraded_path.unlink()
                        with self.assertRaisesRegex(RuntimeError, 'deployment resumed'):
                            retry.apply(archive())
                        (verify if same_sha else capacity).assert_called_once_with()

    def test_caddy_reload_failure_marks_routing_unconfirmed_and_blocks_next_deploy(self):
        for fail_validation in [False, True]:
            with self.subTest(fail_validation=fail_validation), tempfile.TemporaryDirectory() as root:
                obj, _ = prepare_on_host(root, {})
                obj.config['caddy_container'] = 'fixture-caddy'
                error = RuntimeError('fixture Caddy failure')
                # Invalid live file (caddy exit 1, caddy runnable) with no backup, or a failed signal.
                commands = ([RuntimeError('command failed: docker (exit 1); inspect privately on host'), '']
                            if fail_validation else ['', error])
                with patch.object(deploy, 'command', side_effect=commands), \
                        contextlib.redirect_stdout(io.StringIO()) as output, \
                        self.assertRaisesRegex(RuntimeError, 'Live Caddyfile validation failed'
                                               if fail_validation else 'fixture Caddy failure'):
                    obj.reload()
                self.assertIn('routing unconfirmed', output.getvalue())
                self.assertNotIn('Caddy still routes to the candidate', output.getvalue())
                self.assertFalse(hasattr(obj, 'switch_at'))
                self.assertEqual(json.loads(obj.degraded_path.read_text())['reason'],
                                 'Caddy reload failed; routing unconfirmed')
                retry = deploy.Deployment(obj.config, payload())
                with patch.object(deploy, 'command') as run, \
                        self.assertRaisesRegex(RuntimeError, 'Manual intervention required'):
                    retry.apply(archive())
                run.assert_not_called()

    def test_rollback_caddy_reload_failure_retains_candidates_and_requires_manual_recovery(self):
        with tempfile.TemporaryDirectory() as root:
            obj, _ = prepare_on_host(root, {})
            obj.config['caddy_container'] = 'fixture-caddy'
            obj.compose = unittest.mock.Mock()
            obj.verify = unittest.mock.Mock()
            obj.update_monitoring = unittest.mock.Mock()
            obj.drain_retired = unittest.mock.Mock()
            with patch.object(deploy, 'command', side_effect=['', RuntimeError('fixture Caddy failure')]), \
                    contextlib.redirect_stdout(io.StringIO()) as output, \
                    self.assertRaisesRegex(RuntimeError, 'fixture Caddy failure'):
                obj.rollback()
            self.assertIn('routing unconfirmed', output.getvalue())
            self.assertTrue(obj.degraded_path.exists())
            obj.compose.assert_called_once_with(
                'up', '-d', '--no-deps', '--wait', '--wait-timeout', '240',
                *obj.state['services'].values(), 'worker', candidate=False)
            for mock in [obj.verify, obj.update_monitoring, obj.drain_retired]:
                mock.assert_not_called()

    def test_failed_forward_reload_allows_next_deploy_after_verified_rollback(self):
        for forward_failure in ['validate', 'signal']:
            with self.subTest(forward_failure=forward_failure):
                self.check_forward_reload_recovery(forward_failure)

    def test_failed_forward_reload_keeps_marker_when_rollback_cannot_confirm_recovery(self):
        for forward_failure in ['validate', 'signal']:
            for rollback_failure in ['validate', 'signal', 'verify']:
                with self.subTest(forward_failure=forward_failure, rollback_failure=rollback_failure):
                    self.check_forward_reload_recovery(forward_failure, rollback_failure)

    def check_forward_reload_recovery(self, forward_failure, rollback_failure=None):
        with tempfile.TemporaryDirectory() as root:
            obj, _ = prepare_on_host(root, {})
            obj.config['caddy_container'] = 'fixture-caddy'
            obj.state['sha'] = 'c' * 40
            deploy.write_private(obj.state_path, obj.state)
            before_state = obj.state_path.read_bytes()
            before_caddy = (obj.directory / 'before-caddy').read_bytes()
            (obj.directory / 'Caddyfile.next').write_text('candidate route')

            def stub_host_steps(target):
                for name in ['capacity_gate', 'backup', 'compose', 'warm_candidates', 'verify',
                             'update_monitoring', 'cleanup', 'prune']:
                    setattr(target, name, unittest.mock.Mock())
                target.drain_retired = unittest.mock.Mock(return_value=True)
                # This test injects failures into reload, after staged validation succeeds.
                target.install_caddy = lambda content: deploy.write_caddy_in_place(target.live_caddy, content)
                target.verify_public_mcp = unittest.mock.Mock()

            stub_host_steps(obj)
            # The fixture has already prepared this run's release and rollback snapshots.
            obj.prepare = unittest.mock.Mock()

            def verify_rollback(expected=None):
                self.assertEqual(expected, obj.state['sha'][:12])
                self.assertEqual(obj.live_caddy.read_bytes(), before_caddy)
                self.assertTrue(obj.degraded_path.exists())
                if rollback_failure == 'verify':
                    raise RuntimeError('rollback verify failed')

            obj.verify.side_effect = verify_rollback
            reload_attempt = 0
            starting_deploy = True

            def command(args):
                nonlocal reload_attempt, starting_deploy
                if args[:3] == ['docker', 'network', 'inspect']:
                    return json.dumps([{'Containers': {}}])
                if args[:3] == ['docker', 'image', 'inspect']:
                    return json.dumps({'org.opencontainers.image.revision': obj.payload['sha']})
                if args[:2] == ['docker', 'create']:
                    return 'fixture-container'
                step = None
                if 'validate' in args:
                    if starting_deploy:
                        starting_deploy = False
                        return ''
                    reload_attempt += 1
                    step = 'validate'
                    if reload_attempt == 2:
                        self.assertEqual(obj.live_caddy.read_bytes(), before_caddy)
                        self.assertTrue(obj.degraded_path.exists())
                        obj.compose.assert_called_with(
                            'up', '-d', '--no-deps', '--wait', '--wait-timeout', '240',
                            *obj.state['services'].values(), 'worker', candidate=False)
                elif '--signal=USR1' in args:
                    step = 'signal'
                if step and reload_attempt == 1 and step == forward_failure:
                    raise RuntimeError('forward ' + step + ' failed')
                if step and reload_attempt == 2 and step == rollback_failure:
                    raise RuntimeError('rollback ' + step + ' failed')
                return ''

            with patch.object(deploy, 'command', side_effect=command), \
                    contextlib.redirect_stdout(io.StringIO()):
                failure = 'rollback ' + rollback_failure if rollback_failure else 'forward ' + forward_failure
                error = 'Live Caddyfile validation failed' if failure.endswith('validate') else failure + ' failed'
                with self.assertRaisesRegex(RuntimeError, error):
                    obj.apply(archive())
                self.assertEqual(reload_attempt, 2)
                self.assertEqual(obj.state_path.read_bytes(), before_state)
                self.assertEqual(obj.live_caddy.read_bytes(), before_caddy)
                obj.cleanup.assert_not_called()
                obj.prune.assert_not_called()

                next_payload = {**payload(), 'run_id': '124'}
                retry = deploy.Deployment(obj.config, next_payload)
                stub_host_steps(retry)
                if rollback_failure:
                    self.assertTrue(obj.degraded_path.exists())
                    obj.drain_retired.assert_not_called()
                    with self.assertRaisesRegex(RuntimeError, 'Manual intervention required'):
                        retry.apply(archive())
                    retry.capacity_gate.assert_not_called()
                    retry.compose.assert_not_called()
                else:
                    self.assertFalse(obj.degraded_path.exists())
                    obj.verify.assert_called_once_with(expected=obj.state['sha'][:12])
                    obj.update_monitoring.assert_called_once_with(obj.state['services'])
                    starting_deploy = True
                    retry.apply(archive())
                    self.assertEqual(reload_attempt, 3)
                    self.assertEqual(json.loads(retry.state_path.read_text())['release'], retry.release)
                    retry.capacity_gate.assert_called_once_with()
                    retry.cleanup.assert_called_once()
                    retry.prune.assert_called_once()

    def test_verify_checks_legacy_routes_without_sha_and_requires_known_release_headers(self):
        obj = object.__new__(deploy.Deployment)
        obj.payload = payload()
        obj.config = {'local_origin': 'https://example.org', 'checks': [{'path': '/', 'host': 'example.org'}]}
        cases = [('', 200, '', True), ('', 503, '', False),
                 (None, 200, 'a' * 12, True), (None, 200, '', False),
                 ('c' * 12, 200, 'a' * 12, False)]
        for expected, status, header, success in cases:
            with self.subTest(expected=expected, status=status, header=header):
                def response(*args, **kwargs):
                    body = io.BytesIO(b'healthy route')
                    body.status = status
                    body.headers = {'X-OpenNavo-Release': header}
                    return body
                with patch.object(deploy.urllib.request, 'urlopen', side_effect=response), \
                        patch.object(deploy.time, 'sleep'):
                    if success:
                        obj.verify(expected=expected)
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'post-deployment route checks failed'):
                            obj.verify(expected=expected)

    def test_same_sha_short_circuit_skips_capacity_gate(self):
        obj = object.__new__(deploy.Deployment)
        obj.root = Path('/fixture')
        obj.payload = payload()
        obj.state = {'sha': obj.payload['sha'], 'services': {'api': 'api_live', 'web': 'web_live'}}
        events = []
        obj.validate_live_caddy = lambda: events.append('validate live Caddy')
        obj.verify = lambda: events.append('verify')
        obj.update_monitoring = lambda services: events.append('monitoring')
        obj.cleanup = lambda previous: events.append('cleanup')
        obj.prune = lambda previous: events.append('prune')
        obj.capacity_gate = lambda: (_ for _ in ()).throw(AssertionError('short circuit must skip capacity'))
        obj.apply(archive())
        self.assertEqual(events, ['validate live Caddy', 'verify', 'monitoring', 'cleanup', 'prune'])

    def test_drain_timeout_warns_and_reports_failure(self):
        obj = object.__new__(deploy.Deployment)
        obj.config = {'project': 'example-prod'}
        obj.switch_at = None
        containers = [{
            'Id': 'old-web', 'State': {'Running': True},
            'Config': {'Labels': {'com.docker.compose.service': 'web_old'}}
        }]
        with patch.object(deploy, 'command', return_value='1'), \
                patch.object(deploy.time, 'monotonic', side_effect=[0, 0, 3]), \
                patch.object(deploy.time, 'sleep'), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertFalse(obj.drain_retired(containers, timeout=2))
        self.assertIn('drain timed out', output.getvalue())

    def test_retry_verifies_existing_release_before_resuming_cleanup(self):
        obj = object.__new__(deploy.Deployment)
        obj.root = Path('/fixture')
        obj.payload = payload()
        previous = {'services': {'api': 'api_previous'}}
        obj.state = {'sha': obj.payload['sha'], 'services': {'api': 'api_live'}, 'previous': previous}
        events = []
        obj.validate_live_caddy = lambda: events.append('validate live Caddy')
        obj.verify = lambda: events.append('verify')
        obj.update_monitoring = lambda services: events.append('monitoring')
        obj.cleanup = lambda state: events.append(('cleanup', state))
        obj.prune = lambda state: events.append(('prune', state))
        obj.apply(archive())
        self.assertEqual(obj.services, obj.state['services'])
        self.assertEqual(events, ['validate live Caddy', 'verify', 'monitoring', ('cleanup', previous), ('prune', previous)])

    def test_retry_continues_when_live_release_directory_is_missing(self):
        with tempfile.TemporaryDirectory() as root:
            obj = object.__new__(deploy.Deployment)
            obj.root = Path(root)
            obj.payload = payload()
            previous = {'services': {'api': 'api_previous'}}
            obj.state = {
                'sha': obj.payload['sha'],
                'release': 'missing-release',
                'services': {'api': 'api_live'},
                'previous': previous,
            }
            events = []
            obj.validate_live_caddy = lambda: events.append('validate live Caddy')
            obj.verify = lambda: events.append('verify')
            obj.update_monitoring = lambda services: events.append('monitoring')
            obj.cleanup = lambda state: events.append(('cleanup', state))
            obj.prune = lambda state: events.append(('prune', state))
            with patch('builtins.print') as output:
                obj.apply(archive())

            self.assertEqual(events, ['validate live Caddy', 'verify', 'monitoring', ('cleanup', previous), ('prune', previous)])
            output.assert_any_call('Live release manifest repair skipped; continuing deployment.', flush=True)

    def test_retry_rebuilds_a_missing_live_manifest_without_sensitive_fields(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            release = root / 'releases/live'
            (release / 'web-assets').mkdir(parents=True)
            (release / 'web-assets/live.js').write_text('live')
            obj = object.__new__(deploy.Deployment)
            obj.root = root
            obj.payload = {**payload(), 'registry_token': 'secret-token', 'admin_archive': 'secret-archive'}
            obj.state = {'sha': obj.payload['sha'], 'release': 'live', 'services': {'api': 'api_live'}}
            obj.validate_live_caddy = unittest.mock.Mock()
            obj.verify = lambda: None
            obj.update_monitoring = lambda services: None
            obj.cleanup = lambda state: None
            obj.prune = lambda state: None

            obj.apply(archive())

            obj.validate_live_caddy.assert_called_once_with()
            manifest = json.loads((release / 'manifest.json').read_text())
            self.assertEqual(manifest['web_assets'], ['live.js'])
            self.assertNotIn('registry_token', manifest)
            self.assertNotIn('admin_archive', manifest)

    def test_prune_keeps_recent_live_previous_and_mounted_release_snapshots(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            releases = Path(root) / 'releases'
            releases.mkdir()
            names = [f'gh-{index:012x}-100-1' for index in range(9)]
            for index, name in enumerate(names):
                (releases / name).mkdir()
                (releases / name / 'before-migration.dump').write_text('dump')
                os.utime(releases / name, (1_000_000 + index, 1_000_000 + index))
            # Manual snapshots and other files are operator-owned and never pruned.
            (releases / 'main-abc1234-20261007').mkdir()
            (releases / 'privacy-build.tar.gz').write_text('manual')
            for name in ['main-abc1234-20261007', 'privacy-build.tar.gz']:
                os.utime(releases / name, (1, 1))
            (releases / 'gh-00000000000f-1-1').symlink_to(outside, target_is_directory=True)
            obj = object.__new__(deploy.Deployment)
            obj.config, obj.root = {}, Path(root)
            obj.release, obj.state = names[8], {'release': names[7]}
            containers = [{'Image': 'x', 'Mounts': [{'Source': str(releases / names[2] / 'admin')}]}]
            with contextlib.redirect_stdout(io.StringIO()):
                obj.prune_releases({'release': names[1]}, containers)
            remaining = sorted(path.name for path in releases.iterdir())
            self.assertEqual(remaining, sorted([*names[4:], names[1], names[2], 'main-abc1234-20261007',
                                                'privacy-build.tar.gz', 'gh-00000000000f-1-1']))
            self.assertTrue(Path(outside).is_dir())

    def test_prune_removes_only_unused_application_images(self):
        obj = object.__new__(deploy.Deployment)
        obj.config = {'registry': 'ghcr.io/example', 'project': 'fixture', 'compose_file': 'compose.yml'}
        obj.root, obj.release, obj.state, obj.payload = Path('/fixture'), 'gh-current', {}, payload()
        image = {name: 'sha256:' + name * 64 for name in 'abcde'}
        listed = {'server': [image['a'], image['c']], 'web': [image['b'], image['d'], image['d']], 'mcp': [image['e']]}
        def cmd(args):
            if args[:3] == ['docker', 'image', 'ls']:
                return '\n'.join(listed[args[-1].rsplit('-', 1)[1]])
            if args[-1] == image['d']:
                raise RuntimeError('command failed: docker (exit 1); inspect privately on host')
            return ''
        with patch.object(deploy, 'command', side_effect=cmd) as run, contextlib.redirect_stdout(io.StringIO()):
            obj.prune_images([{'Image': image['a']}, {'Image': image['b']}])
        removed = [call.args[0][-1] for call in run.call_args_list if call.args[0][:3] == ['docker', 'image', 'rm']]
        self.assertEqual(removed, [image['c'], image['d'], image['e']])

    def test_prune_protects_worker_hotfix_and_resolves_retry_snapshot(self):
        for retry in [False, True]:
            with self.subTest(retry=retry):
                obj = object.__new__(deploy.Deployment)
                obj.config = {'registry': 'ghcr.io/example', 'project': 'fixture', 'compose_file': 'compose.yml'}
                obj.root, obj.release, obj.payload = Path('/fixture'), 'gh-candidate', payload()
                obj.state = {'sha': obj.payload['sha'], 'release': 'gh-live'} if retry else {}
                hotfix, unused = 'sha256:' + 'c' * 64, 'sha256:' + 'd' * 64
                def cmd(args):
                    if args[1] == 'compose': return 'ghcr.io/example/opennavo-server:worker-hotfix'
                    if args[:3] == ['docker', 'image', 'inspect']: return hotfix
                    if args[:3] == ['docker', 'image', 'ls']: return hotfix + '\n' + unused
                    return ''
                with patch.object(deploy, 'command', side_effect=cmd) as run, contextlib.redirect_stdout(io.StringIO()):
                    obj.prune_images([])
                compose = run.call_args_list[0].args[0]
                snapshot = 'gh-live' if retry else 'gh-candidate'
                self.assertIn('/fixture/releases/' + snapshot + '/before-rolling.json', compose)
                self.assertIn('/fixture/releases/' + snapshot + '/before-release.env', compose)
                removed = [call.args[0][-1] for call in run.call_args_list if call.args[0][:3] == ['docker', 'image', 'rm']]
                self.assertNotIn(hotfix, removed)
                self.assertIn(unused, removed)
                with patch.object(deploy, 'command', side_effect=['missing-image', RuntimeError('lookup failed')]) as run:
                    with self.assertRaises(RuntimeError): obj.prune_images([])
                self.assertFalse(any(call.args[0][:3] == ['docker', 'image', 'rm'] for call in run.call_args_list))

    def test_prune_failures_never_fail_a_verified_release(self):
        obj = object.__new__(deploy.Deployment)
        output = io.StringIO()
        with patch.object(deploy, 'command', side_effect=RuntimeError('command failed: docker (exit 1)')), \
                contextlib.redirect_stdout(output):
            obj.prune({})
        self.assertIn('Retention cleanup incomplete', output.getvalue())

    def test_accepts_only_complete_digest_pinned_release(self):
        body = payload()
        self.assertEqual(deploy.validate(body, 'ghcr.io/example'), archive())
        for key, value in [('sha', '../secret'), ('run_id', '1;id')]:
            with self.assertRaises(ValueError):
                deploy.validate({**body, key: value}, 'ghcr.io/example')
        for value in ['ghcr.io/example/opennavo-web:latest', 'ghcr.io/other/opennavo-web@sha256:' + 'b' * 64]:
            body['images']['web'] = value
            with self.assertRaises(ValueError):
                deploy.validate(body, 'ghcr.io/example')

    def test_checksum_and_missing_image_fail_before_deployment(self):
        body = payload()
        body['admin_sha256'] = '0' * 64
        with self.assertRaises(ValueError): deploy.validate(body, 'ghcr.io/example')
        body = payload()
        del body['images']['mcp']
        with self.assertRaises(ValueError): deploy.validate(body, 'ghcr.io/example')

    def test_rejects_archive_traversal_and_links(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('/etc/escape', tarfile.REGTYPE), ('link', tarfile.SYMTYPE)]:
            with tempfile.TemporaryDirectory() as root, self.assertRaises(ValueError):
                deploy.extract_admin(archive(name, kind), Path(root))

    def test_extracts_static_admin_and_requires_index(self):
        with tempfile.TemporaryDirectory() as root:
            deploy.extract_admin(archive(), Path(root))
            self.assertTrue((Path(root) / 'index.html').is_file())
        with tempfile.TemporaryDirectory() as root, self.assertRaises(ValueError):
            deploy.extract_admin(archive('other.txt'), Path(root))

    def test_environment_update_preserves_unrelated_secrets(self):
        self.assertEqual(deploy.update_env('SERVER_IMAGE=old\nPRIVATE=value\n', {'SERVER_IMAGE': 'new', 'WEB_IMAGE': 'web'}), 'SERVER_IMAGE=new\nPRIVATE=value\nWEB_IMAGE=web\n')

    def test_pulls_every_image_and_rejects_a_foreign_revision_before_preparing(self):
        for revision in ['a' * 40, 'f' * 40]:
            with self.subTest(revision=revision), tempfile.TemporaryDirectory() as root:
                obj = object.__new__(deploy.Deployment)
                obj.root = Path(root)
                obj.validate_live_caddy = unittest.mock.Mock()
                obj.payload, obj.state = payload(), {}
                events = []
                def stop(_):
                    events.append('prepare')
                    raise RuntimeError('stop after pulls')
                obj.prepare = stop
                def cmd(args, output=None):
                    if args[1:4] == ['--config', args[2], 'pull']:
                        events.append(('pull', args[-1]))
                    if args[:3] == ['docker', 'image', 'inspect']:
                        return json.dumps({'org.opencontainers.image.revision': revision})
                    return ''
                with patch.object(deploy, 'command', side_effect=cmd), contextlib.redirect_stdout(io.StringIO()), \
                        self.assertRaises(RuntimeError) as failure:
                    obj.apply(archive())
                pulled = sorted(event[1] for event in events if event[0] == 'pull')
                self.assertEqual(pulled, sorted(obj.payload['images'].values()))
                if revision == obj.payload['sha']:
                    self.assertEqual(str(failure.exception), 'stop after pulls')
                else:
                    self.assertIn('image source revision does not match', str(failure.exception))
                    self.assertNotIn('prepare', events)

    def test_backup_prefers_zstd_and_falls_back_to_the_default_compression(self):
        for zstd in [True, False]:
            with self.subTest(zstd=zstd), tempfile.TemporaryDirectory() as root:
                obj = object.__new__(deploy.Deployment)
                obj.config = {'postgres_container': 'db', 'postgres_user': 'user', 'postgres_database': 'app'}
                obj.directory = Path(root)
                dumps = []
                def cmd(args, output=None):
                    dumps.append(args)
                    if '--compress=zstd' in args and not zstd:
                        output.write(b'pg_dump: error: compression method zstd is not supported')
                        raise RuntimeError('command failed: docker (exit 1); inspect privately on host')
                    output.write(b'PGDMP' + b'x' * 2048)
                    return ''
                restored = unittest.mock.Mock(returncode=0)
                with patch.object(deploy, 'command', side_effect=cmd), \
                        patch.object(deploy.subprocess, 'run', return_value=restored), contextlib.redirect_stdout(io.StringIO()):
                    obj.backup()
                self.assertEqual(dumps[0][-1], '--compress=zstd')
                self.assertEqual(len(dumps), 1 if zstd else 2)
                if not zstd:
                    self.assertEqual(dumps[1][-1], '-Fc')
                # A retry replaces the failed attempt's output instead of appending to it.
                self.assertTrue((obj.directory / 'before-migration.dump').read_bytes().startswith(b'PGDMP'))

    def test_failed_route_check_restores_old_route_and_worker_without_down_migration(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            obj = object.__new__(deploy.Deployment)
            obj.root = directory
            obj.config = {'project': 'fixture', 'caddy_container': 'fixture-caddy'}
            obj.state = {'sha': 'c' * 40, 'services': {k: k + '_previous' for k in ['api', 'web', 'mcp', 'public-mcp', 'admin']}}
            obj.payload = payload()
            obj.directory = directory
            obj.state_path = directory / 'state.json'
            obj.release = 'test'
            obj.services = {k: k + '_new' for k in ['api', 'web', 'mcp', 'public-mcp', 'admin']}
            obj.current_web_assets = ['legacy.js']
            obj.live_caddy = directory / 'live'
            obj.env = directory / 'env'
            obj.rolling = directory / 'rolling'
            for name in ['before-caddy', 'before-release.env', 'before-rolling.json']:
                (directory / name).write_text('old')
            (directory / 'Caddyfile.next').write_text('new')
            obj.live_caddy.write_text('old')
            events = []
            obj.prepare = lambda _: events.append('prepare')
            obj.backup = lambda: events.append('backup')
            obj.compose = lambda *args, **kwargs: events.append(args)
            obj.reload = lambda: events.append('reload')
            obj.install_caddy = lambda content: deploy.write_caddy_in_place(obj.live_caddy, content)
            obj.verify_public_mcp = lambda: events.append('public-mcp handshake')
            obj.capacity_gate = lambda: None
            obj.warm_candidates = lambda: events.append('warm')
            obj.update_monitoring = lambda services: events.append(('monitoring', services))
            obj.cleanup = lambda _: events.append('cleanup')
            obj.prune = lambda _: events.append('prune')
            def verify(expected=None):
                if expected is None:
                    raise RuntimeError('route check failed')
                events.append(('verify', expected))
            obj.verify = verify
            def cmd(args, output=None):
                if args[:3] == ['docker', 'image', 'inspect']:
                    return json.dumps({'org.opencontainers.image.revision': 'a' * 40})
                return ''
            with patch.object(deploy, 'command', side_effect=cmd), self.assertRaises(RuntimeError):
                obj.apply(archive())
            manifest = json.loads((directory / 'manifest.json').read_text())
            self.assertEqual(manifest['web_assets'], ['legacy.js'])
            self.assertEqual(obj.live_caddy.read_text(), 'old')
            self.assertEqual(obj.env.read_text(), 'old')
            self.assertEqual(obj.rolling.read_text(), 'old')
            self.assertLess(events.index('backup'), events.index(('run', '--rm', '--no-deps', 'migrate', 'up')))
            old_up = ('up', '-d', '--no-deps', '--wait', '--wait-timeout', '240',
                      'api_previous', 'web_previous', 'mcp_previous', 'public-mcp_previous', 'admin_previous', 'worker')
            self.assertIn(old_up, events)
            self.assertLess(events.index(old_up), len(events) - 1 - events[::-1].index('reload'))
            self.assertFalse(obj.state_path.exists())
            self.assertNotIn('down', str(events))
            self.assertNotIn('cleanup', events)
            self.assertNotIn('prune', events)

            # If monitoring cannot recover, rollback leaves candidate containers for inspection.
            events.clear()
            def fail_monitoring(_): raise RuntimeError('monitoring unavailable')
            obj.update_monitoring = fail_monitoring
            with self.assertRaisesRegex(RuntimeError, 'monitoring unavailable'):
                obj.rollback()
            self.assertFalse(any(event and event[0] == 'stop' for event in events if isinstance(event, tuple)))
            self.assertEqual(obj.live_caddy.read_text(), 'old')

            # A successful retry must persist the verified release before cleanup.
            obj.state['previous'] = {'sha': 'd' * 40}
            (directory / 'release.env').write_text('new-env')
            (directory / 'rolling.compose.json').write_text('{}')
            events.clear()
            obj.verify = lambda expected=None: events.append('verify')
            obj.warm_candidates = lambda: events.append('warm')
            obj.update_monitoring = lambda services: events.append('monitoring')
            def cleanup(previous):
                state = json.loads(obj.state_path.read_text())
                self.assertEqual(state['sha'], obj.payload['sha'])
                self.assertEqual(state['previous'], {'sha': 'c' * 40, 'services': {k: k + '_previous' for k in ['api', 'web', 'mcp', 'public-mcp', 'admin']}})
                self.assertEqual(previous, state['previous'])
                events.append('cleanup')
            obj.cleanup = cleanup
            with patch.object(deploy, 'command', side_effect=cmd):
                obj.apply(archive())
            manifest = json.loads((directory / 'manifest.json').read_text())
            self.assertEqual(manifest['web_assets'], ['legacy.js'])
            self.assertEqual(events.count('verify'), 2)
            self.assertEqual(events[-2:], ['cleanup', 'prune'])
            self.assertLess(events.index(('up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'worker')), len(events) - 1)


if __name__ == '__main__': unittest.main()
