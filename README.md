# botme.neeklo.ru — AI Site Builder + AI Assistants (RAG)

Универсальная платформа из двух модулей:

1. **AI Site Builder** — чат-агент собирает рабочие **сайты** и **браузерные игры** (HTML + Tailwind + JS, опционально многостраничные и React-проекты через CDN). Файлы лежат в `projects/<uuid>/`, открываются двойным кликом, скачиваются как `.html` или `.zip`.
2. **AI Ассистенты с RAG** — создание ассистентов с собственной базой знаний (документы, URL, PDF, DOCX, **Excel xlsx/xls**), векторный поиск, чат-тест, публичный API с токенами и rate-limit, embeddable-виджет с темами и сбором лидов.

Поддержка четырёх провайдеров моделей:

| Провайдер | Модели по умолчанию |
|-----------|--------------------|
| **Ollama** (через `ollama.siteaacess.store`) | `qwen2.5-coder:7b`, `llama3:latest` |
| **OpenAI** | `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.1-codex`, `gpt-4.1-mini`, `gpt-4o` |
| **Anthropic Claude** | `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5` |
| **Google Gemini** | `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash` |

Эмбеддинги для RAG: `text-embedding-3-small` (OpenAI).

## Структура

```
botme/
├── server.js                     — точка входа Express
├── ecosystem.config.cjs          — PM2-конфиг для прод-сервера
├── package.json
├── .env.example                  — шаблон переменных (.env в .gitignore)
├── DEPLOY.md                     — пошаговая инструкция деплоя
│
├── src/
│   ├── llm.js                    — единый роутер OpenAI/Claude/Gemini/Ollama + статистика
│   ├── db.js                     — better-sqlite3 + миграции (8 таблиц)
│   ├── assistants/
│   │   ├── routes.js             — /api/assistants/* (админка)
│   │   ├── knowledge.js          — парсинг (txt/url/pdf/docx/xlsx) + чанкинг 600 токенов
│   │   ├── embeddings.js         — OpenAI embeddings (батч 100, retry)
│   │   ├── rag.js                — in-memory cosine similarity + LRU кеш
│   │   ├── chat.js               — askAssistant() + лид-триггеры + SSE
│   │   └── kb-generator.js       — AI-агент создаёт базу знаний по описанию бизнеса
│   └── public-api/
│       ├── auth.js               — ast_<32hex>, SHA-256, rate-limit, CORS
│       └── routes.js             — /api/v1/chat (SSE) + /api/v1/leads + /api/v1/assistant
│
├── public/
│   ├── index.html  app.js  style.css      — Site Builder UI
│   ├── assistant/                          — Admin-SPA для ассистентов
│   │   ├── index.html  assistant.html  app.js  style.css
│   ├── widget.js                           — embeddable loader
│   ├── widget/index.html                   — iframe-чат
│   └── widget-demo.html                    — тестовая страница
│
├── deploy/
│   └── nginx/botme.neeklo.ru.conf          — nginx-шаблон с поддержкой SSE
├── scripts/
│   └── deploy.sh                           — git pull + npm ci + pm2 reload
│
├── projects/                     — runtime, в .gitignore
└── data/                         — SQLite + uploads, в .gitignore
```

## Локальный запуск

```bash
npm install
cp .env.example .env       # подставить реальные ключи
npm start                  # http://localhost:3001
```

Откройте:
- `http://localhost:3001/` — Site Builder
- `http://localhost:3001/assistant/` — Ассистенты с RAG
- `http://localhost:3001/widget-demo.html?token=ast_...` — тест виджета

## Деплой на VPS (botme.neeklo.ru)

Архитектура сервера: HAProxy(:443, SNI passthrough) → Nginx(127.0.0.1:9443, SSL) → Node(127.0.0.1:3015) под PM2. Полная пошаговая инструкция — **[DEPLOY.md](./DEPLOY.md)**.

Обновления — `git push` локально, на сервере `bash scripts/deploy.sh`.

## API

### Site Builder
- `GET  /api/models` — список моделей
- `GET  /api/projects` / `GET /api/projects/:id` / `DELETE /api/projects/:id`
- `POST /api/generate` `{ projectId, prompt, model }`
- `POST /api/improve-prompt` `{ rawPrompt }`
- `GET  /api/stats` — статистика токенов
- `GET  /preview/:id/...` — статика превью

### Ассистенты — админ
- `POST /api/assistants` / `GET /api/assistants` / `GET|PATCH|DELETE /api/assistants/:id`
- Документы: `GET|POST /api/assistants/:id/documents`, upload, URL, text, view, delete
- **`POST /api/assistants/:id/documents/generate`** — AI-агент создаёт пакет документов по описанию бизнеса и автоматически индексирует
- **`POST /api/assistants/:id/documents/:docId/enrich`** — AI-агент структурирует/расширяет существующий документ
- `POST /api/assistants/:id/chat[?stream=1]` — тест-чат (SSE опционально)
- `GET /api/assistants/:id/conversations[/:cid]`
- `GET|POST /api/assistants/:id/tokens`, `POST .../revoke`, `DELETE .../:tid`
- `GET /api/assistants/:id/leads[.csv]`, `DELETE .../:leadId`
- `GET /api/assistants/:id/stats`

### Публичный API (для виджета и сторонних приложений)
Bearer-аутентификация: `Authorization: Bearer ast_<32hex>`. CORS=*. Rate-limit per-token.
- `GET  /api/v1/assistant` — публичная информация (тема, имя, приветствие)
- `POST /api/v1/chat[?stream=1]` `{ message, sessionId?, conversationId? }` — RAG + SSE
- `POST /api/v1/leads` `{ conversationId, name?, phone?, email?, ... }`
- `GET  /api/v1/health`

## Виджет

Встраивается одной строкой в любой HTML:
```html
<script async src="https://botme.neeklo.ru/widget.js" data-token="ast_..."></script>
```
Появится плавающая кнопка с темой ассистента, открытие — iframe-чат с SSE, источниками RAG и формой лида при триггерах.

## Технологии

- **Backend:** Node.js 20+ (ESM), Express, better-sqlite3
- **AI SDK:** `openai`, `@anthropic-ai/sdk`, `@google/generative-ai`
- **RAG:** OpenAI embeddings + in-memory cosine + LRU
- **Парсеры:** `pdf-parse`, `mammoth` (DOCX), `xlsx` (Excel), `cheerio` + `@mozilla/readability` (URL)
- **Токены:** `gpt-tokenizer` (чанкинг)
- **Загрузки:** `multer`
- **Frontend:** vanilla JS + Tailwind CDN, без сборки

## Безопасность

- `.env` в `.gitignore` (никогда не коммитить).
- API-токены ассистентов хранятся как SHA-256 хеш, plain показывается один раз при создании.
- Rate-limit per-token (in-memory sliding window).
- `meta.json` и системные файлы заблокированы в `/preview/...`.
- Базовые security-заголовки в nginx.
