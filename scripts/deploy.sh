#!/usr/bin/env bash
# =====================================================
# Скрипт обновления botme.neeklo.ru на VPS.
# Запускать из каталога проекта на сервере (/var/www/botme):
#   bash scripts/deploy.sh
# =====================================================
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> 1/4  Pulling latest code..."
git pull --ff-only

echo "==> 2/4  Installing dependencies..."
npm ci --omit=dev

echo "==> 3/4  Reloading PM2 process..."
if pm2 list | grep -q "botme"; then
    pm2 reload botme --update-env
else
    pm2 start ecosystem.config.cjs
fi
pm2 save

echo "==> 4/4  Smoke test..."
sleep 2
curl -fsS http://127.0.0.1:3001/api/v1/health | head -c 200 && echo

echo
echo "✓ Deploy complete: $(date -Iseconds)"
echo "Logs: pm2 logs botme"
