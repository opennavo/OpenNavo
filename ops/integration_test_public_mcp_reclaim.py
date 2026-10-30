"""Opt-in Docker regression for H1: rollback after reclaiming a fixed-IP endpoint.

Run: python3 -m unittest discover -s ops -p 'integration_test_*.py' -v
Only disposable, uniquely labelled containers and a temporary bridge are used.
"""
import importlib.util
import ipaddress
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('github_deploy', Path(__file__).with_name('github-deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

IMAGE = 'registry.hub.docker.com/library/busybox:1.37.0'


class PublicMCPReclaimDockerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if shutil.which('docker') is None:
            raise unittest.SkipTest('Docker CLI is unavailable')
        for args, prerequisite in [(['docker', 'info'], 'Docker daemon is unavailable or unreachable'),
                                   (['docker', 'compose', 'version'], 'Docker Compose is unavailable')]:
            try:
                result = subprocess.run(args, capture_output=True, timeout=15, check=False)
            except (OSError, subprocess.TimeoutExpired) as error:
                raise unittest.SkipTest(prerequisite) from error
            if result.returncode:
                raise unittest.SkipTest(prerequisite)

    def docker(self, *args):
        result = subprocess.run(['docker', *args], capture_output=True, text=True,
                                timeout=120, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='m68-h1-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.project = 'm68-h1-' + uuid.uuid4().hex[:12]
        self.network = self.project + '_proxy'
        # Register cleanup before any Docker resources can be created, including
        # partial Compose starts and a failed HTTP probe.
        self.addCleanup(self.cleanup_docker)
        subnet = self.unused_subnet()
        self.address = str(subnet.network_address + 3)
        self.alternate = str(subnet.network_address + 4)
        self.docker('network', 'create', '--driver', 'bridge', '--subnet', str(subnet),
                    '--ip-range', str(list(subnet.subnets(new_prefix=25))[1]),
                    '--label', 'com.docker.compose.project=' + self.project, self.network)

    def unused_subnet(self):
        ids = self.docker('network', 'ls', '-q').splitlines()
        networks = json.loads(self.docker('network', 'inspect', *ids)) if ids else []
        occupied = [ipaddress.ip_network(entry['Subnet']) for network in networks
                    for entry in (network.get('IPAM', {}).get('Config') or []) if entry.get('Subnet')]
        start = int(uuid.uuid4().hex[:2], 16)
        for offset in range(256):
            subnet = ipaddress.ip_network(f'10.254.{(start + offset) % 256}.0/24')
            if not any(subnet.overlaps(other) for other in occupied if other.version == subnet.version):
                return subnet
        self.fail('No unused temporary Docker /24 subnet under 10.254.0.0/16')

    def cleanup_docker(self):
        try:
            ids = self.docker('ps', '-aq', '--filter', 'label=com.docker.compose.project=' + self.project).splitlines()
            if ids:
                self.docker('rm', '--force', *ids)
        finally:
            networks = self.docker('network', 'ls', '-q', '--filter',
                                   'label=com.docker.compose.project=' + self.project).splitlines()
            if networks:
                self.docker('network', 'rm', *networks)

    def receiver(self):
        old, candidate = 'public-mcp_rollback', 'public-mcp_candidate'
        server = {
            'image': IMAGE,
            'command': ['sh', '-ec', 'mkdir -p /www; echo rollback-ok > /www/index.html; '
                        'exec httpd -f -p 8790 -h /www'],
            'healthcheck': {'test': ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8790/'],
                            'interval': '1s', 'timeout': '2s', 'retries': 20},
        }
        base = {
            'services': {
                old: {**server, 'networks': {'proxy': {'ipv4_address': self.address}}},
                candidate: {**server, 'networks': {'proxy': {'ipv4_address': self.alternate}}},
                'worker': {'image': IMAGE, 'command': ['sleep', '3600'], 'network_mode': 'none'},
            },
            'networks': {'proxy': {'external': True, 'name': self.network}},
        }
        (self.root / 'compose.json').write_text(json.dumps(base))
        (self.root / '.env').write_text('')
        (self.root / 'current-release.env').write_text('')
        (self.root / 'Caddyfile').write_text(':80 {}\n')
        (self.root / 'deploy').mkdir()
        state = {'sha': 'b' * 40, 'services': {'public-mcp': old}, 'public_mcp_proxy_ip': self.address}
        (self.root / 'deploy/github-state.json').write_text(json.dumps(state))
        (self.root / 'deploy/rolling.compose.json').write_text('{}')
        obj = deploy.Deployment({
            'root': str(self.root), 'project': self.project, 'compose_file': 'compose.json',
            'caddy_file': 'Caddyfile', 'proxy_network': self.network,
            'public_mcp_proxy_ips': [self.address, self.alternate],
        }, {'sha': 'a' * 40, 'run_id': 'integration'})
        obj.services = {'public-mcp': candidate}
        obj.directory.mkdir(parents=True)
        for source, name in [(obj.live_caddy, 'before-caddy'), (obj.rolling, 'before-rolling.json'),
                             (obj.env, 'before-release.env')]:
            shutil.copyfile(source, obj.directory / name)
        (obj.directory / 'rolling.compose.json').write_text('{}')
        (obj.directory / 'release.env').write_text('')
        return obj

    def test_reclaimed_rollback_target_reconnects_with_fixed_ip_and_serves_http(self):
        obj = self.receiver()
        old = obj.state['services']['public-mcp']
        obj.compose('up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', old, candidate=False)
        target = obj.compose('ps', '-q', old, candidate=False)
        inspected = json.loads(self.docker('inspect', target))[0]
        self.assertEqual(inspected['Config']['Labels']['com.docker.compose.project'], self.project)
        self.assertEqual(inspected['Config']['Labels']['com.docker.compose.service'], old)
        self.assertEqual(inspected['NetworkSettings']['Networks'][self.network]['IPAddress'], self.address)
        obj.compose('stop', '--timeout', '5', old, candidate=False)

        # Execute exactly the reclaim operation used by public_mcp_preflight.
        # Rollback itself must restore the endpoint; the test never connects it.
        deploy.command(['docker', 'network', 'disconnect', self.network, target])
        disconnected = json.loads(self.docker('inspect', target))[0]
        self.assertNotIn(self.network, disconnected['NetworkSettings']['Networks'])
        obj.public_mcp_preflight()
        self.assertEqual(obj.public_mcp_proxy_ip, self.alternate)
        obj.compose('up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', *obj.services.values())

        # Exercise the receiver's real rollback/Compose path. Caddy, public MCP
        # JSON-RPC and monitoring are outside this network-only fixture.
        with patch.object(obj, 'reload'), patch.object(obj, 'verify'), \
                patch.object(obj, 'verify_public_mcp'), patch.object(obj, 'update_monitoring'):
            obj.rollback()

        restored = obj.compose('ps', '-q', old, candidate=False)
        inspected = json.loads(self.docker('inspect', restored))[0]
        self.assertTrue(inspected['State']['Running'])
        self.assertEqual(inspected['NetworkSettings']['Networks'][self.network]['IPAddress'], self.address)
        body = self.docker('run', '--rm', '--name', self.project + '-probe',
                           '--label', 'com.docker.compose.project=' + self.project,
                           '--network', self.network, IMAGE, 'wget', '-q', '-T', '10', '-O', '-',
                           f'http://{self.address}:8790/')
        self.assertEqual(body, 'rollback-ok')


if __name__ == '__main__':
    unittest.main()
