#!/bin/sh
set -e
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
echo "Wiping all volumes and restarting infra (clean slate)..."
docker compose --profile services down -v
docker compose up -d
echo "Clean infra running. Run gen-keys.sh and seed-super-admin if needed."
