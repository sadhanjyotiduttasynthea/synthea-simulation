#!/usr/bin/env bash
# One-time installation of Synthea Simulation on an Ubuntu/Debian cloud server.
# Run from this folder:  sudo ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi

if [ ! -f .env ]; then
  read -rp "Web address for the platform (e.g. simulation.syntheatech.com): " domain
  read -rp "E-mail for HTTPS certificate notices: " email
  while true; do
    read -rsp "Team password (at least 12 characters): " pw; echo
    case "$pw" in *"'"*) echo "Please do not use the ' character."; continue;; esac
    [ "${#pw}" -ge 12 ] && break
    echo "Too short, try again."
  done
  secret=$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=')
  umask 077
  cat > .env <<ENV
SITE_DOMAIN=${domain}
ACME_EMAIL=${email}
SYNTHEA_PASSWORD='${pw}'
SYNTHEA_SECRET=${secret}
ENV
  echo "Settings saved in deploy/server/.env (readable by root only)."
fi

# shellcheck disable=SC1091
. ./.env
ip=$(curl -fs https://api.ipify.org 2>/dev/null || true)
dns=$(getent hosts "$SITE_DOMAIN" | awk '{print $1}' | head -1 || true)
if [ -n "$ip" ] && [ "$dns" != "$ip" ]; then
  echo "WARNING: $SITE_DOMAIN points to '${dns:-nothing}', but this server is $ip."
  echo "Add a DNS record: type A, name '${SITE_DOMAIN%%.*}', value $ip — then run this script again."
  echo "(HTTPS cannot be set up until the address points here.)"
fi

docker compose up -d --build
echo
echo "Done. In a minute open https://$SITE_DOMAIN and sign in with the team password."
echo "Logs: docker compose logs -f    Update: ./update.sh    Backup: ./backup.sh"
