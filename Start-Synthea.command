#!/usr/bin/env bash
# Synthea Simulation — start on this Mac and share it with everyone on the same Wi-Fi.
# Double-click in Finder (or run ./Start-Synthea.command). Keep the window open: it keeps the Mac awake.
# Ctrl+C (or closing with Stop-Synthea.command) stops Synthea. Data is kept in the Docker volume "synthea-data".
set -euo pipefail
cd "$(dirname "$0")"
PORT_DEFAULT=8000

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Install Docker Desktop for Mac (https://www.docker.com/products/docker-desktop/)."; read -r -p "Press Enter to close."; exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Starting Docker Desktop..."
  open -a Docker || true
  for _ in $(seq 90); do docker info >/dev/null 2>&1 && break; sleep 2; done
  docker info >/dev/null 2>&1 || { echo "Docker Desktop did not start. Open it manually and run this again."; read -r -p "Press Enter to close."; exit 1; }
fi

# first start: team password + cookie secret in .env (stays on this Mac, never committed)
if [ ! -f .env ]; then
  echo "First start: choose the team password (everyone signs in with it)."
  while true; do
    read -r -s -p "Team password: " P1; echo
    read -r -s -p "Repeat it:      " P2; echo
    [ -n "$P1" ] && [ "$P1" = "$P2" ] && break
    echo "Passwords are empty or do not match — try again."
  done
  umask 077
  { echo "SYNTHEA_PASSWORD=$P1"; echo "SYNTHEA_SECRET=$(openssl rand -hex 32)"; echo "SYNTHEA_PORT=$PORT_DEFAULT"; } > .env
fi
PORT="$(grep -E '^SYNTHEA_PORT=' .env | cut -d= -f2)"; PORT="${PORT:-$PORT_DEFAULT}"

echo "Building and starting Synthea (the first build downloads packages and takes several minutes)..."
docker compose up -d --build

echo -n "Waiting for the engine"
for _ in $(seq 120); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null && break; echo -n "."; sleep 1; done; echo
curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null || { echo "Synthea did not start. Logs:"; docker compose logs --tail 40; read -r -p "Press Enter to close."; exit 1; }

IP=""
for IF in en0 en1 en2; do IP="$(ipconfig getifaddr "$IF" 2>/dev/null || true)"; [ -n "$IP" ] && break; done
NAME="$(scutil --get LocalHostName 2>/dev/null || hostname -s).local"
echo
echo "  Synthea is running. Everyone on the same Wi-Fi opens:"
[ -n "$IP" ] && echo "     http://$IP:$PORT"
echo "     http://$NAME:$PORT   (works on most Macs/iPhones and recent Windows)"
echo "  Sign in with the team password. On this Mac: http://localhost:$PORT"
echo
echo "  Keep this window open (it keeps the Mac awake). Press Ctrl+C to stop Synthea."
open "http://localhost:$PORT" || true

caffeinate -dims &          # keeps the Mac (and its Wi-Fi) awake while sharing
CAF=$!
stop() { kill "$CAF" 2>/dev/null || true; echo; echo "Stopping Synthea (data is kept)..."; docker compose stop; exit 0; }
trap stop INT TERM HUP      # Ctrl+C or closing the Terminal window
wait "$CAF"
