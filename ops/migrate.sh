#!/bin/sh
set -eu
docker compose -f ops/docker-compose.prod.yml --profile ops run --rm migrate up
docker compose -f ops/docker-compose.prod.yml --profile ops run --rm db-permissions
