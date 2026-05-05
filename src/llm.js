// Унифицированный роутер LLM: OpenAI, Claude, Gemini, Ollama, OpenRouter.
// Используется и в /api/generate (генератор сайтов), и в модуле ассистентов.
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { classifyLlmError, shortErrorLine, userMessageForKind } from './llm-errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/** Таймауты на одиночный вызов модели (можно переопределить через env). */
const SINGLE_CALL_TIMEOUT_MS = Math.max(
  30_000,
  parseInt(process.env.LLM_CALL_TIMEOUT_MS || '', 10) || 240_000,
);
const STREAM_CALL_TIMEOUT_MS = Math.max(
  60_000,
  parseInt(process.env.LLM_STREAM_TIMEOUT_MS || '', 10) || 600_000,
);

/** Сколько раз повторять один и тот же провайдер при retryable-ошибках. */
const PROVIDER_RETRY_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 1_500;

// =============================================================
// Клиенты SDK
// =============================================================
// SDK сами ретраят запросы — отключаем, чтобы не дублировать нашу логику.
export const ollama = new OpenAI({
  baseURL: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1',
  // SDK иначе может требовать OPENAI_API_KEY; для Ollama достаточно непустой строки
  apiKey: process.env.OLLAMA_TOKEN || 'ollama',
  maxRetries: 0,
  timeout: SINGLE_CALL_TIMEOUT_MS,
});

export const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: SINGLE_CALL_TIMEOUT_MS })
  : null;

export const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: SINGLE_CALL_TIMEOUT_MS })
  : null;

export const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

/** OpenAI-совместимый API OpenRouter — клиент создаём лениво после загрузки .env */
let openRouterClient = null;

export function isOpenRouterConfigured() {
  return !!(process.env.OPENROUTER_API_KEY || '').trim();
}

function getOpenRouterClient() {
  if (!isOpenRouterConfigured()) return null;
  if (!openRouterClient) {
    openRouterClient = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY.trim(),
      baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || process.env.PUBLIC_SITE_URL || 'https://botme.neeklo.ru',
        'X-Title': process.env.OPENROUTER_APP_TITLE || 'Botme',
      },
      maxRetries: 0,
      timeout: SINGLE_CALL_TIMEOUT_MS,
    });
  }
  return openRouterClient;
}

/** true, если для провайдера есть рабочий ключ/SDK. */
export function isProviderConfigured(provider) {
  switch (provider) {
    case 'ollama':     return true; // встроенный URL по умолчанию
    case 'openai':     return !!openai;
    case 'claude':     return !!anthropic;
    case 'gemini':     return !!gemini;
    case 'openrouter': return isOpenRouterConfigured();
    default:           return false;
  }
}

/** Создать AbortController, который автоматически abortится через timeoutMs. */
function makeTimeoutSignal(timeoutMs) {
  const ctrl = new AbortController();
  let timer = null;
  if (timeoutMs && Number.isFinite(timeoutMs)) {
    timer = setTimeout(() => {
      const err = new Error(`Превышен таймаут ожидания модели (${Math.round(timeoutMs / 1000)} с)`);
      err._botmeTimeout = true;
      ctrl.abort(err);
    }, timeoutMs);
  }
  return {
    signal: ctrl.signal,
    cleanup: () => { if (timer) clearTimeout(timer); },
  };
}

