"""Offline regressions for license identification and preserving upstream bytes."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('inventory', Path(__file__).with_name('about-inventory.py'))
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class InventoryTests(unittest.TestCase):
    def test_external_build_stages_do_not_enter_server_dependency_graph(self):
        dockerfile = 'FROM golang AS build\nRUN go build ./cmd/api\nFROM golang AS monitor\nRUN go build ./cmd/asynqmon\n'
        self.assertEqual(inventory.server_go_targets(dockerfile), ['./cmd/api'])
        with self.assertRaises(ValueError):
            inventory.server_go_targets('FROM golang AS monitor\nRUN go build ./cmd/asynqmon\n')

    def test_isc_wrapping_and_known_license_families(self):
        self.assertEqual(inventory.license_name('Permission to use, copy, modify, and distribute this software for any\npurpose with or without fee is hereby granted'), 'ISC')
        self.assertEqual(inventory.license_name('CC0 1.0 Universal'), 'CC0-1.0')
        self.assertEqual(inventory.license_name('No license grant here'), 'NOASSERTION')
        self.assertEqual(inventory.normalized('Unknown'), 'NOASSERTION')

    def test_license_bytes_are_preserved_and_content_addressed(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(inventory, 'OUT', Path(directory)):
            raw = b'Copyright Example\r\nPermission notice.\r\n'
            records = inventory.save_texts([('LICENSE', raw)])
            self.assertEqual((Path(directory) / records[0]['path']).read_bytes(), raw)
            self.assertEqual(records[0]['sha256'], inventory.hashlib.sha256(raw).hexdigest())

    def test_notice_filenames_cover_common_upstream_variants(self):
        for name in ('LICENSE.txt', 'license-MIT', 'COPYING', 'NOTICE.md', 'LICENSE-APACHE'):
            self.assertTrue(inventory.is_notice(name), name)
        self.assertFalse(inventory.is_notice('package.json'))


if __name__ == '__main__':
    unittest.main()
