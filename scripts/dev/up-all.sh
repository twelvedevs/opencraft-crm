#!/bin/sh
set -e
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
docker compose --profile services up -d --build
echo "Full platform stack running. Services on ports 3100-3110."
