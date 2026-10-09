#!/usr/bin/env python3
""" Use a temporary API replica to preserve rollout order; show the plan by default."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent


class Rollout:
    def __init__(self, project, env=None, files=None):
        if project not in ['opennavo-prod', 'opennavo-staging', 'opennavo-prod-verify']:
            raise ValueError('unsupported deployment project')
        self.project = project
        self.env = env or os.environ.copy()
        self.compose = ['docker', 'compose', '-p', project]
        for file in files or ['ops/docker-compose.prod.yml']:
            self.compose += ['-f', file]

    def run(self, args):
        result = subprocess.run(args, cwd=ROOT, env=self.env, capture_output=True, check=False)
        if result.returncode:
            # Compose errors may contain expanded environment values; report the stage only, not raw output.
            raise RuntimeError('deployment command failed; existing healthy replicas are retained')
        return result.stdout.decode().strip()

    def containers(self, service):
        return set(self.run(['docker', 'ps', '-aq', '--filter',
            f'label=com.docker.compose.project={self.project}', '--filter',
            f'label=com.docker.compose.service={service}', '--filter',
            'label=com.docker.compose.oneoff=False']).splitlines())

    def ready(self, container):
        state = json.loads(self.run(['docker', 'inspect', '--format', '{{json .State}}', container]))
        return state.get('Running') and state.get('Health', {}).get('Status') == 'healthy'

    def wait(self, containers, timeout=180):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if all(self.ready(c) for c in containers):
                return
            time.sleep(1)
        raise RuntimeError('new replica did not become healthy; previous healthy replicas are retained')

    def apply(self):
        old = self.containers('api')
        if len(old) != 2 or not all(self.ready(c) for c in old):
            raise RuntimeError('deployment requires exactly two healthy API replicas')
        self.run(self.compose + ['config', '--quiet'])
        self.run(self.compose + ['--profile', 'ops', 'run', '--rm', 'migrate', 'up'])
        self.run(self.compose + ['--profile', 'ops', 'run', '--rm', 'db-permissions'])
        for container in sorted(old):
            before = self.containers('api')
            self.run(self.compose + ['up', '-d', '--no-deps', '--no-recreate', '--scale', 'api=3', 'api'])
            new = self.containers('api') - before
            if len(new) != 1:
                raise RuntimeError('unexpected replica count; manual inspection required')
            self.wait(new)
            self.run(['docker', 'stop', '--time', '30', container])
            self.run(['docker', 'rm', container])
        self.wait(self.containers('api'))
        self.run(self.compose + ['up', '-d', '--wait', '--wait-timeout', '180', '--no-deps', 'worker'])
        print('migration, two healthy replacement API replicas and worker: passed')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', default='opennavo-prod')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    deployment = Rollout(args.project)
    if not args.apply:
        print('Plan: migrate -> grant application permissions -> add healthy API -> retire one old API (twice) -> update worker')
        print('Apply on the configured target with --apply; SERVER_IMAGE must identify the reviewed version.')
        return
    deployment.apply()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'backend rollout failed: {error}')
        raise SystemExit(1)
