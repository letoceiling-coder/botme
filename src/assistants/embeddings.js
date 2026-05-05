// OpenAI text-embedding-3-small.
// Батчи по 100 строк, ретраи с экспоненциальным backoff на rate-limit.
import OpenAI from 'openai';
import { recordAssistantUsage } from '../db.js';

const EMBED_MODEL = 'text-embedding-3-small'; // 1536 dim, ~$0.02 / 1M токенов
const BATCH_SIZE  = 100;
const MAX_RETRIES = 4;

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function isOpenAiAvailable() { return !!client; }

async function embedBatch(inputs) {
  if (!client) throw new Error('OPENAI_API_KEY не настроен — embeddings недоступны.');
  let attempt = 0;
  // strip пустых на всякий
  const clean = inputs.map((s) => (s && s.length ? s : ' '));
  while (true) {
    try {
      const r = await client.embeddings.create({ model: EMBED_MODEL, input: clean });
      const vecs = r.data.map((d) => Float32Array.from(d.embedding));
      const usage = r.usage || {};
      return { vecs, tokens: usage.total_tokens || 0, prompt: usage.prompt_tokens || 0 };
    } catch (e) {
      const msg = e?.message || String(e);
      const status = e?.status || e?.response?.status;
      const retriable = status === 429 || status >= 500 || /rate limit|timeout|ECONNRESET|fetch failed/i.test(msg);
      if (!retriable || attempt >= MAX_RETRIES) throw e;
      const delay = Math.min(15_000, 800 * Math.pow(2, attempt)) + Math.random() * 400;
      console.warn(`[embeddings] retry #${attempt + 1} after ${Math.round(delay)}ms (${msg.slice(0, 120)})`);
      await new Promise((r) => setTimeout(r, delay));
      attempt += 1;
    }
  }
}

// Эмбеддинги для массива строк. Возвращает { vectors: Float32Array[], usage: {input, output, total} }.
export async function embedTexts(texts, { assistantId, source = 'embeddings' } = {}) {
  if (!texts || !texts.length) return { vectors: [], usage: { input: 0, output: 0, total: 0 } };
  const vectors = new Array(texts.length);
  let totalIn = 0;
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const slice = texts.slice(i, i + BATCH_SIZE);
    const { vecs, prompt } = await embedBatch(slice);
    for (let j = 0; j < vecs.length; j++) vectors[i + j] = vecs[j];
    totalIn += prompt;
  }
  const usage = { input: totalIn, output: 0, total: totalIn };
  if (assistantId) {
    recordAssistantUsage({ assistantId, model: `openai:${EMBED_MODEL}`, source, input: usage.input, output: 0 });
  }
  return { vectors, usage };
}

// Один запрос (для поиска)
export async function embedQuery(text, { assistantId } = {}) {
  const r = await embedTexts([text], { assistantId, source: 'rag-query' });
  return { vector: r.vectors[0], usage: r.usage };
}

export { EMBED_MODEL, isOpenAiAvailable };