/** Слип на ms (для backoff между ретраями). */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// =============================================================
// Каталог моделей
// =============================================================
export const MODELS = [
  // Ollama
  { id: 'ollama:qwen2.5-coder:7b', label: 'Qwen 2.5 Coder 7B — локально, бесплатно', provider: 'ollama', model: 'qwen2.5-coder:7b' },
  { id: 'ollama:llama3:latest',    label: 'Llama 3 — локально',                       provider: 'ollama', model: 'llama3:latest' },

  // OpenAI
  { id: 'openai:gpt-5.4-mini',     label: 'GPT-5.4 mini — быстрая и дешёвая',          provider: 'openai', model: 'gpt-5.4-mini' },
  { id: 'openai:gpt-5.4',          label: 'GPT-5.4 — флагман для кода',                provider: 'openai', model: 'gpt-5.4' },
  { id: 'openai:gpt-5.1-codex',    label: 'GPT-5.1 Codex — заточен под код',           provider: 'openai', model: 'gpt-5.1-codex' },
  { id: 'openai:gpt-4.1-mini',     label: 'GPT-4.1 mini — лёгкая',                     provider: 'openai', model: 'gpt-4.1-mini' },
  { id: 'openai:gpt-4o',           label: 'GPT-4o',                                    provider: 'openai', model: 'gpt-4o' },

  // Claude
  { id: 'claude:claude-haiku-4-5-20251001',   label: 'Claude Haiku 4.5 — быстрая',     provider: 'claude', model: 'claude-haiku-4-5-20251001' },
  { id: 'claude:claude-sonnet-4-6',           label: 'Claude Sonnet 4.6 — топ для UI', provider: 'claude', model: 'claude-sonnet-4-6' },
  { id: 'claude:claude-sonnet-4-5-20250929',  label: 'Claude Sonnet 4.5',              provider: 'claude', model: 'claude-sonnet-4-5-20250929' },
  { id: 'claude:claude-opus-4-7',             label: 'Claude Opus 4.7 — самый мощный', provider: 'claude', model: 'claude-opus-4-7' },

  // Gemini
  { id: 'gemini:gemini-2.0-flash', label: 'Gemini 2.0 Flash',     provider: 'gemini', model: 'gemini-2.0-flash' },
  { id: 'gemini:gemini-2.5-flash', label: 'Gemini 2.5 Flash',     provider: 'gemini', model: 'gemini-2.5-flash' },
  { id: 'gemini:gemini-2.5-pro',   label: 'Gemini 2.5 Pro',       provider: 'gemini', model: 'gemini-2.5-pro' },
];

/**
 * Цепочка фоллбеков. Сначала чередуем провайдеров (быстрые/дешёвые) — это
 * защищает от провайдер-широких сбоев (баланс кончился, ключ просрочен,
 * outage у одного провайдера). Дальше — более тяжёлые модели и резерв на ollama.
 */
export const FALLBACK_PRIORITY = [
  'claude:claude-haiku-4-5-20251001',     // быстрый и дешёвый
  'openai:gpt-4o',                        // классика, обычно стабильна
  'gemini:gemini-2.5-flash',              // быстрая
  'claude:claude-sonnet-4-5-20250929',    // более качественная Sonnet
  'openai:gpt-4.1-mini',                  // лёгкая
  'gemini:gemini-2.0-flash',              // ещё резерв
  'claude:claude-sonnet-4-6',             // топ-Sonnet
  'openai:gpt-5.4-mini',                  // топ-семейство (если есть в аккаунте)
  'gemini:gemini-2.5-pro',                // мощная
  'openai:gpt-5.4',                       // флагман OpenAI
  'claude:claude-opus-4-7',               // самый мощный (дорогой)
  'ollama:qwen2.5-coder:7b',              // локальный резерв
];

// =============================================================
// OpenRouter: модели с supported_parameters.tools (список с API, кэш)
// =============================================================
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_CACHE_MS = 60 * 60 * 1000;
let openRouterCatalogCache = { ts: 0, entries: [] };

function isOpenRouterFreePricing(pricing) {
  if (!pricing) return false;
  const pi = Number(pricing.prompt ?? pricing.input ?? 0);
  const po = Number(pricing.completion ?? pricing.output ?? 0);
  return pi === 0 && po === 0;
}

/** Короткое русское пояснение по описанию/id (как у статического каталога). */
function ruHintOpenRouter(m) {
  const blob = `${m.id || ''} ${m.name || ''} ${m.description || ''}`.toLowerCase();
  if (/nemotron|owl|agentic|multi-agent|tool calling|tool-calling|enterprise agent/i.test(blob)) {
    return 'агенты и tool-calling';
  }
  if (/reasoning|chain-of-thought|\br1\b|think/i.test(blob)) return 'рассуждения, сложная логика';
  if (/code|coder|granite|devstral|starcoder|qwen.*coder|codex/i.test(blob)) return 'код и UI';
  if (/flash|lite|nano|tiny|mini|small|8b\b|7b\b|3b\b/i.test(blob)) return 'быстрая / экономичная';
  if (/opus|405|400b|120b|ultra|heavy|grok 4|medium 3|sonnet|large/i.test(blob)) return 'тяжёлые задачи, длинный контекст';
  if (/multimodal|vision|image|omni|pixtral|audio|video/i.test(blob)) return 'мультимодальность';
  if (/finance|legal|medical|enterprise/i.test(blob)) return 'отраслевые сценарии';
  return 'универсальный чат с tools';
}

