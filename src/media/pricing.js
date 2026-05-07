/**
 * Прайс-лист моделей и оценка стоимости одного run-а.
 *
 * ⚠ Цены — снимок на момент написания (май 2026). При изменении тарифов
 * провайдеров обновлять здесь же. Все суммы — в US центах с дробной частью
 * (Number, не Integer), чтобы не терять копейки на дешёвых моделях типа
 * Flux Schnell ($0.003 = 0.3¢).
 *
 * Используется в runner.js: после успешного завершения run-а вычисляем
 * стоимость и записываем в media_runs.cost_cents.
 *
 * Источники:
 *   Replicate billing  → https://replicate.com/pricing
 *   OpenAI pricing     → https://openai.com/api/pricing
 *   Anthropic pricing  → https://www.anthropic.com/pricing#anthropic-api
 *   Google Gemini      → https://ai.google.dev/pricing
 */

/* ============= LLM (per 1M tokens) ============= */
// Цены даны как [input USD/1M, output USD/1M].
const LLM_PRICING_USD_PER_M = {
  // OpenAI
  'gpt-4o':            [2.50, 10.00],
  'gpt-4.1-mini':      [0.15,  0.60],
  'gpt-5.4':           [3.00, 15.00],
  'gpt-5.4-mini':      [0.40,  1.60],
  'gpt-5.1-codex':     [3.00, 12.00],
  // Anthropic
  'claude-haiku-4-5-20251001':  [1.00,  5.00],
  'claude-sonnet-4-5-20250929': [3.00, 15.00],
  'claude-sonnet-4-6':          [3.00, 15.00],
  'claude-opus-4-7':            [15.00, 75.00],
  // Google
  'gemini-2.0-flash':  [0.075, 0.30],
  'gemini-2.5-flash':  [0.075, 0.30],
  'gemini-2.5-pro':    [2.50, 10.00],
  // xAI (Grok)
  'grok-4':            [3.00, 15.00],
  'grok-4-fast':       [0.20,  0.50],
  'grok-3':            [3.00, 15.00],
  'grok-3-mini':       [0.30,  0.50],
  'grok-code-fast-1':  [0.20,  1.50],
  // Ollama (self-hosted)
  'qwen2.5-coder:7b':  [0, 0],
  'llama3:latest':     [0, 0],
};

/* ============= Replicate (fixed per-result, USD) =============
   Для большинства image/video моделей Replicate берёт фиксированную цену за
   результат. Для остальных — pay-per-second; для них fallback по нашим
   эмпирическим данным (predict_time из metrics учтём отдельно ниже). */
const REPLICATE_FIXED_USD = {
  // ===== Image =====
  'flux-1.1-pro':         0.040,
  'flux-1.1-pro-ultra':   0.060,
  'flux-dev':             0.025,
  'flux-schnell':         0.003,
  'flux-kontext-pro':     0.040,   // img2img / редактирование
  'sdxl':                 0.0035,
  'recraft-v3':           0.040,
  'ideogram-v3-turbo':    0.030,
  'imagen-4':             0.040,   // Google
  'seedream-4':           0.030,   // ByteDance
  'nano-banana':          0.039,   // gemini-2.5-flash-image
  // ===== Video =====
  'kling-v2.5-turbo':     0.350,   // ~$0.07/s × 5s
  'kling-v1.6-pro':       0.250,
  'veo-3':                0.750,   // ~8s, премиум
  'veo-3-fast':           0.400,
  'hunyuan-video':        0.150,
  'wan-2.5-i2v-fast':     0.180,   // image-to-video, быстрая
  'hailuo-02':            0.270,   // MiniMax
  'seedance-1-pro':       0.300,   // ByteDance, image-to-video
  'pixverse-v4.5':        0.200,
  // ===== Upscale =====
  'clarity-upscaler':     0.050,   // ~$0.014/s GPU × ~3.5s
  'topaz-upscale':        0.090,   // высокое качество
  'real-esrgan':          0.012,   // дешёвый baseline
};

/** Стоимость LLM-генерации в USD центах. usage = { input, output, total }. */
export function llmCostCents(modelId, usage) {
  if (!modelId || !usage) return 0;
  const pure = stripPrefix(modelId);
  const p = LLM_PRICING_USD_PER_M[pure];
  if (!p) return 0;
  const input  = Number(usage.input)  || 0;
  const output = Number(usage.output) || 0;
  const usd = (input * p[0] + output * p[1]) / 1_000_000;
  return usd * 100; // в центах
}

/* ============= ElevenLabs TTS (USD per 1 character) =============
   Цены с учётом тарифа Pro (~$0.30 / 1K chars на multilingual_v2,
   ~$0.15 / 1K chars на turbo/flash). Если у тебя другой тариф —
   правь только эти цифры. */
const ELEVENLABS_USD_PER_CHAR = {
  'eleven_multilingual_v2': 0.00030,
  'eleven_turbo_v2_5':      0.00015,
  'eleven_flash_v2_5':      0.00010,
};

/** Стоимость TTS в USD центах. */
export function ttsCostCents(modelId, chars) {
  const rate = ELEVENLABS_USD_PER_CHAR[modelId] ?? ELEVENLABS_USD_PER_CHAR['eleven_multilingual_v2'];
  const usd = (Number(chars) || 0) * rate;
  return usd * 100;
}

/** Стоимость Replicate-генерации в USD центах с учётом длительности видео. */
export function replicateCostCents(modelId, params = {}, metrics = {}) {
  const fixed = REPLICATE_FIXED_USD[modelId];
  if (typeof fixed !== 'number') return 0;
  let usd = fixed;
  // Для видео-моделей умножаем на длительность относительно базовой 5 с.
  if (modelId === 'kling-v2.5-turbo' || modelId === 'kling-v1.6-pro') {
    const d = Number(params.duration) || 5;
    usd = (fixed / 5) * d;
  } else if (modelId === 'wan-2.5-i2v-fast' || modelId === 'pixverse-v4.5'
          || modelId === 'hailuo-02' || modelId === 'seedance-1-pro') {
    const d = Number(params.duration) || 5;
    usd = (fixed / 5) * d;
  } else if (modelId === 'veo-3-fast' || modelId === 'veo-3') {
    const d = Number(params.duration) || 8;
    usd = (fixed / 8) * d;
  }
  return usd * 100;
}

function stripPrefix(modelId) {
  const idx = modelId.indexOf(':');
  if (idx < 0) return modelId;
  // openai:gpt-4o → gpt-4o; ollama:qwen2.5-coder:7b → qwen2.5-coder:7b
  return modelId.slice(idx + 1);
}

/** Человекочитаемая строка типа "$0.04" — для UI. */
export function formatUsd(cents) {
  const usd = (Number(cents) || 0) / 100;
  if (usd < 0.01) return '<$0.01';
  if (usd < 1)   return '$' + usd.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return '$' + usd.toFixed(2);
}
