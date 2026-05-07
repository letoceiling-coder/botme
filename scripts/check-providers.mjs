#!/usr/bin/env node
// Диагностика всех LLM-провайдеров: ping минимальным запросом, классификация ошибки.
// Использование на VPS: cd /var/www/botme && node scripts/check-providers.mjs
//
// Покрывает: OpenAI, Anthropic (Claude), Google Gemini, xAI (Grok), OpenRouter,
// Ollama (по желанию). Для каждого ключа:
//  1. /models или эквивалент (auth-проверка),
//  2. tiny chat-completion (баланс/квота, content-filter, rate-limit).
//
// Выводит markdown-таблицу + сводку (OK / FAIL / NO_KEY).

import 'dotenv/config';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { classifyLlmError, shortErrorLine } from '../src/llm-errors.js';

const TIMEOUT_MS = 25_000;
const TINY_PING = [{ role: 'user', content: 'ping' }];
const PING_MAX_TOKENS = 8;

function box(title) {
  console.log('\n' + '═'.repeat(60));
  console.log(` ${title}`);
  console.log('═'.repeat(60));
}

function row(label, ok, detail) {
  const marker = ok === null ? '⚪' : ok ? '✅' : '❌';
  const tail = detail ? ` — ${detail}` : '';
  console.log(`  ${marker}  ${label.padEnd(36)}${tail}`);
}

const summary = [];

function record(provider, key, kind, ok, detail) {
  summary.push({ provider, key, kind, ok, detail });
}

async function ping(provider, key, kind, fn) {
  const t0 = Date.now();
  try {
    const res = await fn();
    const ms = Date.now() - t0;
    row(`${provider} · ${kind}`, true, `${ms}ms${res ? ' · ' + res : ''}`);
    record(provider, key, kind, true, `${ms}ms`);
    return true;
  } catch (e) {
    const ms = Date.now() - t0;
    const info = classifyLlmError(e);
    const detail = `${info.kind}${info.status ? '/' + info.status : ''} (${ms}ms) — ${(info.raw || '').slice(0, 200)}`;
    row(`${provider} · ${kind}`, false, detail);
    record(provider, key, kind, false, detail);
    return false;
  }
}

// =========================================================================
// OpenAI
// =========================================================================
async function checkOpenAI() {
  box('OpenAI (OPENAI_API_KEY)');
  const key = process.env.OPENAI_API_KEY;
  if (!key) { row('OpenAI', null, 'NO_KEY: OPENAI_API_KEY не задан'); record('openai', null, 'noKey', null, 'NO_KEY'); return; }
  console.log(`  ключ: ${key.slice(0, 8)}…${key.slice(-4)} (${key.length} символов)`);

  const client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: TIMEOUT_MS });
  await ping('openai', key, 'list models', async () => {
    const r = await client.models.list();
    const ids = (r.data || []).map((m) => m.id);
    return `${ids.length} моделей (есть gpt-4o: ${ids.includes('gpt-4o')}, gpt-4.1-mini: ${ids.includes('gpt-4.1-mini')})`;
  });

  for (const m of ['gpt-4o', 'gpt-4.1-mini']) {
    await ping('openai', key, `chat ${m}`, async () => {
      const r = await client.chat.completions.create({ model: m, messages: TINY_PING, max_tokens: PING_MAX_TOKENS });
      return `tokens: ${r.usage?.total_tokens || '?'}`;
    });
  }
}

// =========================================================================
// Anthropic
// =========================================================================
async function checkAnthropic() {
  box('Anthropic (ANTHROPIC_API_KEY)');
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { row('Anthropic', null, 'NO_KEY'); record('claude', null, 'noKey', null, 'NO_KEY'); return; }
  console.log(`  ключ: ${key.slice(0, 12)}…${key.slice(-4)} (${key.length} символов)`);

  const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: TIMEOUT_MS });
  for (const m of ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929']) {
    await ping('claude', key, `messages ${m}`, async () => {
      const r = await client.messages.create({
        model: m,
        max_tokens: PING_MAX_TOKENS,
        messages: TINY_PING,
      });
      return `tokens: in=${r.usage?.input_tokens || 0}, out=${r.usage?.output_tokens || 0}`;
    });
  }
}

