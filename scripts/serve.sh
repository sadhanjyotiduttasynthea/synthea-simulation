#!/usr/bin/env bash
# Production-style single-port run: build the frontend and serve it from FastAPI on port 8000.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="${PYTHON:-python3}"
if [ ! -d "$ROOT/backend/.venv" ]; then
  "$PY" -m venv "$ROOT/backend/.venv"
  "$ROOT/backend/.venv/bin/pip" install -q -r "$ROOT/backend/requirements.txt"
fi
(cd "$ROOT/frontend" && ([ -d node_modules ] || npm ci) && npx vite build)
cd "$ROOT/backend" && exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
