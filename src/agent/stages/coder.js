// Coder stage: основной этап, где модель пишет код через tool-calling.
// Имеет доступ к: read_file, write_file, apply_patch, context7_lookup,
// run_smoke, finish_generation. Цикл крутится до finish_generation или
// исчерпания iterations.

import {
  callModelWithToolsAndFallback,
  callWithFallback,
  isProviderConfigured,
  modelSupportsTools,
  resolveModelConfig,
} from '../../llm.js';
import { TOOL_DECLARATIONS, execute as executeTool } from '../tools.js';

// Coder требует мощную модель с надёжным tool-calling.
// Ollama / некоторые free OpenRouter — без tools.
const CODER_PREFERRED_FOR_TOOLS = [
  'claude:claude-sonnet-4-5-20250929',
  'claude:claude-haiku-4-5-20251001',
  'openai:gpt-4o',
  'openai:gpt-4.1-mini',
  'xai:grok-4-fast',
];

function pickCoderModel(userModel) {
  if (modelSupportsTools(userModel)) return userModel;
  for (const id of CODER_PREFERRED_FOR_TOOLS) {
    if (isProviderConfigured(id.split(':')[0])) return id;
  }
  return userModel; // fallback: всё равно попробуем
}

function buildCoderSystemPrompt({ siteSystemPrompt, brief, plan, mode = 'fresh', existingFiles = [] }) {
  const intro = mode === 'patch'
    ? `Ты — Coder в РЕЖИМЕ ПРАВКИ. Проект уже существует на диске, нужно ВНЕСТИ ТОЧЕЧНЫЕ ИЗМЕНЕНИЯ через apply_patch. НЕ переписывай файлы целиком write_file без необходимости. Работай минимальными апрувленными правками.`
    : plan?.kind === 'react-bundle'
      ? `Ты — Coder. Это уже развёрнутый **react-bundle** (esbuild + PostCSS Tailwind в template): есть src/App.tsx, main.tsx, index.html для dist.
Твоя задача — реализовать запрос пользователя **в коде**: перепиши src/App.tsx (и при нужде добавь файлы под src/).
**ЗАПРЕЩЕНО** оставлять заголовок «Шаблон react-bundle», бейдж «React + Tailwind…esbuild» и заглушку «Здесь стартует…» / «Замените содержимое src/App.tsx». Это брак.
Если в ПЛАНЕ (notes) указано «[Платформа]» или пользователь просил PostgreSQL/Fastify/настоящий WS-сервер — **не создавай отдельный backend**; весь тираж, боты и экономика — в этом браузерном приложении (при сложном state используй zustand из зависимостей шаблона).` 
      : `Ты — Coder. Создай проект с нуля в виде набора файлов на диске через write_file. Главный файл — index.html в корне проекта.`;

  const filesNote = existingFiles.length
    ? `\n\nСУЩЕСТВУЮЩИЕ ФАЙЛЫ ПРОЕКТА:\n${existingFiles.map((f) => `  • ${f}`).join('\n')}`
    : '';

  const briefBlock = brief ? `\n\nБРИФ ПРОЕКТА:\n${JSON.stringify(brief, null, 2)}` : '';
  const planBlock = plan ? `\n\nПЛАН АРХИТЕКТУРЫ:\n${JSON.stringify(plan, null, 2)}` : '';

  const bundleAssetRule = plan?.kind === 'react-bundle'
    ? `\n### React-bundle (esbuild) — пути к сборке\n` +
      `- В **dist/index.html** (или index.html, который попадёт в dist) укажи **только относительные** ссылки: ` +
      `\`href="./bundle.css"\` и \`src="./bundle.js"\` (можно без ./). ` +
      `\n- **Запрещено:** \`/dist/bundle.css\`, \`/dist/bundle.js\`, \`https://.../dist/bundle.*\` — превью открывается как \`/preview/&lt;projectId&gt;/\`, ` +
      `такие абсолютные пути уходят на корень домена и дают 404 + MIME text/html.\n`
    : '';

  const protoStep1 = mode === 'patch'
    ? 'При необходимости read_file для актуального содержимого. Используй apply_patch для изменений.'
    : plan?.kind === 'react-bundle'
      ? 'Главная логика — в src/App.tsx и при нужде доп. файлах под src/. После существенных правок подключён rebuild_bundle, затем run_smoke.'
      : 'Используй write_file для каждого файла проекта. Главный — index.html в корне проекта.';

  const qualityBlock = plan?.kind === 'react-bundle'
    ? `КРИТИЧНЫЕ ПРАВИЛА react-bundle:
- Это сборка через esbuild + Tailwind через PostCSS (src/styles/tailwind.css уже подключён) — не требуй cdn.tailwindcss.com как у static-сайтов.
- import из npm в .tsx (.ts) разрешён: react, react-dom, framer-motion, lucide-react, zustand и т.д. Сборщик включит их в bundle.js.
- Не добавляй <script type="text/babel"> и UMD-хаков — нужен только type="module" в итоговом index как в шаблоне.
- Если context7_lookup помогает — вызывай.`
    : `КРИТИЧНЫЕ ПРАВИЛА КАЧЕСТВА (нарушение = брак):
- Tailwind ТОЛЬКО через https://cdn.tailwindcss.com (это runtime-JIT). НИКОГДА \`<link>\` на cdn.jsdelivr.net/npm/tailwindcss@*/dist/.
- Если используешь \`<script type="text/babel">\` — обязательны 3 строки в <head>:
    <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script src="https://unpkg.com/@babel/standalone@7.24.7/babel.min.js"></script>
- React: только \`ReactDOM.createRoot(...).render(<App/>)\` (НЕ \`ReactDOM.render\`).
- НИКАКИХ \`@apply\` в обычном <style> (cdn.tailwindcss.com не процессит).
- НИКАКИХ \`framer-motion\`, \`react-router-dom\`, \`lucide-react\` — UMD на CDN не работает.
- Любые unpkg.com/<lib> — ОБЯЗАТЕЛЬНО pinned (с @версией).
- Если context7_lookup мог бы помочь по библиотеке — вызывай его перед use.`;

  return `${intro}

ПРОТОКОЛ РАБОТЫ (СТРОГО):
1. ${protoStep1}
2. По завершении работы вызови run_smoke для самопроверки.
3. Если smoke вернул ошибки — исправь их через apply_patch и повтори run_smoke.
4. Когда всё ok — вызови finish_generation с коротким описанием изменений.

${qualityBlock}
${bundleAssetRule}${briefBlock}${planBlock}${filesNote}

НИЖЕ — общий design-промпт нашего сервиса (премиум-уровень). Соблюдай:
${siteSystemPrompt}`;
}

