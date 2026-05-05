#!/usr/bin/env bash
# Запуск на сервере из корня проекта: bash scripts/server-smoke-notifications.sh
set -euo pipefail
cd "$(dirname "$0")/.."
npm test
PORT="${PORT:-3015}"
AID="$(sqlite3 data/botme.db 'select id from assistants limit 1')"
curl -fsS -X POST "http://127.0.0.1:${PORT}/api/assistants/${AID}/notifications/test" \
  -H 'Content-Type: application/json' \
  -d '{"channels":["email"]}'
echo
