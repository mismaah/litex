#!/usr/bin/env bash
# Deploy: pull the latest code, rebuild the image, and replace the running container.
set -euo pipefail
cd "$(dirname "$0")"

NAME=litex
# Publish the same port the server listens on (PORT in .env, default 8787).
PORT=$(grep -E '^PORT=' .env 2>/dev/null | tail -n1 | cut -d= -f2 | tr -d '\r' || true)
PORT=${PORT:-8787}

git pull --ff-only
docker build -t "$NAME" .

docker stop "$NAME" >/dev/null 2>&1 || true
docker rm "$NAME" >/dev/null 2>&1 || true

docker run -d --name "$NAME" --restart unless-stopped \
  -p "$PORT:$PORT" --env-file .env -v litex-cache:/app/.cache "$NAME"

docker image prune -f >/dev/null
echo "litex is running on port $PORT"
