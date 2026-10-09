import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('rollout', Path(__file__).with_name('rollout.py'))
rollout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rollout)


class FakeRollout(rollout.Rollout):
    def __init__(self, fail=False):
        super().__init__('opennavo-prod-verify')
        self.live = {'old1', 'old2'}
        self.events = []
        self.added = 0
        self.fail = fail

    def containers(self, service):
        return self.live.copy()

    def ready(self, container):
        return True

    def run(self, args):
        self.events.append(args)
        if '--scale' in args:
            self.added += 1
            self.live.add('new' + str(self.added))
        if args[:2] == ['docker', 'rm']:
            self.live.remove(args[-1])
        return ''

    def wait(self, containers, timeout=180):
        self.events.append(['healthy', *sorted(containers)])
        if self.fail:
            raise RuntimeError('fixture health failure')


class RolloutTests(unittest.TestCase):
    def test_new_health_precedes_each_old_removal(self):
        deploy = FakeRollout()
        deploy.apply()
        self.assertEqual(deploy.live, {'new1', 'new2'})
        self.assertIn('migrate', deploy.events[1])
        for index, event in enumerate(deploy.events):
            if event[:2] == ['docker', 'stop']:
                self.assertEqual(deploy.events[index - 1][0], 'healthy')
        self.assertEqual(sum(e[:2] == ['docker', 'stop'] for e in deploy.events), 2)

    def test_failed_health_retains_both_previous_replicas(self):
        deploy = FakeRollout(fail=True)
        with self.assertRaises(RuntimeError):
            deploy.apply()
        self.assertTrue({'old1', 'old2'}.issubset(deploy.live))
        self.assertFalse(any(e[:2] == ['docker', 'stop'] for e in deploy.events))

    def test_foreign_project_is_rejected(self):
        with self.assertRaises(ValueError):
            rollout.Rollout('unrelated-project')


if __name__ == '__main__':
    unittest.main()
