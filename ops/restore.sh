#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then
  printf '%s\n' 'Usage: ops/restore.sh backups/postgres/opennavo/<object>.dump' >&2
  exit 1
fi
docker compose -f ops/docker-compose.prod.yml stop worker api
docker compose -f ops/docker-compose.prod.yml --profile backup run --rm --no-deps backup restore "$1"
docker compose -f ops/docker-compose.prod.yml --profile ops run --rm db-permissions
docker compose -f ops/docker-compose.prod.yml up -d --wait api worker
