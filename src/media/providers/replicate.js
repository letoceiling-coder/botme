/**
 * Минимальный клиент Replicate API для AI Media Studio.
 *
 * Документация: https://replicate.com/docs/reference/http
 *
 * Используем endpoint `models/{owner}/{name}/predictions`, чтобы не
 * зависеть от конкретного version-id (Replicate сам подставит latest).
 *
 * Polling делается на стороне runner-а (см. ../runner.js).
 */

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

const BASE = 'https://api.replicate.com/v1';

/**
 * Регистр моделей: внутреннее имя → owner/name на Replicate + краткое описание
 * для UI-селектора. Поле `label` — то, что показываем пользователю в дропдауне.
 *
 * Чтобы добавить новую модель:
 *   1) Сюда добавить запись { owner, name, kind, label }.
 *   2) Если требуется специфичный input — расширить buildImageInput / buildVideoInput
 *      в src/media/runner.js (там идут «if model === ...» ветки).
 *   3) Добавить цену в src/media/pricing.js → REPLICATE_FIXED_USD.
 *   4) Добавить опцию в селектор в public/media/nodes.js (NODE_TYPES.image/video/upscale).
 */
export const REPLICATE_MODELS = {
  // ====== Image generators ======
  'flux-1.1-pro':       { owner: 'black-forest-labs', name: 'flux-1.1-pro',       kind: 'image', label: 'FLUX 1.1 Pro' },
  'flux-1.1-pro-ultra': { owner: 'black-forest-labs', name: 'flux-1.1-pro-ultra', kind: 'image', label: 'FLUX 1.1 Pro Ultra' },
  'flux-schnell':       { owner: 'black-forest-labs', name: 'flux-schnell',       kind: 'image', label: 'FLUX Schnell — самая быстрая' },
  'flux-dev':           { owner: 'black-forest-labs', name: 'flux-dev',           kind: 'image', label: 'FLUX Dev' },
  'flux-kontext-pro':   { owner: 'black-forest-labs', name: 'flux-kontext-pro',   kind: 'image', label: 'FLUX Kontext Pro — img2img/edit' },
  'sdxl':               { owner: 'stability-ai',      name: 'sdxl',               kind: 'image', label: 'SDXL' },
  'recraft-v3':         { owner: 'recraft-ai',        name: 'recraft-v3',         kind: 'image', label: 'Recraft v3 — иллюстрации/SVG' },
  'ideogram-v3-turbo':  { owner: 'ideogram-ai',       name: 'ideogram-v3-turbo',  kind: 'image', label: 'Ideogram v3 Turbo — текст в картинке' },
  'imagen-4':           { owner: 'google',            name: 'imagen-4',           kind: 'image', label: 'Google Imagen 4' },
  'seedream-4':         { owner: 'bytedance',         name: 'seedream-4',         kind: 'image', label: 'Seedream 4 — ByteDance' },
  'nano-banana':        { owner: 'google',            name: 'nano-banana',        kind: 'image', label: 'Nano Banana — Gemini 2.5 Flash Image' },

  // ====== Video generators ======
  'kling-v2.5-turbo':   { owner: 'kwaivgi',           name: 'kling-v2.5-turbo-pro', kind: 'video', label: 'Kling 2.5 Turbo' },
  'kling-v1.6-pro':     { owner: 'kwaivgi',           name: 'kling-v1.6-pro',       kind: 'video', label: 'Kling 1.6 Pro' },
  'veo-3':              { owner: 'google',            name: 'veo-3',                kind: 'video', label: 'Google Veo 3' },
  'veo-3-fast':         { owner: 'google',            name: 'veo-3-fast',           kind: 'video', label: 'Google Veo 3 Fast' },
  'hunyuan-video':      { owner: 'tencent',           name: 'hunyuan-video',        kind: 'video', label: 'Hunyuan Video — text2video' },
  'wan-2.5-i2v-fast':   { owner: 'wavespeedai',       name: 'wan-2.5-i2v-fast',     kind: 'video', label: 'Wan 2.5 I2V Fast — image2video' },
  'hailuo-02':          { owner: 'minimax',           name: 'hailuo-02',            kind: 'video', label: 'Hailuo-02 — MiniMax' },
  'seedance-1-pro':     { owner: 'bytedance',         name: 'seedance-1-pro',       kind: 'video', label: 'Seedance 1 Pro — ByteDance' },
  'pixverse-v4.5':      { owner: 'pixverse',          name: 'pixverse-v4.5',        kind: 'video', label: 'PixVerse v4.5' },

  // ====== Upscaler ======
  'clarity-upscaler':   { owner: 'philz1337x',        name: 'clarity-upscaler',     kind: 'upscale', label: 'Clarity Upscaler — Magnific-style' },
  'topaz-upscale':      { owner: 'topazlabs',         name: 'image-upscale',        kind: 'upscale', label: 'Topaz Image Upscale — премиум' },
  'real-esrgan':        { owner: 'nightmareai',       name: 'real-esrgan',          kind: 'upscale', label: 'Real-ESRGAN — экономный' },
};

