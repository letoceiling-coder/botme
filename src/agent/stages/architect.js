// Architect stage: на вход — brief; на выход — план реализации:
// kind (static / react-bundle), стек, библиотеки, маршруты, заметки.

import { callWithFallback, isProviderConfigured } from '../../llm.js';

const ARCHITECT_SYSTEM = `Ты — frontend-архитектор. Получаешь бриф проекта и решаешь техническую реализацию.
ВЕРНИ СТРОГО JSON (без объяснений, без markdown):
{
  "kind": "static" | "react-bundle",
  "stack": ["html", "tailwindcss", "alpinejs", ...],
  "libraries": ["aos", "gsap", "swiper", "lucide", ...],
  "routes": ["index", "about", ...],
  "notes": "1-3 предложения, что важно для реализации",
  "needsContext7": ["tailwindcss", "swiper", ...],
  "smokeFocus": "что обязательно проверить smoke-тестом (1 строка)"
}

Когда выбирать "static" (по умолчанию):
- лендинг, многостраничный сайт, портфолио, лендинг-игра.
- Tailwind CDN + AOS/lucide/animate.css. Для интерактива — Alpine.js, обычный JS, или встроенный React+Babel в одном <script type="text/babel">.

Когда выбирать "react-bundle":
- сложный SPA: dashboard, конструктор, редактор, многостраничный SaaS с реальным роутингом.
- состояние с десятками компонентов, реальная сборка через esbuild на сервере.
- ВАЖНО: пользователь должен явно требовать «продвинутое React-приложение» или фича-объём это оправдывает.

needsContext7: 1-3 имени библиотек, по которым нужно подтянуть свежие docs (только если они нестандартные или в брифе указаны конкретные API).

КРИТИЧНО — ОГРАНИЧЕНИЯ ЭТОЙ ПЛАТФОРМЫ:
- Генератор выдаёт только набор файлов для превью: static HTML или react-bundle (esbuild), без отдельного деплоимого backend-репозитория.
- НЕ создаются PostgreSQL/MongoDB/Redis, Prisma, persistent Fastify/Nest API, боевые WebSocket-серверы с БД и «authoritative server-side» античит-логикой в том смысле, как просят в enterprise-промптах.
- Если в брифе/пожеланиях фигурируют БД, Prisma, Fastify/Nest, отдельный Node-сервер, multiplayer через реальный WS — в notes ОБЯЗАТЕЛЬНО укажи: реализуем один браузерный SPA/симулятор с полной игровой логикой в клиентском коде (Zustand и т.д.), без настоящего персистентного бэкенда в этой генерации.
- Для тяжёлых игр/SPA с десятками экранов предпочитай kind="react-bundle", но не обещай инфраструктуру вне одного артефакта превью.`;

const ARCHITECT_MODELS = [
  'claude:claude-haiku-4-5-20251001',
  'openai:gpt-4o',
  'gemini:gemini-2.5-flash',
  'xai:grok-4-fast',
];

function pickArchitectModel(userModel) {
  if (/haiku|mini|flash|fast|sonnet/i.test(userModel || '')) return userModel;
  for (const id of ARCHITECT_MODELS) {
    if (isProviderConfigured(id.split(':')[0])) return id;
  }
  return userModel;
}

/** В исходном промпте часто просят стек, который генератор физически не собирает — помечаем в plan.notes для Coder. */
const BACKEND_INFRA_RE =
  /postgres(?:ql)?|prisma|\bredis\b|mongo(?:db)?|\bfastify\b|nest(?:js)?|sequelize|typeorm|drizzle|socket\.io|\bwebsocket\b|\bweb\s*socket\b|серверн[аоы][яем].*логик|authoritative|anti-?cheat|античит|\borm\b/i;

export function annotatePlanWithInfraReality(plan, rawPrompt = '') {
  if (!plan || typeof plan !== 'object') return plan;
  const p = String(rawPrompt || '');
  if (!BACKEND_INFRA_RE.test(p)) return plan;
  const tag =
    '[Платформа] Отдельный backend/БД/authoritative WS-сервер здесь не генерируется. ' +
    'Сделай полноценную игру/логику в одном react-bundle: Zustand, Framer Motion, локальные «боты», симуляция тиража в браузере. ' +
    'Обязательно замени src/App.tsx — никакого текста «Шаблон react-bundle» и бейджа esbuild-шаблона.';
  plan.notes = [plan.notes, tag].filter(Boolean).join(' ');
  return plan;
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

export async function runArchitect({ brief, model, projectId, bus, rawPrompt = '' }) {
  bus.startPhase('architect', 'Архитектура');
  try {
    const archModel = pickArchitectModel(model);
    const result = await callWithFallback({
      modelId: archModel,
      messages: [
        { role: 'system', content: ARCHITECT_SYSTEM },
        {
          role: 'user',
          content: 'Бриф проекта:\n\n' + JSON.stringify(brief, null, 2) + '\n\nВыдай план в JSON.',
        },
      ],
      task: 'agent_architect',
      projectId,
      maxTokens: 1500,
      temperature: 0.2,
    });
    const json = safeParseJson(result.text) || {
      kind: brief?.complexity === 'complex' && brief?.needsReact ? 'react-bundle' : 'static',
      stack: ['html', 'tailwindcss'],
      libraries: ['aos', 'lucide'],
      routes: brief?.pages || ['index'],
      notes: '',
      needsContext7: [],
      smokeFocus: 'index.html открывается без ошибок, hero виден',
    };
    // react-bundle включён, если включён esbuild (Phase F). Если в окружении
    // ESBUILD_DISABLED=1 — принудительно понижаем до static.
    if (json.kind === 'react-bundle' && process.env.ESBUILD_DISABLED === '1') {
      bus.warn('Architect выбрал react-bundle, но ESBUILD_DISABLED=1. Понижаю до static с React+Babel CDN.');
      json.kind = 'static';
      json.stack = ['html', 'tailwindcss', 'react@cdn', 'babel-standalone'];
    }
    json.routes ||= brief?.pages || ['index'];
    json.libraries ||= [];
    json.needsContext7 ||= [];
    annotatePlanWithInfraReality(json, rawPrompt);

    bus.donePhase('architect', {
      kind: json.kind,
      stack: json.stack,
      libraries: json.libraries.slice(0, 5),
    });
    return { plan: json, modelUsed: result.modelUsed, usage: result.usage };
  } catch (e) {
    bus.errorPhase('architect', e?.message || String(e), e?.code);
    const fallbackPlan = {
      kind: 'static',
      stack: ['html', 'tailwindcss'],
      libraries: ['aos', 'lucide'],
      routes: brief?.pages || ['index'],
      notes: 'architect-стадия упала, используется дефолт',
      needsContext7: [],
      smokeFocus: 'index.html без ошибок',
    };
    annotatePlanWithInfraReality(fallbackPlan, rawPrompt);
    return {
      plan: fallbackPlan,
      modelUsed: model,
      usage: { input: 0, output: 0, total: 0 },
      error: e?.message,
    };
  }
}
