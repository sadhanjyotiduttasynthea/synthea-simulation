#!/usr/bin/env bash
# Update to the latest code on the current branch; data is kept.
set -euo pipefail
cd "$(dirname "$0")"
./backup.sh
git -C ../.. pull --ff-only
docker compose up -d --build
docker image prune -f >/dev/null
echo "Updated."
