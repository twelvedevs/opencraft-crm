#!/bin/sh
set -e
# Resolve repo root regardless of where script is called from
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
echo "Generating dev crypto keys..."
cd "$REPO_ROOT"
npx tsx scripts/dev/gen-keys.ts
echo "Done."