// =========================================================================
// Gemini
// =========================================================================
async function checkGemini() {
  box('Google Gemini (GEMINI_API_KEY)');
  const key = process.env.GEMINI_API_KEY;
  if (!key) { row('Gemini', null, 'NO_KEY'); record('gemini', null, 'noKey', null, 'NO_KEY'); return; }
  console.log(`  ключ: ${key.slice(0, 8)}…${key.slice(-4)} (${key.length} символов)`);

  const client = new GoogleGenerativeAI(key);
  for (const m of ['gemini-2.5-flash', 'gemini-2.0-flash']) {
    await ping('gemini', key, `generate ${m}`, async () => {
      const model = client.getGenerativeModel({ model: m });
      const r = await model.generateContent('ping');
      return `text: "${(r.response?.text() || '').slice(0, 30)}"`;
    });
  }
}

// =========================================================================
// xAI (Grok)
// =========================================================================
async function checkXai() {
  box('xAI Grok (XAI_API_KEY / GROK_API_KEY)');
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) { row('xAI', null, 'NO_KEY'); record('xai', null, 'noKey', null, 'NO_KEY'); return; }
  console.log(`  ключ: ${key.slice(0, 8)}…${key.slice(-4)} (${key.length} символов)`);

  const client = new OpenAI({
    apiKey: key,
    baseURL: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
    maxRetries: 0,
    timeout: TIMEOUT_MS,
  });

  for (const m of ['grok-4-fast', 'grok-code-fast-1']) {
    await ping('xai', key, `chat ${m}`, async () => {
      const r = await client.chat.completions.create({ model: m, messages: TINY_PING, max_tokens: PING_MAX_TOKENS });
      return `tokens: ${r.usage?.total_tokens || '?'}`;
    });
  }
}

// =========================================================================
// OpenRouter
// =========================================================================
async function checkOpenRouter() {
  box('OpenRouter (OPENROUTER_API_KEY)');
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { row('OpenRouter', null, 'NO_KEY'); record('openrouter', null, 'noKey', null, 'NO_KEY'); return; }
  console.log(`  ключ: ${key.slice(0, 8)}…${key.slice(-4)} (${key.length} символов)`);

  // 1) /key info — баланс
  await ping('openrouter', key, '/key (баланс)', async () => {
    const r = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) {
      const txt = await r.text();
      const e = new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
      e.status = r.status;
      throw e;
    }
    const j = await r.json();
    const d = j.data || j;
    const usage = typeof d.usage === 'number' ? `usage=${d.usage.toFixed(4)}` : '';
    const limit = d.limit != null ? `limit=${d.limit}` : 'limit=∞';
    const remaining = d.limit_remaining != null ? `remaining=${d.limit_remaining}` : '';
    const free = d.is_free_tier ? ' · free-tier' : '';
    return [usage, limit, remaining].filter(Boolean).join(' · ') + free;
  });

  // 2) tiny chat — несколько моделей
  const client = new OpenAI({
    apiKey: key,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'https://botme.neeklo.ru',
      'X-Title': process.env.OPENROUTER_APP_TITLE || 'Botme',
    },
    maxRetries: 0,
    timeout: TIMEOUT_MS,
  });

  for (const m of [
    'qwen/qwen3-coder:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'anthropic/claude-sonnet-4',
    'openai/gpt-4o-mini',
  ]) {
    await ping('openrouter', key, `chat ${m}`, async () => {
      const r = await client.chat.completions.create({ model: m, messages: TINY_PING, max_tokens: PING_MAX_TOKENS });
      return `tokens: ${r.usage?.total_tokens || '?'}`;
    });
  }
}

// =========================================================================
// Главная
// =========================================================================
async function main() {
  console.log(`Проверка LLM-провайдеров. Время: ${new Date().toISOString()}`);
  console.log(`Node: ${process.version}, ENV: NODE_ENV=${process.env.NODE_ENV || 'dev'}`);

  await checkOpenAI();
  await checkAnthropic();
  await checkGemini();
  await checkXai();
  await checkOpenRouter();

  box('СВОДКА');
  const byProvider = new Map();
  for (const r of summary) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, { ok: 0, fail: 0, noKey: 0, fails: [] });
    const b = byProvider.get(r.provider);
    if (r.ok === null) b.noKey += 1;
    else if (r.ok) b.ok += 1;
    else { b.fail += 1; b.fails.push(`${r.kind}: ${r.detail}`); }
  }
  for (const [prov, b] of byProvider) {
    const verdict = b.noKey ? '⚪ NO_KEY' : b.fail === 0 ? '✅ OK' : b.ok === 0 ? '❌ ALL FAIL' : '⚠ PARTIAL';
    console.log(`  ${prov.padEnd(12)} ${verdict.padEnd(12)} ok=${b.ok} fail=${b.fail}`);
    for (const f of b.fails.slice(0, 4)) console.log(`     · ${f}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
