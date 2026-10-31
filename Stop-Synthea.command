#!/usr/bin/env bash
# Stop Synthea Simulation (data is kept in the Docker volume "synthea-data").
cd "$(dirname "$0")"
docker compose stop && echo "Synthea stopped."
