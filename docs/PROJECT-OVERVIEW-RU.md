# Отчёт: архитектура, сервисы и интеграции проекта (AI Site Builder / Botme)

Документ описывает текущее состояние кодовой базы: какие подсистемы есть, какие пакеты используются, как связаны части приложения, какие внешние API подключены и какие возможности это даёт пользователю.

---

## 1. Назначение продукта

Монолитное Node.js-приложение на **Express** с несколькими пользовательскими «фронтами» в `public/`:

| Модуль | Описание |
|--------|----------|
| **AI Site Builder** | Генерация статических сайтов и простых игр (один или несколько файлов в `projects/<uuid>/`), превью в браузере, экспорт. |
| **AI Assistants (RAG)** | Админка ассистентов с базой знаний, индексацией документов, чатом, публичным API и embeddable-виджетом. |
| **Простой агент-чат** | Отдельный чат-маршрут (`/api/agent`, UI в `/agent/` при наличии). |
| **AI Media Studio** | Страница `/media` — node-редактор на canvas, проекты в SQLite, генерация через LLM и (опционально) **Replicate**. |
| **Публичный API v1** | `/api/v1/*` — без cookie-сессии, по Bearer-токену ассистента; для виджета на чужих сайтах. |

Точка входа процесса: **`server-entry.mjs`** (загружает `.env` из корня проекта, затем импортирует **`server.js`**).

---

## 2. Стек и инфраструктура

- **Runtime:** Node.js (ES modules, `"type": "module"`).
- **HTTP:** Express 4, `cors`, `express.json`, `express-session` (cookie-сессия для админки).
- **Данные:** SQLite через **`better-sqlite3`** (`src/db.js` — ассистенты, лиды, уведомления и т.д.). Для Media Studio — отдельные таблицы в `src/media/store.js` (проекты, ранны, загрузки пользователя).
- **Файлы проектов Site Builder:** каталог `projects/<uuid>/` на диске.
- **Медиа:** `data/media/` — артефакты генераций, `_uploads/<owner>/` — пользовательские загрузки.
- **Прод:** обычно **PM2** (`ecosystem.config.cjs`) + **Nginx** reverse proxy (см. `DEPLOY.md`, `deploy/nginx/`).

---

## 3. NPM-зависимости и роль пакетов

| Пакет | Назначение |
|-------|------------|
| `express` | HTTP-сервер, маршруты API и раздача `public/`. |
| `cors` | CORS для API (в т.ч. credentials). |
| `express-session` | Сессии входа в админку (Site Builder, Assistants, `/media`). |
| `dotenv` | Загрузка `.env` в `server-entry.mjs`. |
| `better-sqlite3` | Синхронный SQLite для ассистентов и служебных таблиц. |
| `openai` | Клиент OpenAI + OpenAI-compatible (Ollama, OpenRouter через тот же SDK). |
| `@anthropic-ai/sdk` | Claude. |
| `@google/generative-ai` | Gemini. |
| `multer` | Загрузка файлов (ассистенты: документы; Media: uploads). |
| `jsdom` | Headless-проверка HTML (`runtime-smoke.js`) для детекта ошибок в сгенерированном коде. |
| `cheerio` | Разбор HTML при обработке контента (где применяется в пайплайне знаний/парсинга). |
| `@mozilla/readability` | Извлечение основного текста со страниц (знания по URL). |
| `mammoth` | DOCX → текст. |
| `pdf-parse` | PDF → текст. |
| `xlsx` | Excel для RAG. |
| `gpt-tokenizer` | Подсчёт/чанкинг токенов для RAG. |
| `nodemailer` | Отправка email (уведомления о лидах, опциональный SMTP из `.env`). |

---

## 4. Переменные окружения (ключевые)

Шаблон: **`.env.example`**. Важные группы:

- **LLM:** `OLLAMA_BASE_URL`, `OLLAMA_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` (+ опционально referer/title для OpenRouter).
- **Сервер:** `PORT`, `NODE_ENV`, `SESSION_SECRET` (обязательен в production).
- **Context7:** `CONTEXT7_API_KEY`, `CONTEXT7_DISABLED` — подмешивание актуальной документации библиотек в системный промпт генерации.
- **SMTP (общий):** `SMTP_HOST`, `SMTP_PORT`, … — для системных уведомлений.
- **Replicate (Media):** в коде используется **`REPLICATE_API_TOKEN`** (см. `src/media/providers/replicate.js`); при отсутствии токена генерации через Replicate недоступны.

---

## 5. LLM: провайдеры, модели, фоллбек

Центральный модуль: **`src/llm.js`**.

### Провайдеры

- **Ollama** (OpenAI-compatible URL).
- **OpenAI**.
- **Anthropic (Claude)**.
- **Google Gemini**.
- **OpenRouter** — динамически подмешивает каталог моделей с поддержкой `tools` (кэш ~1 ч).

### Каталог `MODELS` (фрагмент)

В коде перечислены идентификаторы вида `provider:model`, например:

