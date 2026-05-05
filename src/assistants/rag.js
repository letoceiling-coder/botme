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
// Сборка системного контекста для модели.
// convoState — динамика разговора, чтобы избегать шаблонных ответов:
//   { messageIndex, contactsAlreadyShared, leadAlreadyOffered, shouldOfferLeadNow, leadFields }
// =============================================================

const STYLE_RULES = `
ПРАВИЛА СТИЛЯ (СТРОГО, ВАЖНО):
1. Ты — живой, приветливый сотрудник компании. Отвечай как человек в мессенджере: коротко, по делу, без канцелярита и шаблонов.
2. Длина ответа: 2–6 предложений или 3–6 строк списка. НЕ пиши простыни.
3. НЕ повторяй структуру "Стоимость / В стоимость входит / Сроки / Можно добавить / Контакты" в каждом ответе. Это раздражает. Отвечай только на то, что СПРОСИЛИ.
4. НЕ дублируй контакты (email/telegram/телефон) в каждом сообщении. Дай их ОДИН РАЗ — когда уместно — и больше не повторяй.
5. НЕ начинай каждый ответ с эмодзи и громкого восклицания. Один эмодзи на ответ — максимум, и только если уместно.
6. НЕ используй жирный текст и подзаголовки в каждом абзаце. Жирный — только для важных цифр или ключевых терминов, и редко.
7. Не предлагай услуги, о которых не спрашивали. Не пытайся продать всё сразу.
8. Если пользователь спрашивает простое — отвечай простым. Конкретный вопрос → конкретный ответ.
9. Запоминай контекст: пользователь уже знает, кто ты и что у нас есть. Не представляйся каждый раз заново.
10. Используй живые формулировки: "ага", "да, конечно", "сейчас гляну", "минутку". Звучи как человек, а не как шаблонный бот.
`.trim();

const SOURCE_RULES = `
ИСТОЧНИКИ ОТВЕТА:
- Используй ТОЛЬКО факты, цифры, цены, контакты из приведённых ниже фрагментов.
- Если в базе ответа нет — честно скажи "точно не знаю, уточню у менеджера" и (если уместно) предложи связаться. НЕ выдумывай.
- Если данные противоречат — выбирай свежее или более конкретное. Не цитируй фрагменты дословно — пересказывай своими словами.
`.trim();

export function buildRagSystem({ basePrompt, hits, convoState = {} }) {
  const intro = basePrompt && basePrompt.trim()
    ? basePrompt.trim()
    : 'Ты — ассистент компании. Помогаешь клиентам разобраться в услугах и заказать.';

  const parts = [intro, '', STYLE_RULES, '', SOURCE_RULES];

  // Динамические инструкции по состоянию разговора
  const dynamic = buildDynamicGuidance(convoState);
  if (dynamic) parts.push('', dynamic);

  if (!hits || !hits.length) {
    parts.push('', '[База знаний пуста или ничего релевантного не нашлось. Честно скажи, что не знаешь, и предложи связаться с менеджером.]');
    return parts.join('\n');
  }

  const fragments = hits.map((h, i) =>
    `[Фрагмент ${i + 1} | Документ: "${h.title || 'без названия'}" | релевантность ${h.score.toFixed(2)}]\n${h.text}`
  ).join('\n\n---\n\n');

  parts.push('', '====== БАЗА ЗНАНИЙ ======', fragments, '====== КОНЕЦ БАЗЫ ЗНАНИЙ ======');
  return parts.join('\n');
}

function buildDynamicGuidance({ messageIndex, contactsAlreadyShared, leadAlreadyOffered, shouldOfferLeadNow, leadFields }) {
  const lines = [];
  if (Number.isFinite(messageIndex) && messageIndex > 0) {
    lines.push(`Это уже ${messageIndex + 1}-е сообщение в нашем разговоре. Будь лаконичен.`);
  }
  if (contactsAlreadyShared) {
    lines.push('Контакты компании ты уже давал в этом разговоре — НЕ повторяй email и телеграм без явного запроса.');
  }
  if (shouldOfferLeadNow && !leadAlreadyOffered) {
    const fields = (leadFields || ['name', 'phone']).map((f) => ({
      name: 'имя',
      phone: 'телефон',
      email: 'email',
      telegram: 'телеграм',
      message: 'короткое описание задачи',
    }[f] || f)).join(' и ');
    lines.push(
      `КЛИЕНТ ИНТЕРЕСУЕТСЯ ЗАКАЗОМ — самое время аккуратно собрать контакт. ` +
      `В КОНЦЕ ответа ОДНОЙ короткой фразой попроси оставить ${fields} (например: "Скиньте ${fields} — менеджер свяжется в течение часа"). ` +
      `Не делай отдельный блок «Контакты» — попроси кратко и по-человечески.`
    );
  } else if (leadAlreadyOffered) {
    lines.push('Ты уже предлагал клиенту оставить контакты — больше НЕ проси, пока он сам не вернётся к этому.');
  }
  if (!lines.length) return '';
  return ['ТЕКУЩЕЕ СОСТОЯНИЕ РАЗГОВОРА:', ...lines.map((l) => '- ' + l)].join('\n');
}
