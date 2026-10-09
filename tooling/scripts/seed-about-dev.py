""" Insert About content only into the fixed opennavo-dev database, preserving admin edits."""
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
content = json.loads((root / 'apps/server/seeds/about.json').read_text())
raw = json.dumps(content, ensure_ascii=False).replace("'", "''")
compose = ['docker', 'compose', '-f', str(root / 'ops/docker-compose.dev.yml')]
sql = "INSERT INTO app_config(key,value,description) VALUES('site.about','" + raw + "'::jsonb,'About page: six-language text and open-source dependency inventory') ON CONFLICT(key) DO NOTHING;\nSELECT key,jsonb_array_length(value->'modules') AS modules FROM app_config WHERE key='site.about';"
subprocess.run(compose + ['exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'opennavo', '-d', 'opennavo'], input=sql, text=True, check=True)
# Invalidate only client configuration; preserve other development data and caches.
keys = subprocess.check_output(compose + ['exec', '-T', 'redis', 'redis-cli', '--scan', '--pattern', 'c:cfg:client:*'], text=True).splitlines()
if keys:
    subprocess.run(compose + ['exec', '-T', 'redis', 'redis-cli', 'UNLINK', *keys], check=True)
