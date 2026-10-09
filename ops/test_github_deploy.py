import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
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


class DeployTests(unittest.TestCase):
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

    def test_failed_route_check_restores_old_route_and_worker_without_down_migration(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            obj = object.__new__(deploy.Deployment)
            obj.config = {}
            obj.state = {'sha': 'c' * 40}
            obj.payload = payload()
            obj.directory = directory
            obj.state_path = directory / 'state.json'
            obj.release = 'test'
            obj.services = {k: k + '_new' for k in ['api', 'web', 'admin', 'mcp']}
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
            def fail(): raise RuntimeError('route check failed')
            obj.verify = fail
            def cmd(args, output=None):
                if args[:3] == ['docker', 'image', 'inspect']:
                    return json.dumps({'org.opencontainers.image.revision': 'a' * 40})
                return ''
            with patch.object(deploy, 'command', side_effect=cmd), self.assertRaises(RuntimeError):
                obj.apply(archive())
            self.assertEqual(obj.live_caddy.read_text(), 'old')
            self.assertEqual(obj.env.read_text(), 'old')
            self.assertEqual(obj.rolling.read_text(), 'old')
            self.assertLess(events.index('backup'), events.index(('run', '--rm', '--no-deps', 'migrate', 'up')))
            self.assertIn(('up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'worker'), events)
            self.assertFalse(obj.state_path.exists())
            self.assertNotIn('down', str(events))


if __name__ == '__main__': unittest.main()
