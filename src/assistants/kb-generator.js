// AI-агент: создаёт структурированную базу знаний по краткому описанию бизнеса.
// Возвращает массив документов [{title, content}], каждый из которых дальше
// сохраняется как обычный text-document и автоматически чанкуется + индексируется.
import { callWithFallback } from '../llm.js';

// =============================================================
// Системный промпт генератора базы знаний
// =============================================================
export const KB_GENERATOR_SYSTEM = `Ты — senior knowledge engineer и продуктовый аналитик. Твоя задача — по короткому описанию бизнеса/проекта собрать ПОЛНУЮ структурированную базу знаний для AI-ассистента поддержки.

ФОРМАТ ОТВЕТА — СТРОГО JSON:
Верни ТОЛЬКО валидный JSON-массив документов, без markdown-обёрток, без комментариев, без преамбулы. Каждый элемент:
{
  "title":   "Короткий заголовок (5-60 символов)",
  "kind":    "overview | services | pricing | faq | policies | contacts | guide | other",
  "content": "Развёрнутый текст документа (от 400 до 2500 символов)"
}

ТРЕБОВАНИЯ К ДОКУМЕНТАМ:
1. Содержание ВСЕГДА на русском языке (если в описании не указан другой язык).
2. Документы должны покрывать ВСЕ типичные вопросы клиента: что предлагается, чем отличается, сколько стоит, как заказать, какая гарантия, как связаться, частые проблемы и их решения.
3. Каждый документ — самодостаточный, без отсылок к "см. документ X". База будет искаться по vector similarity, поэтому в каждом документе должны быть ключевые термины и синонимы.
4. Текст ЖИВОЙ и КОНКРЕТНЫЙ. НЕ "наша компания предоставляет качественные услуги", а "монтаж натяжного потолка в комнате 18 м² — 2 часа, цена от 7 800 руб с материалом и работой".
5. ЦИФРЫ, СРОКИ, ЦЕНЫ, КОНКРЕТНЫЕ ПРОЦЕДУРЫ — обязательно. Если в исходных данных их нет, придумай ПРАВДОПОДОБНЫЕ для тематики (но реалистичные).
6. Стиль и тон выдержи единым — соответствующим бизнесу (для премиум-услуг — экспертный, для масс-маркета — дружелюбный).

КАКИЕ ДОКУМЕНТЫ СОЗДАТЬ (минимально):
- "О компании / о проекте" (overview) — кто мы, чем занимаемся, наша экспертиза, ключевые отличия.
- "Услуги / Продукты" (services) — что именно предлагаем, варианты, для каких задач подходит.
- "Цены и тарифы" (pricing) — структура цен, что входит, скидки, варианты оплаты.
- "FAQ" (faq) — 6-12 наиболее частых вопросов с подробными ответами в формате "Вопрос: ... \\n Ответ: ...".
- "Гарантии и возвраты / Политики" (policies) — гарантии, правила обслуживания, что делать если что-то пошло не так.
- "Контакты и режим работы" (contacts) — как связаться, часы, география, мессенджеры.
- "Как заказать / процесс работы" (guide) — пошаговый workflow от заявки до результата.

Минимум 6 документов, максимум — столько, сколько нужно для полного покрытия (обычно 7-10).

ВАЖНО: ответ должен быть валидным JSON. Не оборачивай его в \`\`\`json. Не добавляй "Вот база знаний:" перед массивом. Только массив.`;

// =============================================================
// Системный промпт обогащения существующего документа
// =============================================================
export const KB_ENRICHER_SYSTEM = `Ты — knowledge engineer. Тебе дают сырой текст (заметки, копипаст, неструктурированную информацию). Превратить в чистый, структурированный документ для базы знаний AI-ассистента.

ФОРМАТ ОТВЕТА — СТРОГО JSON:
{
  "title":   "Точный заголовок документа",
  "content": "Структурированный текст с ясной структурой..."
}

ПРАВИЛА:
1. Верни ТОЛЬКО JSON-объект, без markdown-обёрток.
2. Сохрани ВСЕ факты и цифры из исходника, не теряй ничего важного.
3. Структурируй: используй короткие абзацы, маркированные списки, разделы с подзаголовками вроде "Что входит:", "Сроки:", "Цены:".
4. Перепиши формальным/деловым русским, убери дубли, опечатки, обрывки.
5. Если в тексте есть FAQ-вопросы — оформи в формате "В: ... \\n О: ...".
6. Не выдумывай цифры/факты, которых в исходнике не было. Только реструктуризация и редактирование.`;

// =============================================================
// Главные функции
// =============================================================

