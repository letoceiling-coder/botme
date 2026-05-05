// REST-эндпоинты модуля ассистентов /api/assistants/*
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { db, now, vecToBlob, UPLOADS_DIR, uploadsDirFor } from '../db.js';
import {
  parseTextFile, parsePdfFile, parseDocxFile, fetchAndParseUrl, chunkText,
} from './knowledge.js';
import { embedTexts } from './embeddings.js';
import { invalidateAssistantCache } from './rag.js';
import { askAssistant } from './chat.js';
import {
  generateApiToken, listAssistantTokens, revokeToken, deleteToken,
} from '../public-api/auth.js';
import { generateKnowledgeBase, enrichDocument } from './kb-generator.js';

const router = express.Router();

// =============================================================
// Multer: загрузка в память, потом пишем сами в нужную папку
// =============================================================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

// =============================================================
// Подготовленные SQL-запросы
// =============================================================
const ALLOWED_DOC_TYPES = new Set(['text', 'url', 'pdf', 'docx', 'md', 'txt']);

const sql = {
  insertAssistant: db.prepare(`
    INSERT INTO assistants (id, name, description, system_prompt, model, greeting, theme_json, lead_config_json, settings_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  listAssistants: db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM documents WHERE assistant_id = a.id) AS doc_count,
      (SELECT COUNT(*) FROM chunks    WHERE assistant_id = a.id) AS chunk_count,
      (SELECT COUNT(*) FROM leads     WHERE assistant_id = a.id) AS lead_count,
      (SELECT COALESCE(SUM(total),0) FROM assistant_stats WHERE assistant_id = a.id) AS tokens_total
    FROM assistants a
    ORDER BY a.updated_at DESC
  `),
  getAssistant: db.prepare(`SELECT * FROM assistants WHERE id = ?`),
  patchAssistant: db.prepare(`
    UPDATE assistants
       SET name = COALESCE(?, name),
           description = COALESCE(?, description),
           system_prompt = COALESCE(?, system_prompt),
           model = COALESCE(?, model),
           greeting = COALESCE(?, greeting),
           theme_json = COALESCE(?, theme_json),
           lead_config_json = COALESCE(?, lead_config_json),
           settings_json = COALESCE(?, settings_json),
           updated_at = ?
     WHERE id = ?
  `),
  deleteAssistant: db.prepare(`DELETE FROM assistants WHERE id = ?`),

  insertDoc: db.prepare(`
    INSERT INTO documents (id, assistant_id, type, source, title, content, status, error, char_count, chunk_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateDocAfterParse: db.prepare(`
    UPDATE documents SET title = ?, content = ?, status = ?, error = ?, char_count = ?, updated_at_dummy = ? WHERE id = ?
  `.replace('updated_at_dummy = ?', 'char_count = char_count')),
  setDocStatus: db.prepare(`UPDATE documents SET status = ?, error = ? WHERE id = ?`),
  setDocReady:  db.prepare(`UPDATE documents SET status = 'ready', error = NULL, content = ?, char_count = ?, chunk_count = ?, title = COALESCE(?, title) WHERE id = ?`),
  listDocs: db.prepare(`SELECT id, type, source, title, status, error, char_count, chunk_count, created_at FROM documents WHERE assistant_id = ? ORDER BY created_at DESC`),
  getDoc:  db.prepare(`SELECT * FROM documents WHERE id = ? AND assistant_id = ?`),
  deleteDoc: db.prepare(`DELETE FROM documents WHERE id = ? AND assistant_id = ?`),
  deleteDocChunks: db.prepare(`DELETE FROM chunks WHERE document_id = ?`),
  insertChunk: db.prepare(`INSERT INTO chunks (id, document_id, assistant_id, idx, text, tokens, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  listChunksByDoc: db.prepare(`SELECT id, idx, text, tokens FROM chunks WHERE document_id = ? ORDER BY idx ASC`),

  listConversations: db.prepare(`
    SELECT c.id, c.source, c.session_id, c.started_at, c.last_at,
      (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS message_count,
      (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'user' ORDER BY created_at ASC LIMIT 1) AS first_user_msg
    FROM conversations c WHERE c.assistant_id = ?
    ORDER BY c.last_at DESC LIMIT 200
  `),
  listMessages: db.prepare(`SELECT id, role, content, sources_json, input_tokens, output_tokens, model_used, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`),
  getConversationOwner: db.prepare(`SELECT assistant_id FROM conversations WHERE id = ?`),

  listLeads: db.prepare(`SELECT * FROM leads WHERE assistant_id = ? ORDER BY created_at DESC`),
  deleteLead: db.prepare(`DELETE FROM leads WHERE id = ? AND assistant_id = ?`),

  statsByDay:    db.prepare(`SELECT day, SUM(calls) AS calls, SUM(input) AS input, SUM(output) AS output, SUM(total) AS total FROM assistant_stats WHERE assistant_id = ? GROUP BY day ORDER BY day DESC LIMIT 30`),
  statsByModel:  db.prepare(`SELECT model, SUM(calls) AS calls, SUM(input) AS input, SUM(output) AS output, SUM(total) AS total FROM assistant_stats WHERE assistant_id = ? GROUP BY model ORDER BY total DESC`),
  statsBySource: db.prepare(`SELECT source, SUM(calls) AS calls, SUM(input) AS input, SUM(output) AS output, SUM(total) AS total FROM assistant_stats WHERE assistant_id = ? GROUP BY source ORDER BY total DESC`),
  statsTotal:    db.prepare(`SELECT SUM(calls) AS calls, SUM(input) AS input, SUM(output) AS output, SUM(total) AS total FROM assistant_stats WHERE assistant_id = ?`),
};

// =============================================================
// Помощники
// =============================================================
function safeJson(s, fallback = null) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }

function serializeAssistant(a) {
  if (!a) return null;
  return {
    id: a.id,
    name: a.name,
    description: a.description || '',
    system_prompt: a.system_prompt || '',
    model: a.model,
    greeting: a.greeting || '',
    theme: safeJson(a.theme_json) || {},
    lead_config: safeJson(a.lead_config_json) || {},
    settings: safeJson(a.settings_json) || {},
    created_at: a.created_at,
    updated_at: a.updated_at,
    doc_count: a.doc_count ?? undefined,
    chunk_count: a.chunk_count ?? undefined,
    lead_count: a.lead_count ?? undefined,
    tokens_total: a.tokens_total ?? undefined,
  };
}

const DEFAULTS = {
  model: 'claude:claude-haiku-4-5-20251001',
  greeting: 'Здравствуйте! Я AI-ассистент. Задайте любой вопрос — отвечу опираясь на нашу базу знаний.',
  system_prompt: 'Ты — вежливый и точный AI-ассистент компании. Отвечай по существу, опираясь на базу знаний. Если в базе нет ответа — честно скажи об этом и предложи оставить контакты.',
  theme: { color: '#7c5cff', position: 'br', avatar: '', brand: '', dark: true },
  lead_config: { triggers: ['contact', 'price', 'order', 'купить', 'цена', 'заказ', 'контакт'], minMessages: 3, enabled: true, fields: ['name', 'phone'] },
  settings: { temperature: 0.4, top_k_chunks: 5, min_score: 0.15, max_tokens: 2048 },
};

// =============================================================
// CRUD ассистентов
// =============================================================
router.get('/', (_req, res) => {
  const list = sql.listAssistants.all().map(serializeAssistant);
  res.json(list);
});

router.post('/', (req, res) => {
  const id = randomUUID();
  const t = now();
  const b = req.body || {};
  sql.insertAssistant.run(
    id,
    (b.name || 'Новый ассистент').slice(0, 200),
    (b.description || '').slice(0, 500),
    (b.system_prompt || DEFAULTS.system_prompt),
    (b.model || DEFAULTS.model),
    (b.greeting || DEFAULTS.greeting),
    JSON.stringify(b.theme || DEFAULTS.theme),
    JSON.stringify(b.lead_config || DEFAULTS.lead_config),
    JSON.stringify(b.settings || DEFAULTS.settings),
    t, t,
  );
  res.json(serializeAssistant(sql.getAssistant.get(id)));
});

router.get('/:id', (req, res) => {
  const a = sql.getAssistant.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(serializeAssistant(a));
});

router.patch('/:id', (req, res) => {
  const id = req.params.id;
  const a = sql.getAssistant.get(id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  sql.patchAssistant.run(
    b.name !== undefined ? String(b.name).slice(0, 200) : null,
    b.description !== undefined ? String(b.description).slice(0, 500) : null,
    b.system_prompt !== undefined ? String(b.system_prompt) : null,
    b.model !== undefined ? String(b.model) : null,
    b.greeting !== undefined ? String(b.greeting) : null,
    b.theme !== undefined ? JSON.stringify(b.theme) : null,
    b.lead_config !== undefined ? JSON.stringify(b.lead_config) : null,
    b.settings !== undefined ? JSON.stringify(b.settings) : null,
    now(), id,
  );
  res.json(serializeAssistant(sql.getAssistant.get(id)));
});

router.delete('/:id', async (req, res) => {
  const id = req.params.id;
  if (!sql.getAssistant.get(id)) return res.status(404).json({ error: 'not found' });
  sql.deleteAssistant.run(id); // каскадно почистит documents/chunks/conversations/messages/leads/api_tokens
  invalidateAssistantCache(id);
  try { await fs.rm(uploadsDirFor(id), { recursive: true, force: true }); } catch {}
  res.json({ ok: true });
});

// =============================================================
// Документы (база знаний)
// =============================================================
router.get('/:id/documents', (req, res) => {
  const a = sql.getAssistant.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(sql.listDocs.all(req.params.id));
});

router.get('/:id/documents/:docId', (req, res) => {
  const doc = sql.getDoc.get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  doc.chunks = sql.listChunksByDoc.all(doc.id);
  res.json(doc);
});

router.delete('/:id/documents/:docId', async (req, res) => {
  const doc = sql.getDoc.get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  sql.deleteDoc.run(doc.id, req.params.id); // каскадно удалит чанки
  invalidateAssistantCache(req.params.id);
  if (doc.source && (doc.type === 'pdf' || doc.type === 'docx' || doc.type === 'txt' || doc.type === 'md')) {
    const filePath = path.join(uploadsDirFor(req.params.id), path.basename(doc.source));
    try { await fs.rm(filePath, { force: true }); } catch {}
  }
  res.json({ ok: true });
});

// Загрузка файла (PDF/DOCX/TXT/MD)
router.post('/:id/documents/file', upload.single('file'), async (req, res) => {
  try {
    const a = sql.getAssistant.get(req.params.id);
    if (!a) return res.status(404).json({ error: 'not found' });
    if (!req.file) return res.status(400).json({ error: 'file обязателен (multipart/form-data)' });

    const orig = req.file.originalname || 'file';
    const ext = (path.extname(orig).toLowerCase().replace('.', '') || 'txt');
    const type = ({ pdf: 'pdf', docx: 'docx', md: 'md', markdown: 'md', txt: 'txt' })[ext];
    if (!type) return res.status(400).json({ error: `Неподдерживаемый формат: .${ext}. Только pdf/docx/md/txt` });

    const docId = randomUUID();
    const dir = uploadsDirFor(req.params.id);
    await fs.mkdir(dir, { recursive: true });
    const safeName = `${docId}.${ext}`;
    const filePath = path.join(dir, safeName);
    await fs.writeFile(filePath, req.file.buffer);

    sql.insertDoc.run(docId, req.params.id, type, safeName, orig, '', 'pending', null, 0, 0, now());
    res.json({ id: docId, status: 'pending' });

    // Парсим в фоне
    processDocumentInBackground({ assistantId: req.params.id, docId, type, filePath, originalName: orig });
  } catch (e) {
    console.error('[upload]', e);
    res.status(500).json({ error: e.message });
  }
});

// Добавить произвольный текст
router.post('/:id/documents/text', async (req, res) => {
  const a = sql.getAssistant.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const { title, content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: 'content обязателен' });

  const docId = randomUUID();
  sql.insertDoc.run(docId, req.params.id, 'text', null, (title || 'Текст').slice(0, 200), content, 'pending', null, content.length, 0, now());
  res.json({ id: docId, status: 'pending' });

  processDocumentInBackground({ assistantId: req.params.id, docId, type: 'text', rawContent: content, originalName: title || 'Текст' });
});

// Добавить URL
router.post('/:id/documents/url', async (req, res) => {
  const a = sql.getAssistant.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'нужен валидный http(s) URL' });

  const docId = randomUUID();
  sql.insertDoc.run(docId, req.params.id, 'url', url, url, '', 'pending', null, 0, 0, now());
  res.json({ id: docId, status: 'pending' });

  processDocumentInBackground({ assistantId: req.params.id, docId, type: 'url', url });
});

