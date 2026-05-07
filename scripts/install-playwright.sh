#!/usr/bin/env bash
# Установка Playwright + Chromium на VPS.
# Запускается ОДИН раз при первом деплое или после `npm i`.
#
# Идемпотентный: если Playwright и Chromium уже установлены — выйдет с 0.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "[playwright-install] Проверяю наличие пакета playwright в node_modules..."
if [ ! -d "node_modules/playwright" ]; then
  echo "[playwright-install] playwright не установлен — устанавливаю..."
  npm install --save playwright@latest
fi

# Cache path (по умолчанию ~/.cache/ms-playwright/)
CACHE_DIR="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"

# Проверим, есть ли уже chromium в кеше
if compgen -G "$CACHE_DIR/chromium-*" > /dev/null; then
  echo "[playwright-install] Chromium уже установлен в $CACHE_DIR — пропускаю."
else
  echo "[playwright-install] Устанавливаю Chromium через playwright (с системными deps)..."
  # --with-deps требует sudo / root для apt-get install
  if [ "$(id -u)" -eq 0 ]; then
    npx playwright install chromium --with-deps
  else
    echo "[playwright-install] Не root — устанавливаю Chromium без --with-deps."
    echo "[playwright-install] Если будут жалобы на missing libs, выполни: sudo npx playwright install-deps chromium"
    npx playwright install chromium
  fi
fi

echo "[playwright-install] Готово."
