// In-memory cosine similarity по чанкам ассистента.
// Кешируем матрицу Float32Array на ассистента, инвалидируем при обновлении базы знаний.
import { db, blobToVec } from '../db.js';
import { embedQuery } from './embeddings.js';

// =============================================================
// Кеш матрицы эмбеддингов на ассистента
// =============================================================

const cache = new Map(); // assistantId -> { ts, items: [{ id, docId, idx, text, vec, norm, title }] }
const CACHE_TTL = 5 * 60_000;

const selectChunksStmt = db.prepare(`
  SELECT c.id, c.document_id AS docId, c.idx, c.text, c.embedding,
         d.title, d.type AS docType
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
   WHERE c.assistant_id = ?
     AND c.embedding IS NOT NULL
`);

function loadAssistantChunks(assistantId) {
  const rows = selectChunksStmt.all(assistantId);
  const items = [];
  for (const r of rows) {
    const vec = blobToVec(r.embedding);
    if (!vec || !vec.length) continue;
    let s = 0;
    for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
    items.push({
      id: r.id,
      docId: r.docId,
      idx: r.idx,
      text: r.text,
      vec,
      norm: Math.sqrt(s) || 1,
      title: r.title || '',
      docType: r.docType,
    });
  }
  return items;
}

export function invalidateAssistantCache(assistantId) {
  cache.delete(assistantId);
}

function getAssistantIndex(assistantId) {
  const cached = cache.get(assistantId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.items;
  const items = loadAssistantChunks(assistantId);
  cache.set(assistantId, { ts: Date.now(), items });
  return items;
}

// =============================================================
// Поиск top-K
// =============================================================

function cosine(a, aNorm, b, bNorm) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot / (aNorm * bNorm);
}

export async function retrieveTopK(assistantId, query, { k = 5, minScore = 0.15 } = {}) {
  const items = getAssistantIndex(assistantId);
  if (!items.length) return { hits: [], usage: { input: 0, output: 0, total: 0 }, totalChunks: 0 };

  const { vector, usage } = await embedQuery(query, { assistantId });
  if (!vector) return { hits: [], usage, totalChunks: items.length };

  let qn = 0;
  for (let i = 0; i < vector.length; i++) qn += vector[i] * vector[i];
  const queryNorm = Math.sqrt(qn) || 1;

  const scored = items.map((it) => ({ it, score: cosine(vector, queryNorm, it.vec, it.norm) }));
  scored.sort((a, b) => b.score - a.score);

  const hits = scored
    .filter((s) => s.score >= minScore)
    .slice(0, k)
    .map((s) => ({
      id: s.it.id,
      docId: s.it.docId,
      idx: s.it.idx,
      text: s.it.text,
      title: s.it.title,
      score: s.score,
    }));

  return { hits, usage, totalChunks: items.length };
}

// =============================================================
// Сборка системного контекста для модели
// =============================================================

export function buildRagSystem({ basePrompt, hits }) {
  const intro = basePrompt && basePrompt.trim()
    ? basePrompt.trim()
    : 'Ты — корпоративный ассистент. Отвечай вежливо, точно и по делу.';

  if (!hits || !hits.length) {
    return intro + '\n\n[База знаний пуста или не нашлось релевантных фрагментов. Если вопрос вне твоей компетенции — честно скажи об этом и предложи связаться с человеком.]';
  }

  const fragments = hits.map((h, i) =>
    `[Фрагмент ${i + 1} | Документ: "${h.title || 'без названия'}" | релевантность ${h.score.toFixed(3)}]\n${h.text}`
  ).join('\n\n---\n\n');

  return [
    intro,
    '',
    'Используй ПРИОРИТЕТНО приведённые ниже фрагменты из базы знаний.',
    'Если ответа во фрагментах нет — честно скажи, что не знаешь, и предложи оставить контакты.',
    'Не выдумывай факты, цифры, цены, контакты, которых нет в фрагментах.',
    '',
    '====== БАЗА ЗНАНИЙ ======',
    fragments,
    '====== КОНЕЦ БАЗЫ ЗНАНИЙ ======',
  ].join('\n');
}