// =============================================================
// AI-генератор базы знаний
// POST /:id/documents/generate { description, tone?, targetCount?, modelId? }
// Создаёт пакет документов через LLM и сразу запускает их обработку
// (chunking + embeddings) в фоне. Возвращает список новых doc_id со статусами.
// =============================================================
router.post('/:id/documents/generate', async (req, res) => {
  try {
    const a = sql.getAssistant.get(req.params.id);
    if (!a) return res.status(404).json({ error: 'not found' });
    const { description, tone, targetCount, modelId } = req.body || {};
    if (!description || !description.trim()) {
      return res.status(400).json({ error: 'description обязателен' });
    }

    // Длительная операция (до 60 сек) — поэтому ставим увеличенный timeout на ответ
    req.setTimeout(120_000);
    res.setTimeout?.(120_000);

    const result = await generateKnowledgeBase({
      description, tone, targetCount, modelId,
      assistantId: req.params.id,
    });

    const created = [];
    for (const d of result.documents) {
      const docId = randomUUID();
      sql.insertDoc.run(
        docId, req.params.id, 'text', null,
        d.title.slice(0, 200), d.content,
        'pending', null, d.content.length, 0, now(),
      );
      created.push({ id: docId, title: d.title, kind: d.kind, status: 'pending' });
      // Чанкинг + embeddings — в фоне
      processDocumentInBackground({
        assistantId: req.params.id, docId, type: 'text',
        rawContent: d.content, originalName: d.title,
      });
    }

    res.json({
      ok: true,
      documents: created,
      modelUsed: result.modelUsed,
      fallbackFrom: result.fallbackFrom,
      usage: result.usage,
    });
  } catch (e) {
    console.error('[kb-generate]', e);
    res.status(500).json({ error: e.message });
  }
});

