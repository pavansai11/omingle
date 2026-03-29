#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/hippichat}"
BRANCH="${BRANCH:-main}"
PM2_APP_NAME="${PM2_APP_NAME:-hippichat}"
APP_PORT="${APP_PORT:-3000}"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "Repository not found at $APP_DIR"
  exit 1
fi

cd "$APP_DIR"

echo "[deploy] Fetching latest code from origin/$BRANCH"
git fetch origin "$BRANCH"
git checkout -B "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"

echo "[deploy] Installing dependencies"
yarn install --frozen-lockfile

echo "[deploy] Building application"
yarn build

echo "[deploy] Reloading PM2 process"
PM2_APP_NAME="$PM2_APP_NAME" PORT="$APP_PORT" pm2 startOrReload ecosystem.config.js --env production
pm2 save

echo "[deploy] Done"
