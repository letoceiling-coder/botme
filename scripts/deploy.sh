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

echo "==> 3/4  Restarting PM2 from ecosystem.config.cjs..."
pm2 delete botme 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo "==> 4/4  Smoke test..."
sleep 2
PORT_TO_CHECK="${PORT:-3015}"
curl -fsS "http://127.0.0.1:${PORT_TO_CHECK}/api/v1/health" | head -c 200 && echo

echo
echo "✓ Deploy complete: $(date -Iseconds)"
echo "Logs: pm2 logs botme"
