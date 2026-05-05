// Публичный API под bearer-токенами: /api/v1/*
// Используется виджетом (https://botme.neeklo.ru/widget*) и сторонними клиентами.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { db, now } from '../db.js';
import { askAssistant } from '../assistants/chat.js';
import { requireApiToken } from './auth.js';

const router = express.Router();

// =============================================================
// CORS preflight (на всех /api/v1 должен работать с любого origin)
// =============================================================
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// =============================================================
// Подготовленные SQL
// =============================================================
const sql = {
  getAssistant: db.prepare(`SELECT id, name, description, greeting, theme_json, lead_config_json, model FROM assistants WHERE id = ?`),
  insertLead: db.prepare(`
    INSERT INTO leads (id, assistant_id, conversation_id, name, email, phone, message, meta_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
};

function safeJson(s, fallback = null) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }

// =============================================================
// GET /api/v1/assistant — публичная инфа об ассистенте (для виджета)
// Возвращает только то, что безопасно показать на чужом сайте.
// =============================================================
router.get('/assistant', requireApiToken(), (req, res) => {
  const a = sql.getAssistant.get(req.apiToken.assistantId);
  if (!a) return res.status(404).json({ error: 'not_found' });
  res.json({
    id: a.id,
    name: a.name,
    description: a.description || '',
    greeting: a.greeting || '',
    theme: safeJson(a.theme_json) || {},
    lead_config: {
      // Не отдаём наружу триггерные слова и пороги — клиенту это не нужно
      enabled: (safeJson(a.lead_config_json) || {}).enabled !== false,
      fields:  (safeJson(a.lead_config_json) || {}).fields  || ['name', 'phone'],
    },
  });
});

// =============================================================
// POST /api/v1/chat — основной чат
// Body: { message, conversationId?, sessionId?, meta? }
// Query: ?stream=1 → SSE
// =============================================================
router.post('/chat', requireApiToken(), async (req, res) => {
  const { message, conversationId, sessionId } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'bad_request', message: 'message обязателен' });
  }
  const sid = sessionId || req.headers['x-session-id'] || null;
  const meta = {
    url: req.headers.referer || req.headers.origin || null,
    ua:  req.headers['user-agent'] || null,
    ip:  req.ip || req.connection?.remoteAddress || null,
  };
  const stream = req.query.stream === '1' || req.query.stream === 'true';

  const baseArgs = {
    assistantId: req.apiToken.assistantId,
    conversationId: conversationId || null,
    source: 'api',
    sessionId: sid,
    meta,
    message: String(message),
  };

  if (!stream) {
    try {
      const r = await askAssistant(baseArgs);
      return res.json({
        conversation_id: r.conversationId,
        text: r.text,
        model_used: r.modelUsed,
        usage: r.usage,
        elapsed_ms: r.elapsedMs,
        sources: r.retrieval.hits.map((h) => ({ title: h.title, score: h.score, doc_id: h.docId })),
        lead: r.lead,
      });
    } catch (e) {
      console.error('[v1.chat]', e);
      return res.status(500).json({ error: 'chat_failed', message: e.message });
    }
  }

  // ===== SSE streaming =====
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx: отключаем буферизацию
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // keep-alive ping каждые 15 сек на случай долгого ответа
  const keep = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 15_000);

  try {
    const r = await askAssistant({
      ...baseArgs,
      stream: true,
      onDelta: (delta) => send('delta', { text: delta }),
    });
    send('done', {
      conversation_id: r.conversationId,
      model_used: r.modelUsed,
      usage: r.usage,
      sources: r.retrieval.hits.map((h) => ({ title: h.title, score: h.score, doc_id: h.docId })),
      lead: r.lead,
    });
  } catch (e) {
    console.error('[v1.chat.stream]', e);
    send('error', { message: e.message });
  } finally {
    clearInterval(keep);
    res.end();
  }
});

// =============================================================
// POST /api/v1/leads — оставить контакты
// Body: { name?, email?, phone?, message?, conversationId? }
// =============================================================
router.post('/leads', requireApiToken(), (req, res) => {
  const { name, email, phone, message, conversationId } = req.body || {};
  if (!name && !email && !phone) {
    return res.status(400).json({ error: 'bad_request', message: 'нужно хотя бы одно поле: name, email или phone' });
  }
  const id = randomUUID();
  const meta = {
    url: req.headers.referer || req.headers.origin || null,
    ua:  req.headers['user-agent'] || null,
    ip:  req.ip || req.connection?.remoteAddress || null,
    source: 'api',
  };
  sql.insertLead.run(
    id, req.apiToken.assistantId, conversationId || null,
    (name || '').slice(0, 200),
    (email || '').slice(0, 200),
    (phone || '').slice(0, 50),
    (message || '').slice(0, 2000),
    JSON.stringify(meta),
    now(),
  );
  res.json({ id, ok: true });
});

// =============================================================
// GET /api/v1/health — диагностика (без auth)
// =============================================================
router.get('/health', (_req, res) => res.json({ ok: true, time: Date.now() }));

export default router;