export async function fetchOpenRouterToolModelsCached() {
  const now = Date.now();
  if (openRouterCatalogCache.entries.length && now - openRouterCatalogCache.ts < OPENROUTER_CACHE_MS) {
    return openRouterCatalogCache.entries;
  }
  const res = await fetch(OPENROUTER_MODELS_URL);
  if (!res.ok) throw new Error(`OpenRouter models HTTP ${res.status}`);
  const data = await res.json();
  const list = data.data || [];
  const toolsModels = list.filter(
    (m) => Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools'),
  );
  const entries = toolsModels.map((m) => {
    const slug = m.id;
    const free = isOpenRouterFreePricing(m.pricing);
    const shortName = String(m.name || slug).replace(/\s*\(free\)\s*$/i, '').trim();
    const hint = ruHintOpenRouter(m);
    const label = `${shortName} — ${hint}${free ? ' · 🆓 бесплатно' : ''}`;
    return {
      id: `openrouter:${slug}`,
      label,
      provider: 'openrouter',
      model: slug,
      openrouterFree: free,
    };
  });
  entries.sort((a, b) => {
    if (a.openrouterFree !== b.openrouterFree) return a.openrouterFree ? -1 : 1;
    return a.label.localeCompare(b.label, 'ru');
  });
  openRouterCatalogCache = { ts: now, entries };
  return entries;
}

/** Статический каталог + OpenRouter (список моделей с публичного API; вызов — только с ключом). */
export async function getModelsMerged() {
  const base = MODELS.map((m) => ({ ...m, openrouterFree: false }));
  try {
    const extra = await fetchOpenRouterToolModelsCached();
    return [...base, ...extra];
  } catch (e) {
    console.warn('[openrouter] каталог моделей:', e?.message || e);
    return base;
  }
}

/** Разрешить id модели (статическая или openrouter:vendor/model). */
export function resolveModelConfig(modelId) {
  const hit = MODELS.find((m) => m.id === modelId);
  if (hit) return hit;
  if (!modelId || typeof modelId !== 'string' || !modelId.startsWith('openrouter:')) return null;
  const slug = modelId.slice('openrouter:'.length).trim();
  if (!slug) return null;
  return { id: modelId, label: slug, provider: 'openrouter', model: slug };
}

