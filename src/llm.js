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
const PROVIDER_RETRY_ATTEMPTS = 3;
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

/** OpenAI-совместимый API xAI (Grok). Документация: https://docs.x.ai/api */
let xaiClient = null;

export function isXaiConfigured() {
  return !!(process.env.XAI_API_KEY || process.env.GROK_API_KEY || '').trim();
}

function getXaiClient() {
  if (!isXaiConfigured()) return null;
  if (!xaiClient) {
    xaiClient = new OpenAI({
      apiKey: (process.env.XAI_API_KEY || process.env.GROK_API_KEY).trim(),
      baseURL: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
      maxRetries: 0,
      timeout: SINGLE_CALL_TIMEOUT_MS,
    });
  }
  return xaiClient;
}

/** true, если для провайдера есть рабочий ключ/SDK. */
export function isProviderConfigured(provider) {
  switch (provider) {
    case 'ollama':     return true; // встроенный URL по умолчанию
    case 'openai':     return !!openai;
    case 'claude':     return !!anthropic;
    case 'gemini':     return !!gemini;
    case 'openrouter': return isOpenRouterConfigured();
    case 'xai':        return isXaiConfigured();
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
// Live-статус провайдеров (для UI-баннера)
// При каждой ошибке записываем kind/message; ok-вызов очищает запись провайдера.
// =============================================================
const _providerStatus = new Map(); // provider -> { kind, message, ts }

export function recordProviderError(provider, info) {
  if (!provider) return;
  _providerStatus.set(provider, {
    kind: info?.kind || 'unknown',
    message: info?.userMessage || info?.message || '',
    status: info?.status,
    ts: Date.now(),
  });
}

export function recordProviderOk(provider) {
  if (!provider) return;
  _providerStatus.delete(provider);
}

export function getProviderStatus() {
  // Возвращаем только «свежие» (моложе 6ч) записи
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const out = {};
  for (const [k, v] of _providerStatus.entries()) {
    if (v.ts < cutoff) { _providerStatus.delete(k); continue; }
    out[k] = v;
  }
  return out;
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

  // xAI (Grok)
  { id: 'xai:grok-4-fast',         label: 'Grok 4 Fast — быстрый, дешёвый', provider: 'xai', model: 'grok-4-fast' },
  { id: 'xai:grok-4',              label: 'Grok 4 — флагман xAI',           provider: 'xai', model: 'grok-4' },
  { id: 'xai:grok-3-mini',         label: 'Grok 3 mini — лёгкая',           provider: 'xai', model: 'grok-3-mini' },
  { id: 'xai:grok-3',              label: 'Grok 3',                          provider: 'xai', model: 'grok-3' },
  { id: 'xai:grok-code-fast-1',    label: 'Grok Code Fast — для кода',       provider: 'xai', model: 'grok-code-fast-1' },

  // OpenRouter — отобранный список бесплатных моделей. Подключаются только
  // при наличии OPENROUTER_API_KEY (валидном ключе). Список — компромисс
  // между качеством, скоростью и стабильностью; обновлять раз в квартал.
  { id: 'openrouter:meta-llama/llama-3.3-70b-instruct:free',
    label: 'Llama 3.3 70B (free) — сильный универсальный',
    provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free', openrouterFree: true },
  { id: 'openrouter:google/gemini-2.0-flash-exp:free',
    label: 'Gemini 2.0 Flash (free) — быстрая, мультимодальная',
    provider: 'openrouter', model: 'google/gemini-2.0-flash-exp:free', openrouterFree: true },
  { id: 'openrouter:deepseek/deepseek-chat-v3:free',
    label: 'DeepSeek Chat v3 (free) — рассуждения и код',
    provider: 'openrouter', model: 'deepseek/deepseek-chat-v3:free', openrouterFree: true },
  { id: 'openrouter:qwen/qwen-2.5-coder-32b-instruct:free',
    label: 'Qwen 2.5 Coder 32B (free) — заточен под код',
    provider: 'openrouter', model: 'qwen/qwen-2.5-coder-32b-instruct:free', openrouterFree: true },
  { id: 'openrouter:nvidia/nemotron-nano-9b-v2:free',
    label: 'Nemotron Nano 9B (free) — лёгкая, быстрая',
    provider: 'openrouter', model: 'nvidia/nemotron-nano-9b-v2:free', openrouterFree: true },
  { id: 'openrouter:mistralai/mistral-small-3.2-24b-instruct:free',
    label: 'Mistral Small 3.2 24B (free) — универсальный баланс',
    provider: 'openrouter', model: 'mistralai/mistral-small-3.2-24b-instruct:free', openrouterFree: true },
  { id: 'openrouter:meta-llama/llama-3.2-3b-instruct:free',
    label: 'Llama 3.2 3B (free) — мини-модель для быстрых ответов',
    provider: 'openrouter', model: 'meta-llama/llama-3.2-3b-instruct:free', openrouterFree: true },
];

/**
 * Лимиты output-токенов по моделям. Если запрошенный maxTokens больше — зажимаем.
 * Без этого gpt-4o валится с `context_overflow/400 — max_tokens is too large: 32000` и
 * фактически выбрасывает сильную модель из fallback-цепочки.
 *
 * Источники: docs OpenAI / Anthropic / Google / xAI на 2026-Q1. Если значение не найдено
 * — берём суффикс семейства через resolveMaxOutputTokens().
 */
export const MODEL_MAX_OUTPUT_TOKENS = {
  // OpenAI
  'gpt-4o':                       16384,
  'gpt-4.1-mini':                 16384,
  'gpt-5.4':                      32000,
  'gpt-5.4-mini':                 32000,
  'gpt-5.1-codex':                32000,
  // Anthropic
  'claude-haiku-4-5-20251001':    64000,
  'claude-sonnet-4-5-20250929':   64000,
  'claude-sonnet-4-6':            64000,
  'claude-opus-4-7':              64000,
  // Google
  'gemini-2.0-flash':              8192,
  'gemini-2.5-flash':              8192,
  'gemini-2.5-pro':               65536,
  // xAI
  'grok-4':                       32000,
  'grok-4-fast':                  32000,
  'grok-3':                       32000,
  'grok-3-mini':                  32000,
  'grok-code-fast-1':             32000,
};

/** Возвращает безопасный maxTokens для конкретной модели (зажимает по таблице). */
export function resolveMaxOutputTokens(modelName, requested) {
  const direct = MODEL_MAX_OUTPUT_TOKENS[modelName];
  if (direct) return Math.min(requested ?? direct, direct);
  // Эвристика по префиксу семейства
  if (/^gpt-4o/.test(modelName))            return Math.min(requested ?? 16384, 16384);
  if (/^gpt-4\.1/.test(modelName))          return Math.min(requested ?? 16384, 16384);
  if (/^gpt-5/.test(modelName))             return Math.min(requested ?? 32000, 32000);
  if (/^o[1-9]/.test(modelName))            return Math.min(requested ?? 32000, 32000);
  if (/^claude/.test(modelName))            return Math.min(requested ?? 32000, 64000);
  if (/^gemini-2\.5-pro/.test(modelName))   return Math.min(requested ?? 65536, 65536);
  if (/^gemini/.test(modelName))            return Math.min(requested ?? 8192, 8192);
  if (/^grok/.test(modelName))              return Math.min(requested ?? 32000, 32000);
  return requested ?? 16384;
}

/**
 * Цепочка фоллбеков. Порядок выбран эмпирически по фактической доступности
 * на нашем сервере (см. `scripts/check-providers.mjs`):
 *  - OpenAI direct — стабильный (gpt-4o, gpt-4.1-mini), идёт первым;
 *  - OpenRouter (платные модели) — удобный «универсальный» доступ к Claude/GPT
 *    при отсутствии баланса на Anthropic-direct; менее предпочтителен из-за
 *    наценки ~5%;
 *  - Anthropic-direct — нужен баланс, оставляем НИЖЕ OpenRouter, чтобы не
 *    ловить quota/400 в первую очередь;
 *  - Gemini/xAI/Ollama — резерв, активны только если ключи валидны.
 *
 * Бесплатные OpenRouter (`*:free`) сюда не кладём — у них постоянный 429
 * upstream rate-limit, они блокируют чейн.
 */
export const FALLBACK_PRIORITY = [
  // ── OpenAI direct (проверено: стабильно) ─────────────────────────────
  'openai:gpt-4o',                                // быстрый, надёжный, для большинства сайтов
  'openai:gpt-4.1-mini',                          // лёгкий резерв
  // ── OpenRouter платные (универсальный мост, работает даже без direct ключей) ──
  'openrouter:anthropic/claude-sonnet-4',         // Sonnet через OR — рабочая альтернатива direct
  'openrouter:anthropic/claude-3.5-sonnet',       // ещё одна Sonnet через OR
  'openrouter:openai/gpt-4o',                     // GPT-4o через OR
  'openrouter:openai/gpt-4o-mini',                // дешёвый и быстрый
  'openrouter:google/gemini-2.5-flash',           // Gemini через OR (если direct ключ не работает)
  'openrouter:x-ai/grok-4-fast',                  // Grok через OR
  // ── Anthropic direct (нужен баланс на console.anthropic.com) ──────────
  'claude:claude-haiku-4-5-20251001',
  'claude:claude-sonnet-4-5-20250929',
  'claude:claude-sonnet-4-6',
  'claude:claude-opus-4-7',
  // ── Gemini direct (нужен валидный ключ) ───────────────────────────────
  'gemini:gemini-2.5-flash',
  'gemini:gemini-2.5-pro',
  'gemini:gemini-2.0-flash',
  // ── xAI direct ────────────────────────────────────────────────────────
  'xai:grok-4-fast',
  'xai:grok-code-fast-1',
  'xai:grok-4',
  // ── OpenAI флагманы (если в аккаунте есть доступ) ─────────────────────
  'openai:gpt-5.4-mini',
  'openai:gpt-5.4',
  // ── Локальный резерв ──────────────────────────────────────────────────
  'ollama:qwen2.5-coder:7b',
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
    const safeMaxTokens = resolveMaxOutputTokens(cfg.model, maxTokens);

    if (cfg.provider === 'ollama') {
      if (stream && onDelta) {
        const resp = await ollama.chat.completions.create({
          model: cfg.model,
          messages: [{ role: 'system', content: sys }, ...dialog],
          stream: true,
          temperature,
          max_tokens: safeMaxTokens,
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
        stream: false, temperature, max_tokens: safeMaxTokens,
      }, { signal });
      const u = r.usage || {};
      return { text: r.choices[0].message.content || '', usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, total: u.total_tokens || 0 } };
    }

    if (cfg.provider === 'openai') {
      if (!openai) throw new Error('OPENAI_API_KEY не настроен');
      const isGpt5 = /^gpt-5/i.test(cfg.model) || /^o[1-9]/.test(cfg.model);
      const params = { model: cfg.model, messages: [{ role: 'system', content: sys }, ...dialog] };
      if (isGpt5) params.max_completion_tokens = safeMaxTokens;
      else { params.max_tokens = safeMaxTokens; params.temperature = temperature; }

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
      const baseParams = {
        model: cfg.model,
        max_tokens: safeMaxTokens,
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
        generationConfig: { maxOutputTokens: safeMaxTokens, temperature },
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

    if (cfg.provider === 'xai') {
      const xc = getXaiClient();
      if (!xc) throw new Error('XAI_API_KEY не настроен');
      const params = {
        model: cfg.model,
        messages: [{ role: 'system', content: sys }, ...dialog],
        max_tokens: safeMaxTokens,
        temperature,
      };
      if (stream && onDelta) {
        const s = await xc.chat.completions.create(
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
      const r = await xc.chat.completions.create(params, { signal });
      const u = r.usage || {};
      return {
        text: r.choices?.[0]?.message?.content || '',
        usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, total: u.total_tokens || 0 },
      };
    }

    if (cfg.provider === 'openrouter') {
      const or = getOpenRouterClient();
      if (!or) throw new Error('OPENROUTER_API_KEY не настроен');
      // OpenRouter маршрутизирует разные провайдеры — единый верхний предел 128k,
      // но конкретная модель может иметь меньший. Зажимаем максимум 32k чтоб не
      // ловить «context_overflow» от моделей с короткими window'ами.
      const cap = Math.min(safeMaxTokens, 32000);
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

// =============================================================
// Tool-calling: единый интерфейс поверх OpenAI/Anthropic/xAI/OpenRouter
//
// Параметры:
//   modelId      — id модели из каталога
//   messages     — [{role:'system'|'user'|'assistant', content:string}]
//   tools        — TOOL_DECLARATIONS (см. src/agent/tools.js); конвертируется внутри
//   onToolCall   — async (name, args, callId) => result; вернётся модели
//                  (Caller отвечает за побочные эффекты — read_file и т.д.)
//   onText       — (delta) => void; для стриминга текстовых дельт (опционально)
//   maxIters     — сколько раз подряд звать модель в цикле tool_calls (default 10)
//   maxTokens    — лимит на ответ (зажимается по MODEL_MAX_OUTPUT_TOKENS)
//   temperature  — обычно 0.2-0.4 для агентского кода
//
// Возвращает { text, usage, finishReason, modelUsed, iterations }
// =============================================================
export async function callModelWithTools({
  modelId,
  messages,
  tools = [],
  onToolCall,
  onText,
  maxIters = 10,
  maxTokens,
  temperature = 0.3,
  timeoutMs,
}) {
  const cfg = resolveModelConfig(modelId);
  if (!cfg) throw new Error(`Неизвестная модель: ${modelId}`);
  if (typeof onToolCall !== 'function') throw new Error('callModelWithTools: onToolCall обязателен');

  const safeMaxTokens = resolveMaxOutputTokens(cfg.model, maxTokens);
  const usageAgg = { input: 0, output: 0, total: 0 };
  let finalText = '';
  let finishReason = null;
  let iterations = 0;

  // Anthropic — отдельная ветка, у них свой content-block формат
  if (cfg.provider === 'claude') {
    if (!anthropic) throw new Error('ANTHROPIC_API_KEY не настроен');
    const sys = messages.find((m) => m.role === 'system')?.content || '';
    const dialog = messages.filter((m) => m.role !== 'system');
    // Конвертируем в Anthropic-формат (роли: user/assistant; content: text + tool_use/tool_result)
    const anthMessages = dialog.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content,
    }));
    const toolsMod = await import('./agent/tools.js').catch(() => null);
    const anthTools = toolsMod?.toolsForAnthropic
      ? toolsMod.toolsForAnthropic(tools)
      : tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

    while (iterations < maxIters) {
      iterations += 1;
      const resp = await callApiWithTransportRetry(
        async () => {
          const { signal, cleanup } = makeTimeoutSignal(timeoutMs ?? SINGLE_CALL_TIMEOUT_MS);
          try {
            return await anthropic.messages.create({
              model: cfg.model,
              max_tokens: safeMaxTokens,
              system: sys,
              messages: anthMessages,
              tools: anthTools,
            }, { signal });
          } finally { cleanup(); }
        },
        `claude:${cfg.model} iter#${iterations}`,
      );
      const u = resp.usage || {};
      usageAgg.input += u.input_tokens || 0;
      usageAgg.output += u.output_tokens || 0;
      usageAgg.total += (u.input_tokens || 0) + (u.output_tokens || 0);
      finishReason = resp.stop_reason || null;

      const blocks = Array.isArray(resp.content) ? resp.content : [];
      const textBlocks = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('');
      const toolUses = blocks.filter((b) => b.type === 'tool_use');

      if (textBlocks) {
        finalText += (finalText ? '\n' : '') + textBlocks;
        if (typeof onText === 'function' && textBlocks) onText(textBlocks);
      }

      if (resp.stop_reason !== 'tool_use' || !toolUses.length) {
        // Готово — модель закончила без tool-calls
        break;
      }

      // Кладём ответ ассистента (с tool_use блоками) в историю
      anthMessages.push({ role: 'assistant', content: blocks });

      // Выполняем tool-calls и формируем tool_result блоки
      const resultBlocks = [];
      for (const tu of toolUses) {
        let result;
        try {
          result = await onToolCall(tu.name, tu.input || {}, tu.id);
        } catch (e) {
          result = { ok: false, error: e?.message || String(e) };
        }
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: typeof result === 'string' ? result : JSON.stringify(result).slice(0, 80_000),
          is_error: !result?.ok,
        });
        if (result?.finished) {
          // finish_generation — модель пометила сама себя как готовую
          return {
            text: finalText || result?.message || '',
            usage: usageAgg,
            finishReason: 'finished',
            modelUsed: modelId,
            iterations,
          };
        }
      }
      anthMessages.push({ role: 'user', content: resultBlocks });
    }

    return { text: finalText, usage: usageAgg, finishReason, modelUsed: modelId, iterations };
  }

  // OpenAI / xAI / OpenRouter — единый openai-совместимый формат
  const isOpenAI     = cfg.provider === 'openai';
  const isXai        = cfg.provider === 'xai';
  const isOpenRouter = cfg.provider === 'openrouter';
  if (!(isOpenAI || isXai || isOpenRouter)) {
    throw new Error(`Tool-calling не поддерживается для провайдера: ${cfg.provider}`);
  }

  let client;
  if (isOpenAI) {
    if (!openai) throw new Error('OPENAI_API_KEY не настроен');
    client = openai;
  } else if (isXai) {
    client = getXaiClient();
    if (!client) throw new Error('XAI_API_KEY не настроен');
  } else {
    client = getOpenRouterClient();
    if (!client) throw new Error('OPENROUTER_API_KEY не настроен');
  }

  const toolsMod2 = await import('./agent/tools.js').catch(() => null);
  const oaTools = toolsMod2?.toolsForOpenAI
    ? toolsMod2.toolsForOpenAI(tools)
    : tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

  // Копируем messages — будем их пополнять tool-call/tool-result сообщениями
  const oaMessages = messages.map((m) => ({ role: m.role, content: m.content }));

  while (iterations < maxIters) {
    iterations += 1;
    const isGpt5 = isOpenAI && (/^gpt-5/i.test(cfg.model) || /^o[1-9]/.test(cfg.model));
    const params = {
      model: cfg.model,
      messages: oaMessages,
      tools: oaTools,
      tool_choice: 'auto',
    };
    if (isGpt5) params.max_completion_tokens = safeMaxTokens;
    else { params.max_tokens = isOpenRouter ? Math.min(safeMaxTokens, 32000) : safeMaxTokens; params.temperature = temperature; }

    const resp = await callApiWithTransportRetry(
      async () => {
        const { signal, cleanup } = makeTimeoutSignal(timeoutMs ?? SINGLE_CALL_TIMEOUT_MS);
        try {
          return await client.chat.completions.create(params, { signal });
        } finally { cleanup(); }
      },
      `${cfg.provider}:${cfg.model} iter#${iterations}`,
    );

    const u = resp.usage || {};
    usageAgg.input += u.prompt_tokens || 0;
    usageAgg.output += u.completion_tokens || 0;
    usageAgg.total += u.total_tokens || 0;

    const choice = resp.choices?.[0];
    if (!choice) break;
    finishReason = choice.finish_reason || null;
    const msg = choice.message || {};
    const text = msg.content || '';
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    if (text) {
      finalText += (finalText ? '\n' : '') + text;
      if (typeof onText === 'function') onText(text);
    }

    if (!toolCalls.length) break;

    // Пушим assistant-ответ с tool_calls в историю (требование протокола)
    oaMessages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls,
    });

    // Выполняем все tool-calls
    let finishedFromTool = null;
    for (const tc of toolCalls) {
      const name = tc.function?.name || tc.name || '';
      let parsedArgs = {};
      try {
        const raw = tc.function?.arguments || tc.arguments || '{}';
        parsedArgs = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        parsedArgs = {};
      }

      let result;
      try {
        result = await onToolCall(name, parsedArgs, tc.id);
      } catch (e) {
        result = { ok: false, error: e?.message || String(e) };
      }
      oaMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: typeof result === 'string' ? result : JSON.stringify(result).slice(0, 80_000),
      });
      if (result?.finished) finishedFromTool = result?.message || '';
    }

    if (finishedFromTool !== null) {
      return {
        text: finalText || finishedFromTool,
        usage: usageAgg,
        finishReason: 'finished',
        modelUsed: modelId,
        iterations,
      };
    }
  }

  return { text: finalText, usage: usageAgg, finishReason, modelUsed: modelId, iterations };
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
 * Обёртка для одного API-вызова провайдера с ретраем на TRANSPORT-ошибках
 * (network, timeout, 5xx, overloaded). Состояние диалога снаружи к этому моменту
 * консистентно, поэтому повторный вызов безопасен.
 *
 * Не ретраит: auth, quota, rate_limit (это про сервер, не про транспорт),
 * bad_request, content_filter, context_overflow.
 */
