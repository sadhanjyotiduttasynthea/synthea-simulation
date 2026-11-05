#!/usr/bin/env bash
# Saves the database and uploaded PDFs to deploy/server/backups/ and keeps the 14 newest copies.
# The database is copied with SQLite's online-backup API, so a backup taken while people work is consistent.
# Nightly at 03:00:  sudo crontab -e   then add:   0 3 * * * /path/to/synthea-simulation/deploy/server/backup.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups
file="backups/synthea-$(date +%Y%m%d-%H%M%S).tar.gz"
docker compose exec -T synthea sh -c '
  set -e
  snap=$(mktemp -d)
  python - "$snap" <<PY
import glob, os, sqlite3, sys
for db in glob.glob("/data/*.db"):
    src = sqlite3.connect(db); dst = sqlite3.connect(os.path.join(sys.argv[1], os.path.basename(db)))
    src.backup(dst); dst.close(); src.close()
PY
  # live database files are skipped; the snapshot files are added by plain name (no "./"), so the excludes do not match them
  tar czf - -C /data --exclude="./*.db" --exclude="./*.db-wal" --exclude="./*.db-shm" . -C "$snap" $(cd "$snap" && ls)
  rm -rf "$snap"
' > "$file"
tar tzf "$file" | grep -q '\.db$' || { echo "ERROR: backup has no database - not kept"; rm -f "$file"; exit 1; }
ls -1t backups/synthea-*.tar.gz | tail -n +15 | xargs -r rm --
echo "Backup written: $file ($(du -h "$file" | cut -f1))"