/**
 * Главный entry. Возвращает { ok, finished, smoke, usage, modelUsed, iterations, message }.
 * Все эффекты файловой системы происходят через tools.execute → fs writes.
 */
export async function runCoder({
  prompt,
  brief,
  plan,
  mode = 'fresh',
  projectDir,
  projectId,
  model,
  siteSystemPrompt,
  existingFiles = [],
  bus,
  smokeRunner,
  contextDocs = '',
}) {
  bus.startPhase('coder', mode === 'patch' ? 'Правка кода' : 'Кодинг');

  const coderModel = pickCoderModel(model);
  if (coderModel !== model) {
    bus.warn(`Модель ${model} не поддерживает tool-calling — переключаюсь на ${coderModel} для Coder-стадии.`);
  }

  const systemPrompt = buildCoderSystemPrompt({ siteSystemPrompt, brief, plan, mode, existingFiles });
  const messages = [{ role: 'system', content: systemPrompt }];
  if (contextDocs) {
    messages.push({ role: 'user', content: contextDocs });
    messages.push({ role: 'assistant', content: 'Принял документацию, использую именно эти API.' });
  }
  messages.push({ role: 'user', content: prompt });

  const ctx = { projectDir, bus, smokeRunner };

  let finishedMessage = null;
  let lastSmoke = null;
  const toolCallLog = [];

  // Если основная модель не поддерживает tools — fallback на «классический» путь:
  // один вызов callWithFallback и сами разбираем ответ. Используется только в
  // экстренном случае; в orchestrator стараемся выбрать tools-capable модель.
  if (!modelSupportsTools(coderModel)) {
    bus.warn('Tool-calling недоступен — пробую fallback на классический одношаговый режим.');
    const result = await callWithFallback({
      modelId: coderModel,
      messages,
      task: 'agent_coder',
      projectId,
      maxTokens: 32000,
      temperature: 0.4,
    });
    bus.donePhase('coder', { mode: 'no-tools-fallback' });
    return {
      ok: true,
      finished: true,
      classicText: result.text,
      modelUsed: result.modelUsed,
      usage: result.usage,
      iterations: 1,
      toolCallLog,
      smoke: null,
      message: result.text?.slice(0, 200) || '',
      residualAssistantText: '',
    };
  }

  try {
    const maxIters = plan?.kind === 'react-bundle' ? 24 : 16;
    const result = await callModelWithToolsAndFallback({
      modelId: coderModel,
      messages,
      tools: TOOL_DECLARATIONS,
      maxIters,
      maxTokens: 16000,
      temperature: 0.3,
      onText: (delta) => bus.emit('coder.token', { delta }),
      onToolCall: async (name, args, callId) => {
        bus.toolCall(name, summariseArgs(name, args), callId);
        toolCallLog.push({ name, args: summariseArgs(name, args) });
        const r = await executeTool(name, args, ctx);
        const summary = summariseResult(name, r);
        bus.toolResult(name, callId, !!r.ok, summary, r.ok ? null : (r.error || 'неизвестно'));
        if (name === 'run_smoke') lastSmoke = r;
        if (name === 'finish_generation' && r?.ok) {
          finishedMessage = r.message || '';
        }
        return r;
      },
      onProgress: (info) => {
        if (info?.kind === 'fallback') {
          const fromLabel = resolveModelConfig(info.from)?.label || info.from;
          const toLabel = resolveModelConfig(info.to)?.label || info.to;
          bus.warn(`Модель ${fromLabel} недоступна (${info.reason}). Переключаюсь на ${toLabel}.`);
          bus.emit('coder.fallback', { from: info.from, to: info.to, reason: info.reason });
        }
      },
    });

    if (result.fallbackFrom) {
      bus.emit('coder.modelUsed', {
        from: result.fallbackFrom,
        used: result.modelUsed,
      });
    }

    bus.donePhase('coder', {
      iterations: result.iterations,
      tools: toolCallLog.length,
      finished: !!finishedMessage,
      modelUsed: result.modelUsed,
      fallbackFrom: result.fallbackFrom,
    });
    return {
      ok: true,
      finished: !!finishedMessage,
      classicText: '',
      modelUsed: result.modelUsed,
      fallbackFrom: result.fallbackFrom,
      usage: result.usage,
      iterations: result.iterations,
      toolCallLog,
      smoke: lastSmoke,
      message: finishedMessage || '',
      residualAssistantText: (result.text || '').trim(),
    };
  } catch (e) {
    bus.errorPhase('coder', e?.message || String(e), e?.code);
    // Прокидываем дополнительные поля для дальнейшего использования сервером
    if (Array.isArray(e?.errors)) e.modelErrors = e.errors;
    throw e;
  }
}