const TRANSPORT_RETRY_ATTEMPTS = 3;
const TRANSPORT_RETRY_BASE_MS = 1500;
async function callApiWithTransportRetry(fn, label) {
  let lastErr = null;
  for (let attempt = 1; attempt <= TRANSPORT_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const info = classifyLlmError(e);
      const isTransport = info.kind === 'network' || info.kind === 'timeout' || info.kind === 'overloaded';
      if (!isTransport || attempt === TRANSPORT_RETRY_ATTEMPTS) {
        throw e;
      }
      const delay = TRANSPORT_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`[transport-retry] ${label} attempt ${attempt}/${TRANSPORT_RETRY_ATTEMPTS} (${info.kind}): ${shortErrorLine(info)}. Wait ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
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

/** Поддерживает ли модель tool-calling в нашей реализации. */
export function modelSupportsTools(modelId) {
  if (!modelId) return false;
  if (modelId.startsWith('ollama:')) return false;
  if (modelId.startsWith('gemini:')) return false; // у Gemini у нас tools не реализованы
  return true;
}

/**
 * Построить цепочку фоллбеков ТОЛЬКО для моделей с поддержкой tool-calling.
 * Юзер-выбор идёт первым, дальше — платные модели из FALLBACK_PRIORITY.
 * Если у провайдера юзера сейчас «горит» в _providerStatus (свежая ошибка
 * auth/quota) — ставим его в конец списка, чтобы не упереться в него снова.
 */
export function buildToolsFallbackChain(primary) {
  const seen = new Set();
  const head = [];
  const tail = [];
  const status = getProviderStatus();
  const tryAdd = (id, prepend) => {
    if (!id || seen.has(id)) return;
    if (!modelSupportsTools(id)) return;
    const cfg = resolveModelConfig(id);
    if (!cfg) return;
    if (!isProviderConfigured(cfg.provider)) return;
    seen.add(id);
    const target = prepend ? head : tail;
    // Свежая ошибка квоты/авторизации — отправляем в конец очереди (не пропускаем
    // совсем, но не пробуем первым)
    const provStatus = status[cfg.provider];
    if (provStatus && (provStatus.kind === 'auth' || provStatus.kind === 'quota')) {
      // Тут «деградировано»: всё равно пушим, но в самый хвост
      tail.push(id);
      return;
    }
    target.push(id);
  };
  tryAdd(primary, true);
  for (const id of FALLBACK_PRIORITY) tryAdd(id, false);
  return [...head, ...tail];
}

/**
 * callModelWithTools + автоматический fallback на следующую модель из
 * tools-capable цепочки, если текущая упала ДО того, как успела вызвать
 * хотя бы один tool или сэмитить текст. Если уже что-то отдала наружу —
 * фоллбек запрещён (иначе результаты двух моделей перемешаются).
 *
 * На каждый «свежий» (без эффектов) вызов делаем PROVIDER_RETRY_ATTEMPTS
 * попыток с экспоненциальным backoff на retryable-ошибках, потом — следующая
 * модель.
 *
 * Возвращает результат `callModelWithTools` + `errors[]` накопленных по пути.
 * При полном провале бросает Error с .errors и .suggestedAlternatives.
 */
export async function callModelWithToolsAndFallback({
  modelId,
  messages,
  tools = [],
  onToolCall,
  onText,
  maxIters = 10,
  maxTokens,
  temperature = 0.3,
  timeoutMs,
  onProgress, // (info) => void; info = { kind:'fallback', from, to, reason }
}) {
  const chain = buildToolsFallbackChain(modelId);
  if (!chain.length) {
    const err = new Error('Нет tools-совместимых моделей в наличии. Подключите ключ Claude / OpenAI / xAI / OpenRouter (paid).');
    err.code = 'no_models';
    err.errors = [];
    throw err;
  }

  const errors = [];
  const skipProviders = new Set();

  for (let i = 0; i < chain.length; i++) {
    const id = chain[i];
    const cfg = resolveModelConfig(id);
    if (!cfg) continue;
    if (skipProviders.has(cfg.provider)) {
      errors.push({ model: id, kind: 'skipped_provider', provider: cfg.provider });
      continue;
    }

    // Защита: если МЫ уже эмитнули наружу tool/text для предыдущей модели,
    // фоллбек запрещён (этот флаг устанавливается ниже только при первой эмиссии).
    let hadOutput = false;
    const guardedOnText = typeof onText === 'function'
      ? (delta) => { if (delta) hadOutput = true; onText(delta); }
      : undefined;
    const guardedOnToolCall = typeof onToolCall === 'function'
      ? async (...a) => { hadOutput = true; return onToolCall(...a); }
      : onToolCall;

    let attempt = 0;
    let lastInfo = null;
    while (attempt < PROVIDER_RETRY_ATTEMPTS) {
      attempt += 1;
      try {
        const result = await callModelWithTools({
          modelId: id,
          messages,
          tools,
          onToolCall: guardedOnToolCall,
          onText: guardedOnText,
          maxIters,
          maxTokens,
          temperature,
          timeoutMs,
        });
        recordProviderOk(cfg.provider);
        return { ...result, modelUsed: id, fallbackFrom: i === 0 ? null : modelId, errors };
      } catch (e) {
        const info = classifyLlmError(e);
        lastInfo = info;
        recordProviderError(cfg.provider, info);
        errors.push({
          model: id,
          provider: cfg.provider,
          attempt,
          kind: info.kind,
          status: info.status,
          message: info.userMessage,
          raw: info.raw,
        });
        console.warn(`[fallback-tools] ${id} (try ${attempt}): ${shortErrorLine(info)}`);

        // hadOutput=true — модель уже сделала tool-call'ы (write_file, etc.).
        // Транспортные ретраи безопасно делает callApiWithTransportRetry внутри
        // callModelWithTools (там сохраняется state диалога между попытками).
        // На уровне обёртки повторять callModelWithTools нельзя — это бы
        // повторно выполнило все уже сделанные tool'ы. И фоллбек на другую
        // модель опасен — её ответ нельзя склеить с уже выполненной работой.
        // Пробрасываем streamPartial=true, чтобы UI показал «работа была
        // частично выполнена, можно открыть файлы, сделать Auto-fix».
        if (hadOutput) {
          const err = new Error(`Прервано: ${info.userMessage}`);
          err.code = info.kind;
          err.errors = errors;
          err.modelUsed = id;
          err.streamPartial = true;
          throw err;
        }

        if (info.skipProvider) {
          skipProviders.add(cfg.provider);
          break;
        }
        if (!info.retryable || attempt === PROVIDER_RETRY_ATTEMPTS) {
          break; // следующая модель
        }
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }
    void lastInfo;
    // Эмитим прогресс «переключаемся на следующую модель»
    if (i < chain.length - 1 && typeof onProgress === 'function') {
      onProgress({
        kind: 'fallback',
        from: id,
        to: chain[i + 1],
        reason: errors[errors.length - 1]?.kind || 'unknown',
      });
    }
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
  err.suggestedAlternatives = chain
    .filter((id) => !errors.some((e) => e.model === id && (e.kind === 'auth' || e.kind === 'quota')))
    .slice(0, 3)
    .map((id) => ({ id, label: resolveModelConfig(id)?.label || id }));
  throw err;
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
        recordProviderOk(cfg.provider);
        return { ...result, modelUsed: id, fallbackFrom: i === 0 ? null : modelId, errors };
      } catch (e) {
        const info = classifyLlmError(e);
        lastInfo = info;
        recordProviderError(cfg.provider, info);
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
