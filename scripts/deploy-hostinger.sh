#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/hippichat}"
BRANCH="${BRANCH:-main}"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "Repository not found at $APP_DIR"
  exit 1
fi

cd "$APP_DIR"

echo "[deploy] Fetching latest code from origin/$BRANCH"
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "[deploy] Installing dependencies"
yarn install --frozen-lockfile

echo "[deploy] Building application"
yarn build

echo "[deploy] Reloading PM2 process"
pm2 startOrReload ecosystem.config.js --env production
pm2 save

echo "[deploy] Done"