// =============================================================
// Обогатить существующий документ (структурировать, реоформить)
// POST /:id/documents/:docId/enrich  { hint?, modelId?, replace?:true }
// При replace=true заменяет content существующего документа и переиндексирует.
// Иначе создаёт НОВЫЙ документ-улучшение (а старый остаётся).
// =============================================================
router.post('/:id/documents/:docId/enrich', async (req, res) => {
  try {
    const doc = sql.getDoc.get(req.params.docId, req.params.id);
    if (!doc || !doc.content) return res.status(404).json({ error: 'not found' });
    const { hint, modelId, replace } = req.body || {};

    req.setTimeout(120_000);
    res.setTimeout?.(120_000);

    const result = await enrichDocument({
      rawContent: doc.content, hint, modelId,
      assistantId: req.params.id,
    });

    if (replace) {
      // Очистим старые чанки и переиндексируем тот же документ
      sql.deleteDocChunks.run(doc.id);
      sql.setDocStatus.run('chunking', null, doc.id);
      processDocumentInBackground({
        assistantId: req.params.id, docId: doc.id, type: 'text',
        rawContent: result.document.content, originalName: result.document.title,
      });
      // Заголовок поправим сразу (content обновится в setDocReady)
      db.prepare(`UPDATE documents SET title = ? WHERE id = ?`).run(result.document.title, doc.id);
      return res.json({ ok: true, replaced: doc.id, modelUsed: result.modelUsed, usage: result.usage });
    }

    // Создаём новый документ-улучшение
    const newId = randomUUID();
    const title = `${result.document.title} (AI)`;
    sql.insertDoc.run(
      newId, req.params.id, 'text', null,
      title.slice(0, 200), result.document.content,
      'pending', null, result.document.content.length, 0, now(),
    );
    processDocumentInBackground({
      assistantId: req.params.id, docId: newId, type: 'text',
      rawContent: result.document.content, originalName: title,
    });
    res.json({ ok: true, created: { id: newId, title }, modelUsed: result.modelUsed, usage: result.usage });
  } catch (e) {
    console.error('[kb-enrich]', e);
    res.status(500).json({ error: e.message });
  }
});

