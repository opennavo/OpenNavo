#!/bin/sh
set -eu
# Read connection secrets from the Compose environment, never arguments, output, or backup object keys.
exec docker compose -f ops/docker-compose.prod.yml --profile backup run --rm --no-deps backup create
