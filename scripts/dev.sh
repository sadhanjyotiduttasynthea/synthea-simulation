#!/usr/bin/env bash
# Start backend (FastAPI, port 8000) and frontend dev server (Vite, port 5173).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="${PYTHON:-python3}"
if [ ! -d "$ROOT/backend/.venv" ]; then
  "$PY" -m venv "$ROOT/backend/.venv"
  "$ROOT/backend/.venv/bin/pip" install -q -r "$ROOT/backend/requirements.txt"
fi
[ -d "$ROOT/frontend/node_modules" ] || (cd "$ROOT/frontend" && npm ci)
(cd "$ROOT/backend" && exec .venv/bin/uvicorn app.main:app --port 8000 --reload) &
BACK=$!
trap 'kill $BACK 2>/dev/null' EXIT
cd "$ROOT/frontend" && npx vite --port 5173