function summariseArgs(name, args) {
  if (!args) return {};
  if (name === 'write_file') {
    return { path: args.path, bytes: args.content ? Buffer.byteLength(String(args.content), 'utf8') : 0 };
  }
  if (name === 'apply_patch') {
    return {
      path: args.path,
      oldLines: typeof args.oldStr === 'string' ? args.oldStr.split('\n').length : 0,
      newLines: typeof args.newStr === 'string' ? args.newStr.split('\n').length : 0,
    };
  }
  if (name === 'read_file') {
    return { path: args.path };
  }
  if (name === 'context7_lookup') {
    return { libraries: args.libraries };
  }
  return args;
}

function summariseResult(name, r) {
  if (!r) return null;
  if (name === 'read_file') return { path: r.path, size: r.size };
  if (name === 'write_file') return { path: r.path, bytes: r.bytes };
  if (name === 'apply_patch') return { path: r.path, deltaLines: r.deltaLines };
  if (name === 'context7_lookup') {
    return { libraries: (r.libraries || []).map((l) => l.name || l), chars: r.totalChars };
  }
  if (name === 'run_smoke') {
    return {
      ok: r.ok,
      runner: r.runner,
      errors: (r.errors || []).slice(0, 3),
      warnings: (r.warnings || []).slice(0, 2),
    };
  }
  if (name === 'finish_generation') {
    if (!r.ok) return { rejected: true, error: String(r.error || '').slice(0, 160) };
    return { message: (r.message || '').slice(0, 100) };
  }
  return null;
}
