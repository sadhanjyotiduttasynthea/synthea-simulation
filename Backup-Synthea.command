#!/usr/bin/env bash
# Copy the Synthea data (database + PDFs) out of Docker into backups/synthea-<date>.tar.gz next to this file.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups
F="backups/synthea-$(date +%Y%m%d-%H%M%S).tar.gz"
docker run --rm -v synthea_synthea-data:/data:ro -v "$PWD/backups":/out alpine \
  tar -czf "/out/$(basename "$F")" -C /data . && echo "Backup written to $F"
