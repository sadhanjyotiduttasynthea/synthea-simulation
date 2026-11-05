#!/usr/bin/env bash
# Restore a backup:  sudo ./restore.sh backups/synthea-YYYYMMDD-HHMMSS.tar.gz   (replaces the current data)
set -euo pipefail
cd "$(dirname "$0")"
[ -f "${1:-}" ] || { echo "Usage: $0 backups/<file>.tar.gz"; exit 1; }
read -rp "This replaces all current data with $1. Type YES to continue: " ok
[ "$ok" = "YES" ] || exit 1
docker compose stop synthea
docker compose run --rm -T --no-deps --entrypoint sh synthea -c 'rm -rf /data/* && tar xzf - -C /data' < "$1"
docker compose start synthea
echo "Restored."
