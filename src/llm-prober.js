// Live-проба провайдеров LLM. Делает короткий ping каждого настроенного
// ключа и кэширует результат на PROBE_TTL_MS.
//
// Используется в /api/provider-status и в UI-баннере для ясного объяснения
// «почему модель X не работает».

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { classifyLlmError } from './llm-errors.js';

const PROBE_TTL_MS = 5 * 60 * 1000;   // 5 минут
const PROBE_TIMEOUT_MS = 12_000;
const PING_MAX_TOKENS = 8;
const TINY = [{ role: 'user', content: 'ping' }];

let _cache = null; // { ts, results: { [provider]: ProbeResult } }
let _inflight = null;

/**
 * @typedef {Object} ProbeResult
 * @property {boolean} ok
 * @property {string|null} kind            // 'auth' | 'quota' | 'rate_limit' | ...
 * @property {number|null} status
 * @property {string} message              // короткое объяснение
 * @property {string} raw                  // оригинальный текст ошибки (обрезанный)
 * @property {number} latencyMs
 * @property {string} keyPreview           // 'sk-…ABCD'
 * @property {string|null} model           // на чём пинговали
 */

function previewKey(k) {
  if (!k) return '';
  if (k.length <= 12) return k;
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

async function withTimeout(promise, ms, label) {
  let to;
  const timeoutPromise = new Promise((_, reject) => {
    to = setTimeout(() => {
      const err = new Error(`probe timeout (${label})`);
      err._botmeTimeout = true;
      err.name = 'AbortError';
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(to);
  }
}

async function probeOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const t0 = Date.now();
  try {
    const c = new OpenAI({ apiKey: key, maxRetries: 0, timeout: PROBE_TIMEOUT_MS });
    await withTimeout(c.chat.completions.create({ model: 'gpt-4o-mini', messages: TINY, max_tokens: PING_MAX_TOKENS }), PROBE_TIMEOUT_MS, 'openai');
    return makeOk('gpt-4o-mini', t0, key);
  } catch (e) {
    return makeErr(e, 'gpt-4o-mini', t0, key);
  }
}

async function probeAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const t0 = Date.now();
  try {
    const c = new Anthropic({ apiKey: key, maxRetries: 0, timeout: PROBE_TIMEOUT_MS });
    await withTimeout(c.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: PING_MAX_TOKENS,
      messages: TINY,
    }), PROBE_TIMEOUT_MS, 'claude');
    return makeOk('claude-haiku-4-5-20251001', t0, key);
  } catch (e) {
    return makeErr(e, 'claude-haiku-4-5-20251001', t0, key);
  }
}

async function probeGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const t0 = Date.now();
  try {
    const c = new GoogleGenerativeAI(key);
    const model = c.getGenerativeModel({ model: 'gemini-2.5-flash' });
    await withTimeout(model.generateContent('ping'), PROBE_TIMEOUT_MS, 'gemini');
    return makeOk('gemini-2.5-flash', t0, key);
  } catch (e) {
    return makeErr(e, 'gemini-2.5-flash', t0, key);
  }
}

async function probeXai() {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) return null;
  const t0 = Date.now();
  try {
    const c = new OpenAI({
      apiKey: key,
      baseURL: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
      maxRetries: 0,
      timeout: PROBE_TIMEOUT_MS,
    });
    await withTimeout(c.chat.completions.create({ model: 'grok-4-fast', messages: TINY, max_tokens: PING_MAX_TOKENS }), PROBE_TIMEOUT_MS, 'xai');
    return makeOk('grok-4-fast', t0, key);
  } catch (e) {
    return makeErr(e, 'grok-4-fast', t0, key);
  }
}

async function probeOpenRouter() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const t0 = Date.now();
  try {
    // Проверяем баланс через /key — это и тест auth, и сразу инфа по балансу
    const r = await withTimeout(fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
    }), PROBE_TIMEOUT_MS, 'openrouter');
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      const e = new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
      e.status = r.status;
      throw e;
    }
    const j = await r.json();
    const d = j.data || j;
    const usage = typeof d.usage === 'number' ? d.usage : null;
    const limitRemaining = d.limit_remaining;
    const balance = limitRemaining != null ? `остаток $${Number(limitRemaining).toFixed(2)}` : (usage != null ? `использовано $${usage.toFixed(2)}` : null);
    return {
      ok: true,
      kind: null,
      status: 200,
      message: balance ? `OK · ${balance}` : 'OK',
      raw: '',
      latencyMs: Date.now() - t0,
      keyPreview: previewKey(key),
      model: '/key',
      meta: { usage, limit: d.limit, limit_remaining: limitRemaining, is_free_tier: d.is_free_tier },
    };
  } catch (e) {
    return makeErr(e, '/key', t0, key);
  }
}

function makeOk(model, t0, key) {
  return {
    ok: true,
    kind: null,
    status: 200,
    message: 'OK',
    raw: '',
    latencyMs: Date.now() - t0,
    keyPreview: previewKey(key),
    model,
  };
}

function makeErr(e, model, t0, key) {
  const info = classifyLlmError(e);
  return {
    ok: false,
    kind: info.kind,
    status: info.status || null,
    message: info.userMessage,
    raw: info.raw,
    latencyMs: Date.now() - t0,
    keyPreview: previewKey(key),
    model,
  };
}

/**
 * Запускает пробу всех провайдеров параллельно. Кэширует на PROBE_TTL_MS.
 * @param {Object} [opts]
 * @param {boolean} [opts.force] - игнорировать кэш
 * @returns {Promise<{ts:number, results:Object<string,ProbeResult|null>}>}
 */
export async function probeAllProviders({ force = false } = {}) {
  if (!force && _cache && Date.now() - _cache.ts < PROBE_TTL_MS) return _cache;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const [openai, claude, gemini, xai, openrouter] = await Promise.all([
      probeOpenAI(), probeAnthropic(), probeGemini(), probeXai(), probeOpenRouter(),
    ]);
    const results = { openai, claude, gemini, xai, openrouter };
    _cache = { ts: Date.now(), results };
    return _cache;
  })();
  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
}

/** Быстрый снимок без новой пробы (если кэш есть). null = ещё не пробовали. */
export function getCachedProbe() {
  return _cache;
}
