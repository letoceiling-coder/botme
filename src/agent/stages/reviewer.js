// Reviewer stage: после успешного smoke оценивает «премиум-уровень» сайта
// и выдаёт 3 конкретных предложения улучшений (короткие, с «почему»).

import { callWithFallback, isProviderConfigured } from '../../llm.js';

const REVIEWER_SYSTEM = `Ты — senior product designer уровня топ-студий (Apple, Stripe, Linear). Тебе показали index.html свежесгенерированного сайта.
Дай РОВНО 3 КОНКРЕТНЫХ предложения улучшений — что улучшить и ПОЧЕМУ (с упоминанием UX/визуального паттерна).

ВЕРНИ СТРОГО JSON (без markdown, без пояснений):
{
  "rating": "good | great | premium",
  "suggestions": [
    { "title": "1 короткая фраза", "why": "почему важно (1 предложение)", "how": "как сделать (1-2 предложения с конкретикой)" },
    { "title": "...", "why": "...", "how": "..." },
    { "title": "...", "why": "...", "how": "..." }
  ]
}

Принципы оценки:
- Иерархия и контраст в hero / CTA.
- Микроинтеракции: hover, transitions, animations.
- Адаптив (mobile-first), читаемость.
- Премиум-детали: typography, spacing, glassmorphism, gradients, blob, bg-decor.
- Реальный контент vs lorem.
- Накладные накопленные баги (битые иконки, плейсхолдеры, лишние секции).`;

const REVIEWER_MODELS = [
  'claude:claude-haiku-4-5-20251001',
  'openai:gpt-4o',
  'gemini:gemini-2.5-flash',
];

function pickReviewerModel(userModel) {
  if (/haiku|mini|flash|fast/i.test(userModel || '')) return userModel;
  for (const id of REVIEWER_MODELS) {
    if (isProviderConfigured(id.split(':')[0])) return id;
  }
  return userModel;
}

function safeParseJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

export async function runReviewer({ prompt, indexHtml, model, projectId, bus }) {
  bus.startPhase('reviewer', 'Дизайн-ревью');
  try {
    const reviewerModel = pickReviewerModel(model);
    // Урезаем index.html до разумного объёма (head + начало body), чтобы не палить токены.
    const head = indexHtml.match(/<head[\s\S]*?<\/head>/i)?.[0] || '';
    const bodyStart = indexHtml.match(/<body[\s\S]{0,8000}/i)?.[0] || '';
    const trimmed = (head + '\n' + bodyStart).slice(0, 12000);

    const result = await callWithFallback({
      modelId: reviewerModel,
      messages: [
        { role: 'system', content: REVIEWER_SYSTEM },
        {
          role: 'user',
          content: `Промпт пользователя:\n${prompt.slice(0, 800)}\n\n--- index.html (head + начало body, обрезано) ---\n${trimmed}\n\nДай 3 предложения улучшения в JSON.`,
        },
      ],
      task: 'agent_reviewer',
      projectId,
      maxTokens: 1500,
      temperature: 0.3,
    });
    const json = safeParseJson(result.text);
    if (!json || !Array.isArray(json.suggestions)) {
      bus.donePhase('reviewer', { suggestions: 0, rating: null });
      return { suggestions: [], rating: null, modelUsed: result.modelUsed, usage: result.usage };
    }
    const suggestions = json.suggestions.slice(0, 3).map((s, i) => ({
      index: i + 1,
      title: String(s.title || '').slice(0, 120),
      why: String(s.why || '').slice(0, 240),
      how: String(s.how || '').slice(0, 280),
    }));
    suggestions.forEach((s) => bus.emit('reviewer.suggestion', s));
    bus.donePhase('reviewer', { suggestions: suggestions.length, rating: json.rating });
    return { suggestions, rating: json.rating, modelUsed: result.modelUsed, usage: result.usage };
  } catch (e) {
    bus.errorPhase('reviewer', e?.message || String(e), e?.code);
    return { suggestions: [], rating: null, modelUsed: model, usage: { input: 0, output: 0, total: 0 } };
  }
}
