#!/bin/sh
set -e
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
docker compose up -d
echo "Infra running. Postgres: localhost:5432 | Redis: localhost:6379 | GoTrue: localhost:9999 | MailHog UI: http://localhost:8025"