// =============================================================
// Один запрос к модели → { text, usage: {input, output, total} }
// timeoutMs — обязательный per-call таймаут на всю операцию.
// =============================================================
export async function callModel(modelId, messages, opts = {}) {
  const { maxTokens, temperature = 0.4, stream = false, onDelta, timeoutMs } = opts;
  const cfg = resolveModelConfig(modelId);
  if (!cfg) throw new Error(`Неизвестная модель: ${modelId}`);

  const sys = messages.find((m) => m.role === 'system')?.content || '';
  const dialog = messages.filter((m) => m.role !== 'system');

  const effTimeout = Number.isFinite(timeoutMs) ? timeoutMs : (stream ? STREAM_CALL_TIMEOUT_MS : SINGLE_CALL_TIMEOUT_MS);
  const { signal, cleanup } = makeTimeoutSignal(effTimeout);

  try {
    if (cfg.provider === 'ollama') {
      if (stream && onDelta) {
        const resp = await ollama.chat.completions.create({
          model: cfg.model,
          messages: [{ role: 'system', content: sys }, ...dialog],
          stream: true,
          temperature,
          max_tokens: maxTokens || 16384,
        }, { signal });
        let full = ''; let usage = { input: 0, output: 0, total: 0 };
        for await (const part of resp) {
          const d = part.choices?.[0]?.delta?.content || '';
          if (d) { full += d; onDelta(d); }
          if (part.usage) usage = { input: part.usage.prompt_tokens || 0, output: part.usage.completion_tokens || 0, total: part.usage.total_tokens || 0 };
        }
        return { text: full, usage };
      }
      const r = await ollama.chat.completions.create({
        model: cfg.model,
        messages: [{ role: 'system', content: sys }, ...dialog],
        stream: false, temperature, max_tokens: maxTokens || 16384,
      }, { signal });
      const u = r.usage || {};
      return { text: r.choices[0].message.content || '', usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, total: u.total_tokens || 0 } };
    }

    if (cfg.provider === 'openai') {
      if (!openai) throw new Error('OPENAI_API_KEY не настроен');
      const isGpt5 = /^gpt-5/i.test(cfg.model) || /^o[1-9]/.test(cfg.model);
      const params = { model: cfg.model, messages: [{ role: 'system', content: sys }, ...dialog] };
      if (isGpt5) params.max_completion_tokens = maxTokens || 16384;
      else { params.max_tokens = maxTokens || 8192; params.temperature = temperature; }

      if (stream && onDelta) {
        const s = await openai.chat.completions.create(
          { ...params, stream: true, stream_options: { include_usage: true } },
          { signal },
        );
        let full = ''; let usage = { input: 0, output: 0, total: 0 };
        for await (const part of s) {
          const d = part.choices?.[0]?.delta?.content || '';
          if (d) { full += d; onDelta(d); }
          if (part.usage) usage = { input: part.usage.prompt_tokens || 0, output: part.usage.completion_tokens || 0, total: part.usage.total_tokens || 0 };
        }
        return { text: full, usage };
      }
      const r = await openai.chat.completions.create(params, { signal });
      const u = r.usage || {};
      return { text: r.choices[0].message.content || '', usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, total: u.total_tokens || 0 } };
    }

    if (cfg.provider === 'claude') {
      if (!anthropic) throw new Error('ANTHROPIC_API_KEY не настроен');
      const maxOutByModel = /opus-4-7|sonnet-4-6|opus-4-6/i.test(cfg.model) ? 64000 : 32000;
      const baseParams = {
        model: cfg.model,
        max_tokens: maxTokens || maxOutByModel,
        system: sys,
        messages: dialog.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      };

      if (stream && onDelta) {
        let full = ''; let usage = { input: 0, output: 0, total: 0 };
        const s = await anthropic.messages.stream(baseParams, { signal });
        for await (const ev of s) {
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            const d = ev.delta.text || '';
            if (d) { full += d; onDelta(d); }
          }
        }
        const final = await s.finalMessage();
        const u = final.usage || {};
        usage = { input: u.input_tokens || 0, output: u.output_tokens || 0, total: (u.input_tokens || 0) + (u.output_tokens || 0) };
        return { text: full, usage };
      }

      const r = await anthropic.messages.create(baseParams, { signal });
      const u = r.usage || {};
      return {
        text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''),
        usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, total: (u.input_tokens || 0) + (u.output_tokens || 0) },
      };
    }

    if (cfg.provider === 'gemini') {
      if (!gemini) throw new Error('GEMINI_API_KEY не настроен');
      const model = gemini.getGenerativeModel({
        model: cfg.model, systemInstruction: sys,
        generationConfig: { maxOutputTokens: maxTokens || 16384, temperature },
      });
      const history = dialog.slice(0, -1).map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const last = dialog[dialog.length - 1];
      const chat = model.startChat({ history });

      // GoogleGenerativeAI старых версий не принимает signal — оборачиваем гонкой.
      if (stream && onDelta) {
        const streamCall = chat.sendMessageStream(last?.content || '');
        const s = await raceWithSignal(streamCall, signal);
        let full = '';
        for await (const part of s.stream) {
          if (signal?.aborted) throw makeAbortError(signal);
          const d = part.text() || '';
          if (d) { full += d; onDelta(d); }
        }
        const final = await s.response;
        const u = final.usageMetadata || {};
        return { text: full, usage: { input: u.promptTokenCount || 0, output: u.candidatesTokenCount || 0, total: u.totalTokenCount || 0 } };
      }

      const r = await raceWithSignal(chat.sendMessage(last?.content || ''), signal);
      const u = r.response.usageMetadata || {};
      return {
        text: r.response.text(),
        usage: { input: u.promptTokenCount || 0, output: u.candidatesTokenCount || 0, total: u.totalTokenCount || ((u.promptTokenCount || 0) + (u.candidatesTokenCount || 0)) },
      };
    }

    if (cfg.provider === 'openrouter') {
      const or = getOpenRouterClient();
      if (!or) throw new Error('OPENROUTER_API_KEY не настроен');
      const cap = Math.min(maxTokens || 16384, 128000);
      const params = {
        model: cfg.model,
        messages: [{ role: 'system', content: sys }, ...dialog],
        max_tokens: cap,
        temperature,
      };

      if (stream && onDelta) {
        const s = await or.chat.completions.create({ ...params, stream: true }, { signal });
        let full = '';
        let usage = { input: 0, output: 0, total: 0 };
        for await (const part of s) {
          const d = part.choices?.[0]?.delta?.content || '';
          if (d) { full += d; onDelta(d); }
          const u = part.usage;
          if (u) usage = { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, total: u.total_tokens || 0 };
        }
        return { text: full, usage };
      }
      const r = await or.chat.completions.create(params, { signal });
      const u = r.usage || {};
      return {
        text: r.choices?.[0]?.message?.content || '',
        usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, total: u.total_tokens || 0 },
      };
    }

    throw new Error(`Неизвестный провайдер: ${cfg.provider}`);
  } finally {
    cleanup();
  }
}