function key() {
  return (process.env.REPLICATE_API_TOKEN || '').trim();
}

export function isReplicateConfigured() {
  return !!key();
}

/** Стартует prediction. Возвращает объект Replicate {id, status, urls, ...}. */
export async function createPrediction(modelId, input) {
  const m = REPLICATE_MODELS[modelId];
  if (!m) throw new Error(`Unknown Replicate model: ${modelId}`);
  if (!key()) throw new Error('REPLICATE_API_TOKEN не задан в .env');

  const url = `${BASE}/models/${m.owner}/${m.name}/predictions`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key()}`,
      'Content-Type': 'application/json',
      // Prefer: wait дает короткий sync-режим (до 60 сек на самой Replicate),
      // если модель быстрая — мы получим готовый результат без polling.
      'Prefer': 'wait=10',
    },
    body: JSON.stringify({ input }),
  });
  if (!r.ok) {
    const txt = await r.text();
    const err = new Error(`Replicate ${r.status}: ${txt.slice(0, 500)}`);
    err.status = r.status;
    err.body = txt;
    throw err;
  }
  return r.json();
}

/** Получить актуальный статус prediction по id. */
export async function getPrediction(id) {
  const r = await fetch(`${BASE}/predictions/${id}`, {
    headers: { 'Authorization': `Bearer ${key()}` },
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Replicate ${r.status}: ${txt.slice(0, 300)}`);
  }
  return r.json();
}

/** Скачать результат во внутреннюю папку проекта. */
export async function downloadOutput(url, dir, filename) {
  fs.mkdirSync(dir, { recursive: true });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Не удалось скачать ${url}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const full = path.join(dir, filename);
  fs.writeFileSync(full, buf);
  return full;
}

/** Преобразовать "1024x1024" → "1:1", "1792x1024" → "16:9" и т.п. */
export function aspectFromSize(size) {
  const [w, h] = String(size || '').split('x').map(Number);
  if (!w || !h) return '1:1';
  const r = w / h;
  const candidates = [
    ['1:1', 1], ['16:9', 16/9], ['9:16', 9/16],
    ['3:2', 3/2], ['2:3', 2/3], ['4:3', 4/3], ['3:4', 3/4],
    ['4:5', 4/5], ['5:4', 5/4], ['21:9', 21/9],
  ];
  let best = candidates[0];
  let bestDiff = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c[1] - r);
    if (d < bestDiff) { bestDiff = d; best = c; }
  }
  return best[0];
}

/** Угадать расширение файла по mime/URL Replicate. */
export function guessExt(url, fallback = 'png') {
  const m = String(url).match(/\.(png|jpg|jpeg|webp|mp4|mov|gif|wav|mp3)(?:\?|$)/i);
  return m ? m[1].toLowerCase() : fallback;
}
