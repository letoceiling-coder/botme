// Brief stage: на вход — сырой prompt пользователя; на выход — структурированный
// JSON-бриф (audience/tone/primaryGoal/sections и т.д.). Лёгкая модель, дешёвая.

import { callWithFallback, isProviderConfigured } from '../../llm.js';

const BRIEF_SYSTEM = `Ты — продакт-дизайнер на брифинге. Получаешь сырое описание сайта/игры от пользователя.
Возвращаешь СТРОГО JSON в формате (без markdown, без объяснений):
{
  "audience": "целевая аудитория (1 строка)",
  "tone": "tone of voice (1 строка)",
  "primaryGoal": "основная цель сайта/игры (1 строка)",
  "kind": "landing | multi-page | game | spa | dashboard | portfolio",
  "pages": ["index", ...],
  "sections": ["hero", "features", ...],
  "colorMood": "тёмная/светлая/неоновая, акцентный цвет",
  "references": ["apple", "stripe", "linear", ...],
  "languages": ["ru" | "en", ...],
  "complexity": "simple | medium | complex",
  "needsReact": true | false,
  "notes": "1-2 предложения важных деталей"
}
Никаких комментариев, никаких \`\`\`. Только сам JSON-объект.`;

const BRIEF_PREFERRED_MODELS = [
  'claude:claude-haiku-4-5-20251001',
  'openai:gpt-4o',
  'gemini:gemini-2.5-flash',
  'xai:grok-4-fast',
];

function pickBriefModel(userModel) {
  // Если пользовательская модель достаточно дешёвая — используем её, иначе haiku/flash
  if (/haiku|mini|flash|fast|small|nano/i.test(userModel || '')) return userModel;
  for (const id of BRIEF_PREFERRED_MODELS) {
    const provider = id.split(':')[0];
    if (isProviderConfigured(provider)) return id;
  }
  return userModel;
}

function safeParseJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  // Срезаем markdown-fence на случай если модель не послушала
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Берём первый { ... } объект
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  const slice = s.slice(start, end + 1);
  try { return JSON.parse(slice); } catch { return null; }
}

export async function runBrief({ prompt, model, projectId, bus }) {
  bus.startPhase('brief', 'Брифинг');
  try {
    const briefModel = pickBriefModel(model);
    const result = await callWithFallback({
      modelId: briefModel,
      messages: [
        { role: 'system', content: BRIEF_SYSTEM },
        { role: 'user', content: `Сырой запрос пользователя:\n\n${prompt}\n\nВерни JSON.` },
      ],
      task: 'agent_brief',
      projectId,
      maxTokens: 1200,
      temperature: 0.2,
    });
    const json = safeParseJson(result.text) || {
      audience: 'общая аудитория',
      tone: 'нейтральный',
      primaryGoal: prompt.slice(0, 120),
      kind: 'landing',
      pages: ['index'],
      sections: ['hero', 'features', 'cta'],
      colorMood: 'тёмная, акцентный цвет — фиолетовый',
      references: [],
      languages: ['ru'],
      complexity: 'medium',
      needsReact: false,
      notes: '',
    };
    // Стабилизируем поля, чтобы Architect не падал на отсутствующих ключах
    json.pages ||= ['index'];
    json.sections ||= ['hero'];
    json.languages ||= ['ru'];
    json.references ||= [];

    bus.donePhase('brief', {
      audience: json.audience,
      kind: json.kind,
      complexity: json.complexity,
      sections: json.sections.length,
    });
    return { brief: json, modelUsed: result.modelUsed, usage: result.usage };
  } catch (e) {
    bus.errorPhase('brief', e?.message || String(e), e?.code);
    // Не падаем — возвращаем дефолт, чтобы пайплайн продолжился
    return {
      brief: {
        audience: 'общая аудитория',
        tone: 'нейтральный',
        primaryGoal: prompt.slice(0, 120),
        kind: 'landing',
        pages: ['index'],
        sections: ['hero', 'features', 'cta'],
        colorMood: 'тёмная',
        references: [],
        languages: ['ru'],
        complexity: 'medium',
        needsReact: false,
        notes: 'brief-стадия упала, используется дефолт',
      },
      modelUsed: model,
      usage: { input: 0, output: 0, total: 0 },
      error: e?.message,
    };
  }
}
