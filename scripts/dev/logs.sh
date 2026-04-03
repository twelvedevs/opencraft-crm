#!/bin/sh
# Usage: ./scripts/dev/logs.sh [service-name]
# Example: ./scripts/dev/logs.sh identity
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
docker compose --profile services logs -f "$@"