// Пересчитать эмбеддинги для всего ассистента (если меняли модель/настройки)
router.post('/:id/reindex', async (req, res) => {
  const a = sql.getAssistant.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const docs = sql.listDocs.all(req.params.id);
  res.json({ ok: true, documents: docs.length });

  for (const d of docs) {
    try {
      const full = sql.getDoc.get(d.id, req.params.id);
      if (!full?.content) continue;
      sql.deleteDocChunks.run(d.id);
      sql.setDocStatus.run('chunking', null, d.id);
      await chunkAndEmbed({ assistantId: req.params.id, docId: d.id, content: full.content, title: d.title });
      sql.setDocReady.run(full.content, full.content.length, sql.listChunksByDoc.all(d.id).length, full.title, d.id);
    } catch (e) {
      sql.setDocStatus.run('error', e.message.slice(0, 500), d.id);
    }
  }
  invalidateAssistantCache(req.params.id);
});

// =============================================================
// Чат админа (тестовый). При ?stream=1 — SSE.
// =============================================================
router.post('/:id/chat', async (req, res) => {
  try {
    const a = sql.getAssistant.get(req.params.id);
    if (!a) return res.status(404).json({ error: 'not found' });
    const { message, conversationId } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message обязателен' });

    const stream = req.query.stream === '1' || req.query.stream === 'true';

    if (!stream) {
      const result = await askAssistant({
        assistantId: req.params.id,
        conversationId: conversationId || null,
        source: 'admin',
        message,
      });
      return res.json(result);
    }

    // SSE
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const keep = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 15_000);

    try {
      const r = await askAssistant({
        assistantId: req.params.id,
        conversationId: conversationId || null,
        source: 'admin',
        message,
        stream: true,
        onDelta: (delta) => send('delta', { text: delta }),
      });
      send('done', {
        conversationId: r.conversationId,
        modelUsed: r.modelUsed,
        usage: r.usage,
        retrieval: r.retrieval,
        lead: r.lead,
      });
    } catch (e) {
      send('error', { message: e.message });
    } finally {
      clearInterval(keep);
      res.end();
    }
  } catch (e) {
    console.error('[chat]', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// =============================================================
// Разговоры и сообщения
// =============================================================
router.get('/:id/conversations', (req, res) => {
  if (!sql.getAssistant.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json(sql.listConversations.all(req.params.id));
});

router.get('/:id/conversations/:cid', (req, res) => {
  const owner = sql.getConversationOwner.get(req.params.cid);
  if (!owner || owner.assistant_id !== req.params.id) return res.status(404).json({ error: 'not found' });
  res.json({ id: req.params.cid, messages: sql.listMessages.all(req.params.cid) });
});

// =============================================================
// Лиды
// =============================================================
router.get('/:id/leads', (req, res) => {
  if (!sql.getAssistant.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json(sql.listLeads.all(req.params.id));
});

router.delete('/:id/leads/:leadId', (req, res) => {
  const r = sql.deleteLead.run(req.params.leadId, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// CSV-экспорт всех лидов ассистента
router.get('/:id/leads.csv', (req, res) => {
  if (!sql.getAssistant.get(req.params.id)) return res.status(404).send('not found');
  const rows = sql.listLeads.all(req.params.id);
  const head = ['date', 'name', 'email', 'phone', 'message', 'conversation_id'];
  const csv = [head.join(',')];
  for (const r of rows) {
    csv.push([
      new Date(r.created_at).toISOString(),
      r.name, r.email, r.phone, r.message, r.conversation_id || '',
    ].map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leads-${req.params.id.slice(0, 8)}.csv"`);
  res.send('\uFEFF' + csv.join('\n'));
});

function csvCell(v) {
  const s = String(v ?? '').replace(/"/g, '""');
  return /[",\n;]/.test(s) ? `"${s}"` : s;
}

// =============================================================
// API-токены публичного доступа
// =============================================================
router.get('/:id/tokens', (req, res) => {
  if (!sql.getAssistant.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json(listAssistantTokens(req.params.id));
});

router.post('/:id/tokens', (req, res) => {
  if (!sql.getAssistant.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  const { name, rateLimitRpm, allowedOrigins } = req.body || {};
  const created = generateApiToken(req.params.id, {
    name,
    rateLimitRpm: Number.isFinite(rateLimitRpm) ? rateLimitRpm : 60,
    allowedOrigins: Array.isArray(allowedOrigins) && allowedOrigins.length ? allowedOrigins : ['*'],
  });
  // plainToken возвращается ТОЛЬКО ЗДЕСЬ — больше нигде увидеть нельзя
  res.json(created);
});

router.post('/:id/tokens/:tokenId/revoke', (req, res) => {
  const ok = revokeToken(req.params.tokenId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

router.delete('/:id/tokens/:tokenId', (req, res) => {
  const ok = deleteToken(req.params.tokenId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// =============================================================
// Статистика
// =============================================================
router.get('/:id/stats', (req, res) => {
  if (!sql.getAssistant.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({
    total:    sql.statsTotal.get(req.params.id) || { calls: 0, input: 0, output: 0, total: 0 },
    byDay:    sql.statsByDay.all(req.params.id),
    byModel:  sql.statsByModel.all(req.params.id),
    bySource: sql.statsBySource.all(req.params.id),
  });
});

// =============================================================
// Фоновая обработка документа: parse → chunk → embed
// =============================================================
async function processDocumentInBackground({ assistantId, docId, type, filePath, url, rawContent, originalName }) {
  try {
    sql.setDocStatus.run('chunking', null, docId);
    let title = originalName || '';
    let content = '';

    if (type === 'pdf') {
      content = await parsePdfFile(filePath);
    } else if (type === 'docx') {
      content = await parseDocxFile(filePath);
    } else if (type === 'md' || type === 'txt') {
      content = await parseTextFile(filePath);
    } else if (type === 'url') {
      const r = await fetchAndParseUrl(url);
      title = r.title || url;
      content = r.content;
    } else if (type === 'text') {
      content = rawContent || '';
    }

    if (!content || !content.trim()) throw new Error('Не удалось извлечь текст из источника.');

    await chunkAndEmbed({ assistantId, docId, content, title });
    const chunkCount = sql.listChunksByDoc.all(docId).length;
    sql.setDocReady.run(content, content.length, chunkCount, title, docId);
    invalidateAssistantCache(assistantId);
  } catch (e) {
    console.error('[bg]', docId, e);
    sql.setDocStatus.run('error', String(e.message || e).slice(0, 500), docId);
  }
}

async function chunkAndEmbed({ assistantId, docId, content, title }) {
  const chunks = chunkText(content);
  if (!chunks.length) return;
  const { vectors } = await embedTexts(chunks.map((c) => c.text), { assistantId, source: 'embeddings' });

  const tx = db.transaction((rows) => {
    for (const row of rows) sql.insertChunk.run(row.id, row.docId, row.assistantId, row.idx, row.text, row.tokens, row.embedding);
  });
  const rows = chunks.map((c, i) => ({
    id: randomUUID(),
    docId,
    assistantId,
    idx: c.idx,
    text: c.text,
    tokens: c.tokens || 0,
    embedding: vectors[i] ? vecToBlob(vectors[i]) : null,
  }));
  tx(rows);
}

export default router;
