#!/usr/bin/env bash
# Push the current checkout to a Hugging Face Docker Space (free hosting).
# Usage: HF_TOKEN=hf_xxx ./scripts/deploy_hf_space.sh <hf-user-or-org>/<space-name>
# The token needs "write" access. The Space is created on first use (private by default).
set -euo pipefail
SPACE="${1:?usage: HF_TOKEN=... $0 <owner>/<space-name>}"
: "${HF_TOKEN:?set HF_TOKEN to a Hugging Face write token}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

python3 - "$SPACE" <<'PY'
import os, sys
from huggingface_hub import HfApi
api = HfApi(token=os.environ["HF_TOKEN"])
api.create_repo(sys.argv[1], repo_type="space", space_sdk="docker", private=os.environ.get("SPACE_PUBLIC") != "1", exist_ok=True)
print("Space ready:", sys.argv[1])
PY

# copy what the Docker build needs (no local data, no node_modules, no virtualenvs)
git -C "$ROOT" archive HEAD Dockerfile .dockerignore backend frontend | tar -x -C "$TMP"
cp "$ROOT/deploy/huggingface/README.md" "$TMP/README.md"

cd "$TMP"
git init -q -b main
git add -A
git -c user.name="synthea-deploy" -c user.email="deploy@localhost" commit -q -m "Deploy $(git -C "$ROOT" rev-parse --short HEAD)"
git push -q --force "https://user:${HF_TOKEN}@huggingface.co/spaces/${SPACE}" main
echo "Pushed. Build log and URL: https://huggingface.co/spaces/${SPACE}"
