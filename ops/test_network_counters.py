"""Execute the container counter snippet locally against synthetic Linux sysfs."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('verification', Path(__file__).with_name('verify-production.py'))
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


class NetworkCounterTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.net = self.root / 'net'
        self.net.mkdir()

    def interface(self, name, count):
        # Linux class entries are symlinks; filtering Dirent.isDirectory loses them.
        device = self.root / 'devices' / name / 'statistics'
        device.mkdir(parents=True)
        (device / 'tx_bytes').write_text(str(count) + '\n')
        (self.net / name).symlink_to(device.parent, target_is_directory=True)

    def read(self):
        def local_run(args):
            self.assertEqual(args[:5], ['docker', 'exec', 'synthetic', 'node', '-e'])
            code = args[5].replace('/sys/class/net', str(self.net))
            return subprocess.run(['node', '-e', code], capture_output=True, check=True)
        with patch.object(v, 'run', side_effect=local_run):
            return v.web_transmitted(['synthetic'])['synthetic']

    def test_noninterface_entries_ignored_and_symlink_interfaces_summed(self):
        self.interface('lo', 99999)
        self.interface('eth0', 1200)
        self.interface('eth1', 300)
        (self.net / 'bonding_masters').write_text('')
        (self.net / 'noninterface').mkdir()
        self.assertEqual(self.read(), 1500)

    def test_no_usable_nonloopback_counter_fails(self):
        self.interface('lo', 99999)
        with self.assertRaises(subprocess.CalledProcessError):
            self.read()

    def test_invalid_counter_fails_instead_of_false_measurement(self):
        self.interface('eth0', 'invalid')
        with self.assertRaises(subprocess.CalledProcessError):
            self.read()


if __name__ == '__main__':
    unittest.main()
