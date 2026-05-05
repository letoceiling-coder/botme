// SQLite (better-sqlite3) — единое хранилище для модуля ассистентов.
// Файл живёт в data/botme.db, рядом — uploads/<assistantId>/<docId>.<ext>.
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

export const DATA_DIR    = path.resolve(__dirname, '..', 'data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const DB_PATH     = path.join(DATA_DIR, 'botme.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// =============================================================
// Миграции (идемпотентные, выполняем при каждом старте)
// =============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS assistants (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT,
    system_prompt   TEXT,
    model           TEXT,
    greeting        TEXT,
    theme_json      TEXT,
    lead_config_json TEXT,
    settings_json   TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id              TEXT PRIMARY KEY,
    assistant_id    TEXT NOT NULL,
    type            TEXT NOT NULL,
    source          TEXT,
    title           TEXT,
    content         TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    error           TEXT,
    char_count      INTEGER DEFAULT 0,
    chunk_count     INTEGER DEFAULT 0,
    created_at      INTEGER NOT NULL,
    FOREIGN KEY (assistant_id) REFERENCES assistants(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_docs_assistant ON documents(assistant_id);

  CREATE TABLE IF NOT EXISTS chunks (
    id              TEXT PRIMARY KEY,
    document_id     TEXT NOT NULL,
    assistant_id    TEXT NOT NULL,
    idx             INTEGER NOT NULL,
    text            TEXT NOT NULL,
    tokens          INTEGER DEFAULT 0,
    embedding       BLOB,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY (assistant_id) REFERENCES assistants(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_chunks_assistant ON chunks(assistant_id);
  CREATE INDEX IF NOT EXISTS idx_chunks_doc       ON chunks(document_id);

  CREATE TABLE IF NOT EXISTS api_tokens (
    id                TEXT PRIMARY KEY,
    assistant_id      TEXT NOT NULL,
    name              TEXT,
    token_hash        TEXT NOT NULL UNIQUE,
    token_prefix      TEXT,
    rate_limit_rpm    INTEGER DEFAULT 60,
    allowed_origins   TEXT DEFAULT '["*"]',
    created_at        INTEGER NOT NULL,
    last_used_at      INTEGER,
    revoked           INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (assistant_id) REFERENCES assistants(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_tokens_assistant ON api_tokens(assistant_id);

  CREATE TABLE IF NOT EXISTS conversations (
    id              TEXT PRIMARY KEY,
    assistant_id    TEXT NOT NULL,
    source          TEXT NOT NULL,
    session_id      TEXT,
    meta_json       TEXT,
    started_at      INTEGER NOT NULL,
    last_at         INTEGER NOT NULL,
    FOREIGN KEY (assistant_id) REFERENCES assistants(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_conv_assistant ON conversations(assistant_id);
  CREATE INDEX IF NOT EXISTS idx_conv_session   ON conversations(session_id);

  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    sources_json    TEXT,
    input_tokens    INTEGER DEFAULT 0,
    output_tokens   INTEGER DEFAULT 0,
    model_used      TEXT,
    created_at      INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);

  CREATE TABLE IF NOT EXISTS leads (
    id              TEXT PRIMARY KEY,
    assistant_id    TEXT NOT NULL,
    conversation_id TEXT,
    name            TEXT,
    email           TEXT,
    phone           TEXT,
    message         TEXT,
    meta_json       TEXT,
    created_at      INTEGER NOT NULL,
    FOREIGN KEY (assistant_id) REFERENCES assistants(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_leads_assistant ON leads(assistant_id);

  CREATE TABLE IF NOT EXISTS assistant_stats (
    assistant_id    TEXT NOT NULL,
    day             TEXT NOT NULL,    -- YYYY-MM-DD
    model           TEXT NOT NULL,
    source          TEXT NOT NULL,    -- admin|widget|api|embeddings|reindex
    calls           INTEGER NOT NULL DEFAULT 0,
    input           INTEGER NOT NULL DEFAULT 0,
    output          INTEGER NOT NULL DEFAULT 0,
    total           INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (assistant_id, day, model, source)
  );

  CREATE TABLE IF NOT EXISTS assistant_notification_settings (
    assistant_id          TEXT PRIMARY KEY,
    email_enabled         INTEGER NOT NULL DEFAULT 0,
    email_to              TEXT,
    email_smtp_host       TEXT,
    email_smtp_port       INTEGER,
    email_smtp_secure     INTEGER NOT NULL DEFAULT 0,
    email_smtp_user       TEXT,
    email_smtp_pass       TEXT,
    email_from_override   TEXT,
    telegram_enabled      INTEGER NOT NULL DEFAULT 0,
    telegram_chat_id      TEXT,
    telegram_bot_token    TEXT,
    vk_enabled            INTEGER NOT NULL DEFAULT 0,
    vk_user_id            TEXT,
    vk_access_token       TEXT,
    updated_at            INTEGER NOT NULL,
    FOREIGN KEY (assistant_id) REFERENCES assistants(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS notification_deliveries (
    id             TEXT PRIMARY KEY,
    lead_id        TEXT NOT NULL,
    assistant_id   TEXT NOT NULL,
    channel        TEXT NOT NULL,
    ok             INTEGER NOT NULL,
    error          TEXT,
    created_at     INTEGER NOT NULL,
    FOREIGN KEY (assistant_id) REFERENCES assistants(id) ON DELETE CASCADE,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_notify_deliver_lead ON notification_deliveries(lead_id);

  CREATE TABLE IF NOT EXISTS app_users (
    id             TEXT PRIMARY KEY,
    email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash  TEXT NOT NULL,
    display_name   TEXT NOT NULL,
    created_at     INTEGER NOT NULL
  );
`);

// =============================================================
// Утилиты
// =============================================================

export function now() { return Date.now(); }

export function today() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Float32Array <-> Buffer для хранения эмбеддингов
export function vecToBlob(arr) {
  const f32 = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}
export function blobToVec(buf) {
  if (!buf) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// Запись в assistant_stats — используется и для генерации ответа, и для embeddings
const incStmt = db.prepare(`
  INSERT INTO assistant_stats (assistant_id, day, model, source, calls, input, output, total)
  VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  ON CONFLICT(assistant_id, day, model, source) DO UPDATE SET
    calls  = calls  + 1,
    input  = input  + excluded.input,
    output = output + excluded.output,
    total  = total  + excluded.total
`);

export function recordAssistantUsage({ assistantId, model, source, input = 0, output = 0 }) {
  if (!assistantId) return;
  const total = input + output;
  try {
    incStmt.run(assistantId, today(), model || 'unknown', source || 'unknown', input, output, total);
  } catch (e) {
    console.warn('[stats] record failed:', e.message);
  }
}

// Безопасное удаление папки uploads ассистента
export function uploadsDirFor(assistantId) {
  return path.join(UPLOADS_DIR, assistantId);
}
