// Чат с ассистентом: RAG → LLM → сохранение в conversations + messages.
import { randomUUID } from 'node:crypto';
import { db, now } from '../db.js';
import { callWithFallback } from '../llm.js';
import { retrieveTopK, buildRagSystem } from './rag.js';

const insertConversation = db.prepare(`
  INSERT INTO conversations (id, assistant_id, source, session_id, meta_json, started_at, last_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const updateConversationLast = db.prepare(`UPDATE conversations SET last_at = ? WHERE id = ?`);
const getConversation = db.prepare(`SELECT * FROM conversations WHERE id = ?`);
const insertMessage = db.prepare(`
  INSERT INTO messages (id, conversation_id, role, content, sources_json, input_tokens, output_tokens, model_used, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const recentMessages = db.prepare(`
  SELECT role, content FROM messages WHERE conversation_id = ?
  ORDER BY created_at ASC LIMIT 20
`);
const countMessages = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?`);
const findConversationBySession = db.prepare(`
  SELECT * FROM conversations WHERE assistant_id = ? AND session_id = ? ORDER BY last_at DESC LIMIT 1
`);

const getAssistant = db.prepare(`SELECT * FROM assistants WHERE id = ?`);

// =============================================================
// Триггеры лидов (анализируем последний user-вопрос + ответ модели)
// =============================================================
const DEFAULT_TRIGGER_WORDS = [
  'купить','купим','купите','куплю','заказать','заказ','заказы','оформить заказ','оформить',
  'цена','цены','стоимость','стоит','сколько стоит','прайс',
  'контакт','контакты','связаться','свяжитесь','перезвоните','перезвонить','оставить заявку',
  'хочу','помогите','нужно','скидка','доставка','оплата',
  'price','order','buy','contact','quote','call me',
];

function detectLeadTrigger({ leadConfig, userMessage, assistantText, totalMessages }) {
  const cfg = leadConfig || {};
  if (cfg.enabled === false) return { shouldOfferLead: false, reason: null };

  const triggers = (cfg.triggers && cfg.triggers.length ? cfg.triggers : DEFAULT_TRIGGER_WORDS)
    .map((s) => String(s).toLowerCase());
  const minMessages = Number.isFinite(cfg.minMessages) ? cfg.minMessages : 3;

  const haystack = `${userMessage || ''}\n${assistantText || ''}`.toLowerCase();
  for (const t of triggers) {
    if (t && haystack.includes(t)) {
      return { shouldOfferLead: true, reason: 'keyword', matched: t };
    }
  }
  if (totalMessages >= minMessages * 2) {
    // *2 потому что считаем пары (user+assistant)
    return { shouldOfferLead: true, reason: 'message_count' };
  }
  return { shouldOfferLead: false, reason: null };
}

// =============================================================
// Главная функция: отвечает на сообщение пользователя.
// =============================================================
export async function askAssistant({
  assistantId,
  conversationId,            // если есть — продолжаем; иначе создаём
  source,                    // admin | widget | api
  sessionId,                 // для виджета — браузерный uuid
  meta,                      // { url, ua, ip }
  message,                   // текст пользователя
  stream = false,
  onDelta = null,            // callback(textDelta) при stream
}) {
  const a = getAssistant.get(assistantId);
  if (!a) throw new Error('Ассистент не найден');

  // 1) Создаём/загружаем разговор.
  // Приоритет: conversationId явный → потом sessionId (для виджета — продолжаем тот же).
  let conv;
  if (conversationId) {
    conv = getConversation.get(conversationId);
    if (!conv) throw new Error('Разговор не найден');
  } else if (sessionId) {
    conv = findConversationBySession.get(assistantId, sessionId);
  }
  if (!conv) {
    conv = {
      id: randomUUID(),
      assistant_id: assistantId,
      source: source || 'admin',
      session_id: sessionId || null,
      meta_json: meta ? JSON.stringify(meta) : null,
      started_at: now(),
      last_at: now(),
    };
    insertConversation.run(conv.id, conv.assistant_id, conv.source, conv.session_id, conv.meta_json, conv.started_at, conv.last_at);
  }

  // 2) RAG — ищем релевантные чанки
  const settings = parseJson(a.settings_json) || {};
  const topK = Number.isFinite(settings.top_k_chunks) ? settings.top_k_chunks : 5;
  const minScore = Number.isFinite(settings.min_score) ? settings.min_score : 0.15;

  let retrieval = { hits: [], usage: { input: 0, output: 0, total: 0 }, totalChunks: 0 };
  try {
    retrieval = await retrieveTopK(assistantId, message, { k: topK, minScore });
  } catch (e) {
    console.warn('[chat] retrieve failed:', e.message);
  }

  // 3) Системный промпт + история
  const sysContent = buildRagSystem({ basePrompt: a.system_prompt, hits: retrieval.hits });
  const history = recentMessages.all(conv.id).map((m) => ({ role: m.role, content: m.content }));
  const messages = [{ role: 'system', content: sysContent }, ...history, { role: 'user', content: message }];

  // 4) Сохраняем USER-сообщение
  insertMessage.run(randomUUID(), conv.id, 'user', message, null, 0, 0, null, now());

  // 5) LLM с фоллбеком
  const t0 = Date.now();
  const result = await callWithFallback({
    modelId: a.model || 'claude:claude-haiku-4-5-20251001',
    messages,
    assistantId,
    statSource: source || 'admin',
    temperature: settings.temperature ?? 0.4,
    maxTokens: settings.max_tokens || 2048,
    stream,
    onDelta,
  });
  const elapsedMs = Date.now() - t0;

  // 6) Сохраняем ASSISTANT-сообщение
  const sourcesPayload = retrieval.hits.map((h) => ({
    chunkId: h.id, docId: h.docId, idx: h.idx, title: h.title, score: h.score,
  }));
  insertMessage.run(
    randomUUID(), conv.id, 'assistant', result.text || '',
    JSON.stringify(sourcesPayload),
    result.usage.input, result.usage.output,
    result.modelUsed, now()
  );
  updateConversationLast.run(now(), conv.id);

  // 7) Триггеры лидов
  const totalMessages = countMessages.get(conv.id)?.n || 0;
  const leadConfig = parseJson(a.lead_config_json) || {};
  const leadTrigger = detectLeadTrigger({
    leadConfig, userMessage: message, assistantText: result.text, totalMessages,
  });

  return {
    conversationId: conv.id,
    text: result.text,
    modelUsed: result.modelUsed,
    fallbackFrom: result.fallbackFrom,
    usage: result.usage,
    elapsedMs,
    retrieval: {
      hits: retrieval.hits,
      totalChunks: retrieval.totalChunks,
      embeddingsUsage: retrieval.usage,
    },
    lead: {
      shouldOffer: leadTrigger.shouldOfferLead,
      reason: leadTrigger.reason,
      fields: leadConfig.fields || ['name', 'phone'],
    },
  };
}

function parseJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
