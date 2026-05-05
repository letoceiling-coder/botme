# Деплой botme.neeklo.ru

## Архитектура VPS

На сервере 89.169.39.244 уже работает схема:

```
Internet ──► HAProxy(:443, mode=tcp, SNI passthrough)
                │
                ├─ если SNI ∈ sni-web.map → bk_nginx → Nginx(127.0.0.1:9443, SSL)
                │                                       │
                │                                       └── proxy_pass → PM2-приложения
                └─ иначе → bk_mtg (MTProto, 127.0.0.1:4480)
```

Поэтому каждый новый сайт:
1. Получает свой backend-порт (PM2).
2. Имеет nginx-конфиг, слушающий **127.0.0.1:9443 + [::1]:9443** (SSL внутри).
3. Имеет блок `listen 80` для acme-challenge и редиректа.
4. Добавляется в `/var/lib/haproxy/sni-web.map` → `bk_nginx`.
5. Сертификат выпускается через **webroot** (`/var/www/html/.well-known/acme-challenge/`), не через `--nginx` — чтобы не трогать чужие сайты.

`botme.neeklo.ru` использует:
- backend-порт **3015** (3001 уже занят другим приложением)
- путь установки **`/var/www/botme`**
- отдельный cert-name **`botme.neeklo.ru`**

## Первая установка

### 1. Подключение и подготовка

```bash
ssh root@89.169.39.244

# Versions check
node -v   # должен быть 20+
pm2 -v
nginx -v
certbot --version
```

### 2. Склонировать репозиторий

```bash
cd /var/www
git clone git@github.com:letoceiling-coder/botme.git botme
# либо HTTPS:
# git clone https://github.com/letoceiling-coder/botme.git botme
cd botme
```

> Если деплой-ключ ещё не настроен на сервере — проще клонировать через HTTPS,
> а позднее перейти на SSH с deploy key.

### 3. Зависимости

```bash
npm ci --omit=dev
mkdir -p logs data data/uploads projects
```

### 4. Создать .env (с реальными ключами)

```bash
cp .env.example .env
nano .env
```

Подставить:
```
OLLAMA_BASE_URL=https://ollama.siteaacess.store/v1
OLLAMA_TOKEN=...
ANTHROPIC_API_KEY=sk-ant-api03-...
GEMINI_API_KEY=AIza...
OPENAI_API_KEY=sk-proj-...
PORT=3015
NODE_ENV=production
```

### 5. Запустить под PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup           # выполнить выданную команду от root
pm2 logs botme --lines 30
```

Локальная проверка (изнутри VPS):
```bash
curl http://127.0.0.1:3015/api/v1/health
# {"ok":true,"time":...}
```

### 6. Подключить Nginx

```bash
sudo cp deploy/nginx/botme.neeklo.ru.conf /etc/nginx/sites-available/botme.neeklo.ru
sudo ln -sf /etc/nginx/sites-available/botme.neeklo.ru /etc/nginx/sites-enabled/botme.neeklo.ru
```

Перед первым `nginx -t` — нужно временно закомментировать `ssl_certificate*` (или certbot их создаст), либо сделать минимальный SSL-stub. Проще: сначала получить сертификат, потом включить ssl-блок. Поэтому используем такой порядок:

**Шаг 6.1.** Создать временный nginx-конфиг ТОЛЬКО с port 80 (для challenge):

```bash
sudo tee /etc/nginx/sites-available/botme.neeklo.ru.acme >/dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name botme.neeklo.ru;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 200 "ok"; }
}
EOF
sudo ln -sf /etc/nginx/sites-available/botme.neeklo.ru.acme /etc/nginx/sites-enabled/botme.neeklo.ru
sudo nginx -t && sudo systemctl reload nginx
```

**Шаг 6.2.** Выпустить сертификат через webroot (не трогая чужие):

```bash
sudo certbot certonly --webroot -w /var/www/html \
    -d botme.neeklo.ru \
    --cert-name botme.neeklo.ru \
    --non-interactive --no-eff-email --agree-tos \
    -m admin@neeklo.ru
```

**Шаг 6.3.** Заменить временный конфиг на боевой и перечитать:

```bash
sudo ln -sf /etc/nginx/sites-available/botme.neeklo.ru /etc/nginx/sites-enabled/botme.neeklo.ru
sudo nginx -t && sudo systemctl reload nginx
```

### 7. Зарегистрировать домен в HAProxy SNI map

```bash
echo "botme.neeklo.ru bk_nginx" | sudo tee -a /var/lib/haproxy/sni-web.map
sudo systemctl reload haproxy
```

### 8. Проверить публично

```bash
curl -I https://botme.neeklo.ru/api/v1/health
# Браузер: https://botme.neeklo.ru/
# Браузер: https://botme.neeklo.ru/assistant/
```

---

## Обновление кода (CI-loop)

Локально:
```bash
git push origin main
```

На VPS:
```bash
cd /var/www/botme
bash scripts/deploy.sh
```

Скрипт делает `git pull --ff-only`, `npm ci --omit=dev`, `pm2 reload`, smoke-test.

---

## Полезные команды

```bash
pm2 status
pm2 logs botme --lines 100
pm2 reload botme --update-env       # после правки .env
sudo nginx -t && sudo systemctl reload nginx
sudo tail -f /var/log/nginx/botme.neeklo.ru.error.log
sudo certbot renew --dry-run        # проверка автообновления
sudo certbot certificates --cert-name botme.neeklo.ru
```

## Бэкап данных

```bash
cd /var/www/botme
tar -czf "/var/backups/botme-$(date +%F).tar.gz" data/ projects/
```

## Откат версии

```bash
cd /var/www/botme
git log --oneline -10
git checkout <commit_hash>
npm ci --omit=dev
pm2 reload botme
```

## Безопасность

- `.env` не в git (gitignore).
- API-токены ассистентов хранятся как SHA-256 хеши.
- Rate-limit на `/api/v1/chat` per-token (in-memory sliding window).
- Доступ к `meta.json` в `/preview/` заблокирован.
- Базовые security-заголовки в nginx.
