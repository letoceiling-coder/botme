// Простой диалоговый агент (ChatGPT-стиль): история сообщений + выбор модели из MODELS.
// POST /api/agent/chat  → JSON или SSE (?stream=1)
import express from 'express';
import { resolveModelConfig, callWithFallback } from '../llm.js';

const router = express.Router();

const DEFAULT_SYSTEM = `Ты — умный и дружелюбный ассистент. Отвечай по делу, по-русски (если пользователь пишет по-русски). Можно использовать Markdown: заголовки, списки, блоки кода с указанием языка. Не выдумывай факты — если не уверен, так и скажи.`;

const MAX_MESSAGES = 50;
const MAX_MSG_CHARS = 24_000;

function normalizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (role !== 'user' && role !== 'assistant') continue;
    const content = String(m.content ?? '').slice(0, MAX_MSG_CHARS).trim();
    if (!content) continue;
    out.push({ role, content });
    if (out.length >= MAX_MESSAGES) break;
  }
  return out;
}

router.post('/chat', async (req, res) => {
  const { model, messages, temperature, systemPrompt } = req.body || {};
  const stream = req.query.stream === '1' || req.query.stream === 'true';

  if (!model || !resolveModelConfig(model)) {
    return res.status(400).json({ error: 'Укажите валидный model (см. GET /api/models)' });
  }

  const hist = normalizeMessages(messages);
  if (!hist.length) {
    return res.status(400).json({ error: 'messages должен содержать хотя бы одну реплику user/assistant' });
  }
  const last = hist[hist.length - 1];
  if (last.role !== 'user') {
    return res.status(400).json({ error: 'Последнее сообщение должно быть от пользователя (role: user)' });
  }

  const sys = typeof systemPrompt === 'string' && systemPrompt.trim()
    ? systemPrompt.trim().slice(0, 8000)
    : DEFAULT_SYSTEM;

  const fullMessages = [{ role: 'system', content: sys }, ...hist];

  const temp = typeof temperature === 'number' && Number.isFinite(temperature)
    ? Math.min(2, Math.max(0, temperature))
    : 0.65;
  const maxTokens = 8192;

  if (!stream) {
    try {
      const r = await callWithFallback({
        modelId: model,
        messages: fullMessages,
        task: 'agent_chat',
        temperature: temp,
        maxTokens,
      });
      return res.json({
        text: r.text,
        modelUsed: r.modelUsed,
        fallbackFrom: r.fallbackFrom,
        usage: r.usage,
      });
    } catch (e) {
      console.error('[agent.chat]', e);
      return res.status(502).json({
        error: e?.userMessage || e?.message || String(e),
        code: e?.code || 'unknown',
        errors: Array.isArray(e?.errors) ? e.errors.slice(-5) : undefined,
        suggestedAlternatives: e?.suggestedAlternatives,
      });
    }
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const keep = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 15_000);

  try {
    const r = await callWithFallback({
      modelId: model,
      messages: fullMessages,
      task: 'agent_chat',
      temperature: temp,
      maxTokens,
      stream: true,
      onDelta: (delta) => send('delta', { text: delta }),
    });
    send('done', {
      model_used: r.modelUsed,
      fallback_from: r.fallbackFrom,
      usage: r.usage,
    });
  } catch (e) {
    console.error('[agent.chat.stream]', e);
    send('error', {
      message: e?.userMessage || e?.message || String(e),
      code: e?.code || 'unknown',
      streamPartial: !!e?.streamPartial,
    });
  } finally {
    clearInterval(keep);
    res.end();
  }
});

export default router;