- Ollama: `qwen2.5-coder:7b`, `llama3:latest`
- OpenAI: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.1-codex`, `gpt-4.1-mini`, `gpt-4o`, …
- Claude: Haiku / Sonnet / Opus (актуальные id в `MODELS`).
- Gemini: `gemini-2.0-flash`, `gemini-2.5-flash`, `gemini-2.5-pro`.

### Цепочка **`FALLBACK_PRIORITY`**

При сбоях/квотах вызов может переходить по упорядоченному списку моделей (Haiku → GPT-4o → Gemini Flash → … → Ollama как «хвост»). Детали классификации ошибок — **`src/llm-errors.js`**; таймауты и retry настраиваются через env (`LLM_CALL_TIMEOUT_MS` и др.).

### Где вызывается

- **`POST /api/generate`** — основная генерация сайтов (`server.js` + `callWithFallback`).
- Ассистенты: **`src/assistants/chat.js`** и связанные модули.
- Media Studio: **`src/media/runner.js`** — узел Assistant (синхронный вызов LLM).

---

## 6. Site Builder: как работает пайплайн

1. Клиент (`public/app.js`) шлёт промпт и выбранную модель на **`POST /api/generate`**.
2. В системный промпт может подмешиваться блок из **Context7** (`src/context7.js`) — библиотеки из промпта → сниппеты документации.
3. Ответ модели парсится в файлы (формат `html` или `file:path` — см. огромный **`SYSTEM_PROMPT`** в `server.js`).
4. **Валидатор** `src/project-validator.js` — целостность проекта, опасные паттерны (CDN/npm), обрезанный HTML.
5. **Дым-тест** `src/runtime-smoke.js` (jsdom) — базовая проверка выполнения страницы.
6. При необходимости — дозапросы/ретраи (логика в `server.js`).
7. Файлы пишутся в `projects/<id>/`, превью: **`/preview/:id/...`**.

Дополнительно: **`POST /api/improve-prompt`**, **`GET /api/stats`**, список моделей **`GET /api/models`**.

---

## 7. Аутентификация

- **`src/auth/routes.js`:** `POST /api/auth/login`, `/logout`, `GET /api/auth/me`.
- Пароли: **scrypt** (`src/auth/password.js`), пользователи в SQLite (`app_users`), сид — `src/auth/seed-users.js`.
- **`src/auth/middleware.js` (`appAuthGate`):** всё приложение защищено сессией, **кроме** публичных путей: логин, `/api/v1`, `/widget.js`, `/widget/`, `/brand/`, статики виджета.

Сессия хранит `userId`, `email`, `displayName`.

---

## 8. AI Assistants + RAG + уведомления

- **Маршруты:** `/api/assistants/*` — `src/assistants/routes.js`.
- **Знания:** загрузка документов, URL, парсинг PDF/DOCX/XLSX, чанки, эмбеддинги OpenAI `text-embedding-3-small` (`src/assistants/embeddings.js`).
- **Поиск:** косинусное сходство + кеш (`src/assistants/rag.js`).
- **Чат:** `src/assistants/chat.js` (в т.ч. SSE).
- **Уведомления о лидах:** `src/notifications/*` — email (Nodemailer), Telegram, VK и журнал доставок.

---

## 9. Публичный API и виджет

- **`/api/v1/*`** — `src/public-api/routes.js` + `src/public-api/auth.js`.
- Аутентификация: `Authorization: Bearer ast_<token>`.
- Эндпоинты: информация об ассистенте, чат (опционально stream), лиды, health — см. README.
- Статика виджета: `public/widget.js`, `public/widget/`.

---

## 10. AI Media Studio (`/media`)

- **Фронт:** `public/media/*` — SVG-canvas, узлы, связи, Media Manager.
- **API:** `/api/media/*` — `src/media/routes.js` (CRUD проектов, runs, assets, uploads).
- **Хранилище:** SQLite + файлы на диске; статика результатов: `/media-files/...`, загрузки: `/media-uploads/:id`.
- **Replicate:** `src/media/providers/replicate.js` — карта внутренних имён моделей → `owner/name` на Replicate (image/video/upscale); выполнение в **`src/media/runner.js`** с polling.
- **LLM-узел Assistant:** синхронный вызов через тот же `callWithFallback`.

### Возможности UX (уровень продукта)

- Проекты графа, сохранение, зум/панорама, связи между узлами с типами портов.
- Выбор референсов через Media Manager; загрузка файлов пользователем; история генераций.
- Узлы в разработке / частично заглушки: см. типы в `public/media/nodes.js` и дорожную карту в чате/туду.

---

## 11. Контекстные интеграции (внешние сервисы)

| Сервис | Роль |
|--------|------|
| OpenAI / Anthropic / Google / Ollama / OpenRouter | Генерация текста и кода. |
| OpenAI embeddings | RAG у ассистентов. |
| Context7 API | Актуальные доки библиотек в промпт Site Builder. |
| Replicate | Генерация изображений/видео/upscale в Media Studio (при наличии токена и баланса). |
| SMTP / Telegram / VK | Уведомления о лидах. |

---

## 12. Возможности для пользователя (сводка)

- Генерация **одностраничных и многофайловых** сайтов с жёстким форматом ответа и превью.
- Выбор **множества моделей** и **автоматический фоллбек** при ошибках провайдера.
- **Проверка качества** сгенерированного HTML (валидатор + дым-тест в jsdom).
- **RAG-ассистенты** с документами, публичным API и **встраиваемым виджетом**.
- Сбор **лидов** и **уведомления** в мессенджеры/почту.
- **Media Studio** для визуального конструирования пайплайнов и привязки к генераторам (LLM + Replicate).
- **Защищённая админка** сессией; публичный API и виджет работают по токенам без обязательного входа на сайт.

---

*Документ сгенерирован по состоянию репозитория; при изменении кода актуализируйте разделы API и списки моделей по `src/llm.js` и `server.js`.*
