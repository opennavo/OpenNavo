import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('verification', Path(__file__).with_name('verify-production.py'))
verification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verification)


class OgConfigurationTests(unittest.TestCase):
    def test_production_requires_secret_but_template_has_no_value(self):
        root = Path(__file__).resolve().parent
        self.assertIn('NUXT_OG_IMAGE_SECRET: ${NUXT_OG_IMAGE_SECRET:?', (root / 'docker-compose.prod.yml').read_text())
        lines = (root / '.env.example').read_text().splitlines()
        self.assertIn('NUXT_OG_IMAGE_SECRET=', lines)

    def test_verification_uses_runtime_random_value(self):
        first, second = verification.environment(), verification.environment()
        self.assertTrue(first['NUXT_OG_IMAGE_SECRET'])
        self.assertNotEqual(first['NUXT_OG_IMAGE_SECRET'], second['NUXT_OG_IMAGE_SECRET'])

    def test_html_parser_unescapes_signed_image_query(self):
        document = verification.HTMLDocument(b'<meta property="og:image" content="http://web.opennavo.local/image.png?x=1&amp;y=2">')
        self.assertEqual(document.og_images, ['http://web.opennavo.local/image.png?x=1&y=2'])

    def test_runtime_addresses_are_wired_to_one_origin(self):
        root = Path(__file__).resolve().parent
        for key in ['NUXT_PUBLIC_SITE_URL', 'NUXT_PUBLIC_I18N_BASE_URL']:
            self.assertIn(f'{key}: ${{WEB_BASE_URL}}', (root / 'docker-compose.prod.yml').read_text())
            self.assertEqual(verification.environment()[key], verification.environment()['WEB_BASE_URL'])
        verification.assert_web_origin(verification.environment()['WEB_BASE_URL'] + '/apps/visual-studio-code')
        with self.assertRaises(AssertionError):
            verification.assert_web_origin('http://localhost:3000/apps/visual-studio-code')


class BrowserCheckpointTests(unittest.TestCase):
    def checkpoint(self, result, timeout=1):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / 'browser'
            directory.mkdir()
            if result is not None:
                (directory / 'done.json').write_text(json.dumps(result))
            with patch.object(verification, 'ROOT', root), patch.object(verification, 'BROWSER_DIRECTORY', directory), patch('builtins.print'):
                report = {}
                try:
                    verification.wait_for_browser(report, timeout=timeout)
                finally:
                    self.assertFalse((directory / 'ready.json').exists())
                return report

    def test_accepts_only_complete_browser_results(self):
        result = {'browser': 'browser-use', 'loginVerified': True,
                  'pages': [{'path': path, 'passed': True} for path in verification.BROWSER_PAGES]}
        self.assertEqual(self.checkpoint(result)['adminBrowser'], result)

    def test_rejects_missing_page_and_failed_checks(self):
        for count, passed, login in [(4, True, True), (5, False, True), (5, True, False)]:
            with self.subTest(count=count, passed=passed, login=login), self.assertRaises(AssertionError):
                self.checkpoint({'browser': 'browser-use', 'loginVerified': login,
                                 'pages': [{'path': path, 'passed': passed} for path in verification.BROWSER_PAGES[:count]]})

    def test_timeout_removes_ready_file(self):
        with self.assertRaises(RuntimeError):
            self.checkpoint(None, timeout=0)


if __name__ == '__main__':
    unittest.main()
