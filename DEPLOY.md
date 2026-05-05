# Деплой botme.neeklo.ru

## Архитектура

```
Browser  ─►  Nginx (443/SSL) ─►  Node.js (PM2, :3001)
                                   ├── Express (API)
                                   ├── better-sqlite3 (data/botme.db)
                                   └── projects/  data/uploads/
```

## Первая установка

### 1. На VPS подготовить базу

```bash
# Node 20+, PM2, Nginx, certbot уже стоят (предположение).
node -v && pm2 -v && nginx -v && certbot --version
```

### 2. Склонировать репозиторий

```bash
sudo mkdir -p /var/www/botme
sudo chown -R "$USER:$USER" /var/www/botme
cd /var/www
git clone git@github.com:letoceiling-coder/botme.git botme
# или HTTPS:
# git clone https://github.com/letoceiling-coder/botme.git botme
cd botme
```

### 3. Зависимости

```bash
npm ci --omit=dev
mkdir -p logs data data/uploads projects
```

### 4. Настроить .env

```bash
cp .env.example .env
nano .env
# подставить реальные ключи:
#   OPENAI_API_KEY=sk-proj-...
#   ANTHROPIC_API_KEY=sk-ant-api03-...
#   GEMINI_API_KEY=AIza...
#   OLLAMA_TOKEN=...
#   PORT=3001
```

### 5. Запустить под PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup            # выполнить выданную команду от root
pm2 logs botme --lines 30
```

Локальная проверка:
```bash
curl http://127.0.0.1:3001/api/v1/health
# {"ok":true,"time":...}
```

### 6. Подключить Nginx (БЕЗ влияния на другие сайты)

```bash
sudo cp deploy/nginx/botme.neeklo.ru.conf /etc/nginx/sites-available/botme.neeklo.ru
sudo ln -sf /etc/nginx/sites-available/botme.neeklo.ru /etc/nginx/sites-enabled/botme.neeklo.ru
sudo mkdir -p /var/www/letsencrypt
sudo nginx -t
sudo systemctl reload nginx
```

### 7. Выпустить SSL — отдельным cert-name (важно!)

```bash
sudo certbot --nginx \
    -d botme.neeklo.ru \
    --cert-name botme.neeklo.ru \
    --redirect --no-eff-email \
    -m admin@neeklo.ru --agree-tos
```

`--cert-name botme.neeklo.ru` гарантирует, что certbot создаст **отдельный** сертификат, не объединяя с уже существующими сертификатами других сайтов на этом сервере.

### 8. Проверить

```bash
curl https://botme.neeklo.ru/api/v1/health
# Браузер: https://botme.neeklo.ru/
# Браузер: https://botme.neeklo.ru/assistant/
```

---

## Обновление кода (CI-loop)

С локальной машины:
```bash
git push origin main
```

На VPS:
```bash
cd /var/www/botme
bash scripts/deploy.sh
```

Скрипт сам сделает `git pull`, `npm ci`, `pm2 reload` и smoke-test.

---

## Полезные команды

```bash
pm2 status                       # состояние процесса
pm2 logs botme --lines 100       # логи
pm2 reload botme --update-env    # перезагрузка после правки .env
pm2 monit                        # CPU/память
sudo nginx -t && sudo systemctl reload nginx
sudo tail -f /var/log/nginx/botme.neeklo.ru.error.log
sudo certbot renew --dry-run     # проверка автообновления SSL
```

---

## Бэкап данных

Данные ассистентов в `data/botme.db` (SQLite) и `data/uploads/`. Резервная копия:

```bash
cd /var/www/botme
tar -czf "/var/backups/botme-$(date +%F).tar.gz" data/ projects/
```

Желательно настроить cron-задачу раз в сутки.

---

## Откат версии

```bash
cd /var/www/botme
git log --oneline -10
git checkout <commit_hash>
npm ci --omit=dev
pm2 reload botme
```

---

## Безопасность

- `.env` НЕ в git (gitignore).
- API-токены ассистентов хранятся как SHA-256 хеши.
- Rate-limit на публичном API (`/api/v1/chat`) — 60 rpm по умолчанию, настраивается на токен.
- Все статические превью пользовательских HTML отдаются с заблокированным `meta.json`.
- Базовые security-заголовки выставлены в nginx.