/** Утилита для SDK без поддержки signal: гонка между обещанием и abort. */
function raceWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeAbortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(makeAbortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function makeAbortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('Request aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Построить цепочку фоллбеков. Отбрасываем модели, для которых нет ключа,
 * чтобы не тратить попытки. Дубликаты убираем.
 */
export function buildFallbackChain(primary) {
  const seen = new Set();
  const out = [];
  const tryAdd = (id) => {
    if (!id || seen.has(id)) return;
    const cfg = resolveModelConfig(id);
    if (!cfg) return;
    if (!isProviderConfigured(cfg.provider)) return;
    seen.add(id);
    out.push(id);
  };
  tryAdd(primary);
  for (const id of FALLBACK_PRIORITY) tryAdd(id);
  return out;
}

// =============================================================
// Запись в общую статистику (projects/_stats.json) — генератор сайтов
// =============================================================
const PROJECTS_DIR = path.resolve(__dirname, '..', 'projects');
const STATS_FILE   = path.join(PROJECTS_DIR, '_stats.json');

function emptyAgg() { return { calls: 0, input: 0, output: 0, total: 0 }; }

let _statsLock = Promise.resolve();
async function _readStats() {
  try { return JSON.parse(await fs.readFile(STATS_FILE, 'utf8')); }
  catch { return { totals: emptyAgg(), byTask: {}, byModel: {}, byProject: {}, history: [] }; }
}
async function _writeStats(s) {
  _statsLock = _statsLock.then(async () => {
    await fs.mkdir(PROJECTS_DIR, { recursive: true });
    await fs.writeFile(STATS_FILE, JSON.stringify(s, null, 2), 'utf8');
  });
  return _statsLock;
}

export async function recordUsage({ task, modelId, projectId, usage, elapsedMs }) {
  const stats = await _readStats();
  const inc = (target) => {
    target.calls += 1;
    target.input += usage.input || 0;
    target.output += usage.output || 0;
    target.total += usage.total || ((usage.input || 0) + (usage.output || 0));
  };
  inc((stats.totals ||= emptyAgg()));
  inc((stats.byTask[task] ||= emptyAgg()));
  inc((stats.byModel[modelId] ||= emptyAgg()));
  if (projectId) {
    const p = (stats.byProject[projectId] ||= { ...emptyAgg(), byModel: {} });
    inc(p);
    inc((p.byModel[modelId] ||= emptyAgg()));
  }
  stats.history.unshift({
    ts: Date.now(), task, modelId, projectId: projectId || null,
    input: usage.input || 0, output: usage.output || 0, total: usage.total || 0,
    elapsedMs: elapsedMs || 0,
  });
  if (stats.history.length > 200) stats.history.length = 200;
  await _writeStats(stats);
}

export async function readGeneratorStats() {
  return await _readStats();
}

export async function resetGeneratorStats() {
  await _writeStats({ totals: emptyAgg(), byTask: {}, byModel: {}, byProject: {}, history: [] });
}

// =============================================================
// Главный публичный вызов: с фоллбеками + автоматическая запись статистики.
// Логика:
//  1) Перебираем модели из buildFallbackChain.
//  2) Для каждой — до PROVIDER_RETRY_ATTEMPTS попыток на временные ошибки
//     (rate_limit / overloaded / network / timeout) с экспоненциальным backoff.
//  3) Ошибки auth/quota помечают весь провайдер как «не пробовать дальше».
//  4) Если стрим успел отдать клиенту хотя бы один delta — fallback запрещён
//     (текст уже частично у пользователя, иначе будет «склейка» из двух моделей).
// =============================================================
export async function callWithFallback({ modelId, messages, task, projectId, assistantId, statSource, maxTokens, temperature, stream, onDelta, timeoutMs }) {
  const { recordAssistantUsage } = await import('./db.js'); // ленивый импорт — модуль может не использоваться
  const chain = buildFallbackChain(modelId);
  if (!chain.length) {
    const err = new Error('Нет доступных моделей. Проверьте, что хотя бы один из ключей провайдеров настроен в .env (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / OLLAMA_BASE_URL).');
    err.code = 'no_models';
    err.errors = [];
    throw err;
  }

  const errors = [];
  const skipProviders = new Set();

  let streamHasOutput = false;
  const wrappedOnDelta = stream && typeof onDelta === 'function'
    ? (delta) => { if (delta) streamHasOutput = true; onDelta(delta); }
    : onDelta;

  for (let i = 0; i < chain.length; i++) {
    const id = chain[i];
    const cfg = resolveModelConfig(id);
    if (!cfg) continue;
    if (skipProviders.has(cfg.provider)) {
      errors.push({ model: id, kind: 'skipped_provider', provider: cfg.provider });
      continue;
    }

    let lastInfo = null;
    for (let attempt = 0; attempt < PROVIDER_RETRY_ATTEMPTS; attempt++) {
      try {
        const t0 = Date.now();
        const result = await callModel(id, messages, {
          maxTokens, temperature, stream, onDelta: wrappedOnDelta, timeoutMs,
        });
        const elapsedMs = Date.now() - t0;
        if (task) await recordUsage({ task, modelId: id, projectId, usage: result.usage, elapsedMs });
        if (assistantId) recordAssistantUsage({ assistantId, model: id, source: statSource || 'admin', input: result.usage.input, output: result.usage.output });
        return { ...result, modelUsed: id, fallbackFrom: i === 0 ? null : modelId, errors };
      } catch (e) {
        const info = classifyLlmError(e);
        lastInfo = info;
        errors.push({
          model: id,
          provider: cfg.provider,
          attempt: attempt + 1,
          kind: info.kind,
          status: info.status,
          message: info.userMessage,
          raw: info.raw,
        });
        console.warn(`[fallback] ${id} (try ${attempt + 1}): ${shortErrorLine(info)}`);

        // Стрим уже отдал часть текста клиенту — нельзя fallback-нуть на другую модель.
        if (streamHasOutput) {
          const err = new Error(`Стрим прерван: ${info.userMessage}`);
          err.code = info.kind;
          err.errors = errors;
          err.modelUsed = id;
          err.fallbackFrom = i === 0 ? null : modelId;
          err.streamPartial = true;
          throw err;
        }

        if (info.skipProvider) {
          skipProviders.add(cfg.provider);
          break; // дальше — следующая модель в цепочке (но не этот провайдер)
        }
        if (!info.retryable || attempt === PROVIDER_RETRY_ATTEMPTS - 1) {
          break; // переходим к следующей модели в цепочке
        }
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await sleep(delay);
      }
    }
    // здесь идём дальше по chain; lastInfo записан в errors
    void lastInfo;
  }

  const last = errors[errors.length - 1];
  const err = new Error(
    last
      ? `Все модели недоступны (последняя — ${last.model}: ${last.message || last.raw || last.kind}).`
      : 'Все модели недоступны.',
  );
  err.code = last?.kind || 'unknown';
  err.userMessage = last?.message || userMessageForKind(err.code);
  err.errors = errors;
  err.suggestedAlternatives = chain.slice(0, 3).map((id) => ({
    id,
    label: resolveModelConfig(id)?.label || id,
  }));
  throw err;
}