/**
 * Сгенерировать набор документов для базы знаний.
 *
 * @param {object}   opts
 * @param {string}   opts.description  Описание бизнеса/проекта (что за компания, что делает).
 * @param {string=}  opts.tone         Тон: 'expert' | 'friendly' | 'corporate' | 'casual'.
 * @param {number=}  opts.targetCount  Желаемое число документов (по умолчанию 7).
 * @param {string=}  opts.modelId      ID модели (если не задан — Claude Haiku 4.5).
 * @param {string}   opts.assistantId  Для записи токенов в статистику ассистента.
 * @returns {Promise<{documents: Array<{title,kind,content}>, modelUsed, fallbackFrom, usage}>}
 */
export async function generateKnowledgeBase({ description, tone, targetCount, modelId, assistantId }) {
  if (!description || !description.trim()) throw new Error('description обязателен');

  const userPrompt = [
    `Описание бизнеса/проекта:\n${description.trim()}`,
    tone ? `\nТон коммуникации: ${tone}` : '',
    targetCount ? `\nЦелевое число документов: ${targetCount} (плюс-минус 2).` : '',
    `\nСоздай полную базу знаний для AI-ассистента поддержки этого бизнеса. Верни JSON-массив документов.`,
  ].join('');

  const result = await callWithFallback({
    modelId: modelId || 'claude:claude-haiku-4-5-20251001',
    messages: [
      { role: 'system', content: KB_GENERATOR_SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    task: 'kb_generate',
    assistantId,
    statSource: 'kb-generator',
    temperature: 0.7,
    maxTokens: 16000,
  });

  const docs = parseDocsJson(result.text);
  if (!docs.length) {
    throw new Error('Модель не вернула валидный JSON-массив документов. Попробуй ещё раз или сменить модель.');
  }

  return {
    documents: docs,
    modelUsed: result.modelUsed,
    fallbackFrom: result.fallbackFrom,
    usage: result.usage,
  };
}

/**
 * Обогатить/реструктурировать существующий сырой текст в чистый документ.
 *
 * @param {object}   opts
 * @param {string}   opts.rawContent  Сырой текст.
 * @param {string=}  opts.hint        Подсказка ("сделай FAQ", "уточни цены").
 * @param {string=}  opts.modelId
 * @param {string}   opts.assistantId
 */
export async function enrichDocument({ rawContent, hint, modelId, assistantId }) {
  if (!rawContent || !rawContent.trim()) throw new Error('rawContent обязателен');

  const userPrompt = [
    `Исходный сырой текст:\n${rawContent.trim()}`,
    hint ? `\nПодсказка/что улучшить: ${hint}` : '',
    `\nВерни структурированный документ в JSON-формате.`,
  ].join('');

  const result = await callWithFallback({
    modelId: modelId || 'claude:claude-haiku-4-5-20251001',
    messages: [
      { role: 'system', content: KB_ENRICHER_SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    task: 'kb_enrich',
    assistantId,
    statSource: 'kb-enricher',
    temperature: 0.4,
    maxTokens: 6000,
  });

  const doc = parseDocJson(result.text);
  if (!doc || !doc.content) throw new Error('Модель не вернула валидный JSON-документ.');

  return {
    document: doc,
    modelUsed: result.modelUsed,
    fallbackFrom: result.fallbackFrom,
    usage: result.usage,
  };
}

// =============================================================
// Утилиты парсинга JSON-ответов модели
// =============================================================

function tryJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

function stripFences(text) {
  // убираем ```json ... ``` и ``` ... ```
  const m = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  return m ? m[1] : text;
}

function parseDocsJson(raw) {
  if (!raw) return [];
  const stripped = stripFences(raw).trim();
  // Пытаемся напрямую
  let arr = tryJsonParse(stripped);
  // Если массив "висит" в более длинном тексте — вырежем по [ ... ]
  if (!Array.isArray(arr)) {
    const start = stripped.indexOf('[');
    const end = stripped.lastIndexOf(']');
    if (start !== -1 && end > start) {
      arr = tryJsonParse(stripped.slice(start, end + 1));
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((d) => d && typeof d === 'object' && d.content)
    .map((d) => ({
      title:   String(d.title || 'Документ').slice(0, 200),
      kind:    String(d.kind || 'other').slice(0, 40),
      content: String(d.content),
    }));
}

function parseDocJson(raw) {
  if (!raw) return null;
  const stripped = stripFences(raw).trim();
  let obj = tryJsonParse(stripped);
  if (!obj || typeof obj !== 'object') {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start !== -1 && end > start) {
      obj = tryJsonParse(stripped.slice(start, end + 1));
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  return {
    title:   String(obj.title || 'Документ').slice(0, 200),
    content: String(obj.content || ''),
  };
}
