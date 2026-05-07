/**
 * Серверная логика выполнения узлов AI Media Studio.
 *
 * - Assistant — синхронно через callWithFallback.
 * - Image / Video / Upscale — асинхронно: создаём media_runs row, стартуем
 *   prediction на Replicate, фоном поллим до завершения и сохраняем файл
 *   в data/media/<projectId>/<runId>.<ext>.
 *
 * Фронт после стартового вызова поллит /api/media/runs/:id раз в 2 сек.
 */

import { callWithFallback } from '../llm.js';
import {
  createRun, updateRun, getRun, projectDir,
} from './store.js';
import {
  createPrediction, getPrediction, downloadOutput,
  aspectFromSize, guessExt, isReplicateConfigured, REPLICATE_MODELS,
} from './providers/replicate.js';
import { signMediaUrl } from './sign.js';
import { llmCostCents, replicateCostCents } from './pricing.js';
import { validateInput } from './catalog.js';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS_IMAGE   = 5 * 60 * 1000;   //  5 мин на image
const POLL_TIMEOUT_MS_VIDEO   = 15 * 60 * 1000;  // 15 мин на video (Kling/Veo долго)
const POLL_TIMEOUT_MS_UPSCALE = 10 * 60 * 1000;  // 10 мин на upscale

/* ===========================================================
   Assistant — синхронный текстовый узел через callWithFallback
   =========================================================== */

export async function runAssistantSync({ projectId, nodeId, prompt, context, model, maxTokens }) {
  const messages = [];
  if (prompt && String(prompt).trim()) {
    messages.push({ role: 'system', content: String(prompt) });
  } else {
    messages.push({
      role: 'system',
      content: 'Ты помощник в AI Media Studio. Отвечай кратко, по делу.',
    });
  }
  if (context && String(context).trim()) {
    messages.push({ role: 'user', content: String(context) });
  } else {
    messages.push({
      role: 'user',
      content: 'Напиши краткое креативное предложение по теме узла.',
    });
  }

  // Сразу заводим run в очередь — даже Assistant попадает в общий usage.
  // Если projectId/nodeId не пришли (например, прямой вызов из API без узла),
  // пропускаем учёт — это не нормальный кейс для Media Studio.
  const tStart = Date.now();
  let runId = null;
  if (projectId && nodeId) {
    const run = createRun({
      projectId, nodeId,
      kind: 'llm',
      provider: 'multi',
      model: model && model !== 'auto' ? model : 'auto',
      input: { prompt, context, maxTokens },
    });
    runId = run.id;
    updateRun(runId, { status: 'running' });
  }

  try {
    const result = await callWithFallback({
      modelId: model && model !== 'auto' ? model : undefined,
      messages,
      task: 'media-assistant',
      maxTokens: typeof maxTokens === 'number' ? maxTokens : 1500,
      temperature: 0.7,
      timeoutMs: 120_000,
    });
    const usage = result.usage || { input: 0, output: 0, total: 0 };
    const costCents = llmCostCents(result.modelUsed, usage);
    const durationMs = Date.now() - tStart;
    if (runId) {
      updateRun(runId, {
        status: 'done',
        // model проставляем по факту использованной модели (после fallback).
        // Для Assistant результат-ассет пока не сохраняем (текстовый узел).
        costCents: Math.round(costCents),
        resultMeta: {
          tokensIn:  usage.input  || 0,
          tokensOut: usage.output || 0,
          tokensTotal: usage.total || ((usage.input || 0) + (usage.output || 0)),
          durationMs,
          modelUsed: result.modelUsed,
          fallbackFrom: result.fallbackFrom || null,
        },
      });
    }
    return {
      text: result.text || '',
      modelUsed: result.modelUsed,
      fallbackFrom: result.fallbackFrom,
      usage,
      cost: { cents: costCents },
    };
  } catch (e) {
    if (runId) {
      updateRun(runId, {
        status: 'error',
        error: String(e?.message || e).slice(0, 500),
        resultMeta: { durationMs: Date.now() - tStart },
      });
    }
    throw e;
  }
}

/* ===========================================================
   Image generator — Replicate FLUX / SDXL / Recraft
   =========================================================== */

export async function startImageRun(projectId, nodeId, params) {
  if (!isReplicateConfigured()) {
    const err = new Error('REPLICATE_API_TOKEN не задан в .env. Не могу запустить генерацию.');
    err.code = 'no_replicate_key';
    throw err;
  }
  const modelId = params.model || 'flux-1.1-pro';
  const meta = REPLICATE_MODELS[modelId];
  if (!meta || meta.kind !== 'image') {
    throw new Error(`Неподдерживаемая image-модель: ${modelId}`);
  }
  if (!params.prompt || !String(params.prompt).trim()) {
    throw new Error('Пустой prompt — нечего генерировать.');
  }
  // Жёсткая валидация по каталогу — обязательные референсы, допустимые
  // aspect ratios. Бросает Error с понятным сообщением, если что-то не так.
  // Совместимость: старые проекты могли сохранить params.size = "1024x1024".
  const aspectIn = params.aspect || aspectFromSize(params.size || '1024x1024');
  params = validateInput('image', modelId, { ...params, aspect: aspectIn });

  const run = createRun({
    projectId, nodeId,
    kind: 'image',
    provider: 'replicate',
    model: modelId,
    input: params,
  });

  // Запускаем в фоне; ошибки помечают run как 'error' в БД.
  const tStartImg = Date.now();
  resolveImageRun(run.id, modelId, params).catch((e) => {
    console.error('[media/runner] image run failed', run.id, e);
    updateRun(run.id, {
      status: 'error',
      error: String(e?.message || e).slice(0, 500),
      resultMeta: { durationMs: Date.now() - tStartImg },
    });
  });

  return run;
}

async function resolveImageRun(runId, modelId, params) {
  updateRun(runId, { status: 'running' });
  // params уже прошёл validateInput → params.aspect совместим с моделью.
  const aspect = params.aspect || aspectFromSize(params.size || '1024x1024');
  const input = buildImageInput(modelId, params.prompt, aspect, params.referenceUrl);

  await runReplicatePrediction({
    runId, modelId, input,
    timeoutMs: POLL_TIMEOUT_MS_IMAGE,
    extFallback: 'png',
    timeoutMessage: 'Replicate timeout: генерация заняла больше 5 минут',
  });
}

/**
 * Универсальный исполнитель: создаёт prediction, поллит и сохраняет
 * первый файл из output в папку проекта. Используется image / video / upscale.
 */
async function runReplicatePrediction({ runId, modelId, input, timeoutMs, extFallback, timeoutMessage }) {
  const pred = await createPrediction(modelId, input);
  updateRun(runId, { externalId: pred.id });

  if (pred.status === 'succeeded') {
    await saveOutput(runId, pred, extFallback);
    return;
  }
  if (pred.status === 'failed' || pred.status === 'canceled') {
    throw new Error(pred.error || 'Replicate prediction failed');
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(POLL_INTERVAL_MS);
    const cur = await getPrediction(pred.id);
    if (cur.status === 'succeeded') {
      await saveOutput(runId, cur, extFallback);
      return;
    }
    if (cur.status === 'failed' || cur.status === 'canceled') {
      throw new Error(cur.error || 'Replicate prediction failed');
    }
  }
  throw new Error(timeoutMessage || 'Replicate timeout');
}

function buildImageInput(modelId, prompt, aspect, referenceUrl) {
  const input = { prompt };
  const refUrl = referenceUrl ? absoluteUrl(referenceUrl) : null;

  if (modelId === 'flux-1.1-pro' || modelId === 'flux-dev' || modelId === 'flux-1.1-pro-ultra') {
    input.aspect_ratio = aspect;
    input.output_format = 'png';
    input.output_quality = 90;
    input.safety_tolerance = 2;
    input.prompt_upsampling = false;
  } else if (modelId === 'flux-schnell') {
    input.aspect_ratio = aspect;
    input.output_format = 'webp';
    input.num_outputs = 1;
  } else if (modelId === 'flux-kontext-pro') {
    // img2img / контекстное редактирование: обязателен input_image
    input.aspect_ratio = aspect;
    input.output_format = 'png';
    if (refUrl) input.input_image = refUrl;
  } else if (modelId === 'sdxl') {
    const wh = sizeFromAspect(aspect);
    input.width = wh.w; input.height = wh.h;
  } else if (modelId === 'recraft-v3') {
    input.size = sizeFromAspectRecraft(aspect);
  } else if (modelId === 'ideogram-v3-turbo') {
    input.aspect_ratio = aspect;
    input.style_type = 'Auto';
  } else if (modelId === 'imagen-4') {
    input.aspect_ratio = aspect;
    input.output_format = 'png';
  } else if (modelId === 'seedream-4') {
    input.aspect_ratio = aspect;
    input.size = '2K';
  } else if (modelId === 'nano-banana') {
    // Gemini 2.5 Flash Image: можно подавать массив image_input для редактирования
    input.output_format = 'png';
    if (refUrl) input.image_input = [refUrl];
  }
  return input;
}

function sizeFromAspect(aspect) {
  const map = {
    '1:1':  { w: 1024, h: 1024 },
    '16:9': { w: 1344, h: 768  },
    '9:16': { w: 768,  h: 1344 },
    '3:2':  { w: 1216, h: 832  },
    '2:3':  { w: 832,  h: 1216 },
    '4:3':  { w: 1152, h: 896  },
    '3:4':  { w: 896,  h: 1152 },
  };
  return map[aspect] || map['1:1'];
}
function sizeFromAspectRecraft(aspect) {
  const map = {
    '1:1':  '1024x1024',
    '16:9': '1707x1024',
    '9:16': '1024x1707',
    '3:2':  '1536x1024',
    '2:3':  '1024x1536',
  };
  return map[aspect] || '1024x1024';
}

async function saveOutput(runId, pred, fallbackExt = 'png') {
  // Replicate возвращает либо строку, либо массив URL. Берём первый.
  const output = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  if (!output) throw new Error('Replicate вернул пустой output');

  const run = getRun(runId);
  const ext = guessExt(output, fallbackExt);
  const filename = `${runId}.${ext}`;
  const dir = projectDir(run.projectId);
  await downloadOutput(output, dir, filename);

  const localUrl = `/media-files/${run.projectId}/${filename}`;
  // Стоимость и длительность.
  const params = run.input || {};
  const costCents = replicateCostCents(run.model, params, pred.metrics || {});
  const predictMs = Math.round(((pred.metrics?.predict_time) || 0) * 1000);
  const durationMs = run.createdAt ? (Date.now() - run.createdAt) : predictMs;
  updateRun(runId, {
    status: 'done',
    resultUrl: localUrl,
    costCents: Math.round(costCents),
    resultMeta: {
      metrics: pred.metrics,
      originalUrl: output,
      durationMs,
      predictMs,
    },
  });
}

/* ===========================================================
   Video generator — Replicate Kling / Veo / Hunyuan
   =========================================================== */

export async function startVideoRun(projectId, nodeId, params) {
  if (!isReplicateConfigured()) {
    const err = new Error('REPLICATE_API_TOKEN не задан в .env. Не могу запустить генерацию видео.');
    err.code = 'no_replicate_key';
    throw err;
  }
  const modelId = params.model || 'kling-v2.5-turbo';
  const meta = REPLICATE_MODELS[modelId];
  if (!meta || meta.kind !== 'video') {
    throw new Error(`Неподдерживаемая video-модель: ${modelId}`);
  }
  const promptOk = params.prompt && String(params.prompt).trim();
  const refOk    = params.referenceUrl && String(params.referenceUrl).trim();
  if (!promptOk && !refOk) {
    throw new Error('Нужен либо prompt, либо стартовая картинка-референс.');
  }
  params = validateInput('video', modelId, params);

  const run = createRun({
    projectId, nodeId,
    kind: 'video',
    provider: 'replicate',
    model: modelId,
    input: params,
  });

  const tStartVid = Date.now();
  resolveVideoRun(run.id, modelId, params).catch((e) => {
    console.error('[media/runner] video run failed', run.id, e);
    updateRun(run.id, {
      status: 'error',
      error: String(e?.message || e).slice(0, 500),
      resultMeta: { durationMs: Date.now() - tStartVid },
    });
  });
  return run;
}

async function resolveVideoRun(runId, modelId, params) {
  updateRun(runId, { status: 'running' });
  const input = buildVideoInput(modelId, params);
  await runReplicatePrediction({
    runId, modelId, input,
    timeoutMs: POLL_TIMEOUT_MS_VIDEO,
    extFallback: 'mp4',
    timeoutMessage: 'Video timeout: генерация заняла больше 15 минут',
  });
}

function buildVideoInput(modelId, params) {
  const prompt = (params.prompt || '').trim();
  const ref = (params.referenceUrl || '').trim();
  const duration = Number(params.duration) || 5;
  const aspect = params.aspect || '16:9';
  const refUrl = ref ? absoluteUrl(ref) : null;

  if (modelId === 'kling-v2.5-turbo') {
    const input = { prompt, duration: clampDuration(duration, 5, 10) };
    if (refUrl) input.start_image = refUrl;
    input.aspect_ratio = mapAspectKling(aspect);
    return input;
  }
  if (modelId === 'kling-v1.6-pro') {
    const input = { prompt, duration: clampDuration(duration, 5, 10) };
    if (refUrl) input.start_image = refUrl;
    input.aspect_ratio = mapAspectKling(aspect);
    return input;
  }
  if (modelId === 'veo-3' || modelId === 'veo-3-fast') {
    const input = { prompt };
    if (refUrl) input.image = refUrl;
    if (params.aspect) input.aspect_ratio = aspect;
    return input;
  }
  if (modelId === 'hunyuan-video') {
    return { prompt, num_frames: duration <= 5 ? 65 : 129 };
  }
  if (modelId === 'wan-2.5-i2v-fast') {
    // image-to-video: image обязателен
    if (!refUrl) throw new Error('Wan 2.5 I2V Fast требует стартовое изображение.');
    return {
      image: refUrl,
      prompt,
      duration: clampDuration(duration, 5, 8),
    };
  }
  if (modelId === 'hailuo-02') {
    const input = { prompt, duration: clampDuration(duration, 6, 10) };
    if (refUrl) input.first_frame_image = refUrl;
    return input;
  }
  if (modelId === 'seedance-1-pro') {
    const input = { prompt, duration: clampDuration(duration, 5, 10), aspect_ratio: aspect };
    if (refUrl) input.image = refUrl;
    return input;
  }
  if (modelId === 'pixverse-v4.5') {
    const input = { prompt, duration: clampDuration(duration, 5, 8), aspect_ratio: aspect, quality: '720p' };
    if (refUrl) input.image = refUrl;
    return input;
  }
  return { prompt };
}

function clampDuration(v, min, max) {
  const n = Math.round(Number(v) || min);
  return Math.max(min, Math.min(max, n));
}

function mapAspectKling(a) {
  // Kling принимает только 16:9, 9:16, 1:1
  if (a === '9:16') return '9:16';
  if (a === '1:1')  return '1:1';
  return '16:9';
}

/**
 * Превращает наш внутренний путь /media-files/... или /media-uploads/...
 * в абсолютный URL с подписанным `?exp=…&sig=…` (TTL 1 час). Replicate-воркер
 * сможет скачать файл без сессии. Внешние URL (https://unsplash…) —
 * пропускаем как есть.
 *
 * Если пользователь вставил абсолютный URL, который указывает на наш домен
 * и наш приватный путь, тоже подписываем — иначе там тоже будет 403.
 */
function absoluteUrl(u) {
  if (!u) return u;
  const base = (process.env.PUBLIC_BASE_URL || 'https://botme.neeklo.ru').replace(/\/+$/, '');

  if (/^https?:\/\//i.test(u)) {
    try {
      const url = new URL(u);
      if (url.pathname.startsWith('/media-files/') || url.pathname.startsWith('/media-uploads/')) {
        return url.origin + signMediaUrl(url.pathname, 3600);
      }
    } catch { /* malformed — отдадим как есть */ }
    return u;
  }

  const localPath = u.startsWith('/') ? u : '/' + u;
  if (localPath.startsWith('/media-files/') || localPath.startsWith('/media-uploads/')) {
    return base + signMediaUrl(localPath, 3600);
  }
  return base + localPath;
}

/* ===========================================================
   Image upscaler — Replicate clarity-upscaler
   =========================================================== */

export async function startUpscaleRun(projectId, nodeId, params) {
  if (!isReplicateConfigured()) {
    const err = new Error('REPLICATE_API_TOKEN не задан в .env. Не могу запустить апскейл.');
    err.code = 'no_replicate_key';
    throw err;
  }
  const modelId = params.model || 'clarity-upscaler';
  const meta = REPLICATE_MODELS[modelId];
  if (!meta || meta.kind !== 'upscale') {
    throw new Error(`Неподдерживаемая upscale-модель: ${modelId}`);
  }
  const ref = (params.referenceUrl || params.imageUrl || '').trim();
  if (!ref) {
    throw new Error('Нужна исходная картинка: подключи Image / Upload / прикрепи референс.');
  }
  params = validateInput('upscale', modelId, { ...params, referenceUrl: ref });

  const run = createRun({
    projectId, nodeId,
    kind: 'upscale',
    provider: 'replicate',
    model: modelId,
    input: params,
  });
  const tStartUps = Date.now();
  resolveUpscaleRun(run.id, modelId, { ...params, referenceUrl: ref }).catch((e) => {
    console.error('[media/runner] upscale run failed', run.id, e);
    updateRun(run.id, {
      status: 'error',
      error: String(e?.message || e).slice(0, 500),
      resultMeta: { durationMs: Date.now() - tStartUps },
    });
  });
  return run;
}

async function resolveUpscaleRun(runId, modelId, params) {
  updateRun(runId, { status: 'running' });
  const scale = clampDuration(params.scale || 2, 2, 6);
  const refUrl = absoluteUrl(params.referenceUrl);

  let input;
  if (modelId === 'clarity-upscaler') {
    input = {
      image: refUrl,
      scale_factor: scale,
      creativity: typeof params.creativity === 'number' ? params.creativity : 0.35,
      resemblance: 0.6,
      dynamic: 6,
      sharpen: 0,
      handfix: 'disabled',
      output_format: 'png',
    };
  } else if (modelId === 'topaz-upscale') {
    input = {
      image: refUrl,
      upscale_factor: scale,
      output_format: 'png',
    };
  } else if (modelId === 'real-esrgan') {
    input = {
      image: refUrl,
      scale,
      face_enhance: false,
    };
  } else {
    input = { image: refUrl, scale_factor: scale };
  }

  await runReplicatePrediction({
    runId, modelId, input,
    timeoutMs: POLL_TIMEOUT_MS_UPSCALE,
    extFallback: 'png',
    timeoutMessage: 'Upscale timeout: апскейл занял больше 10 минут',
  });
}

/* ===========================================================
   Audio (TTS) — ElevenLabs
   =========================================================== */
import { isElevenLabsConfigured, synthesizeTTS, ELEVENLABS_VOICES } from './providers/elevenlabs.js';
import { ttsCostCents } from './pricing.js';

export async function startAudioRun(projectId, nodeId, params) {
  if (!isElevenLabsConfigured()) {
    const err = new Error('ELEVENLABS_API_KEY не задан в .env. Не могу синтезировать речь.');
    err.code = 'no_elevenlabs_key';
    throw err;
  }
  const text = String(params.text || '').trim();
  if (!text) throw new Error('Пустой текст — нечего озвучивать.');

  // Голос по умолчанию — Rachel; модель — multilingual_v2.
  const voiceId = params.voiceId || params.voice || ELEVENLABS_VOICES[0].id;
  const modelId = params.model || 'eleven_multilingual_v2';

  const run = createRun({
    projectId, nodeId,
    kind: 'audio',
    provider: 'elevenlabs',
    model: modelId,
    input: { ...params, text, voiceId, model: modelId },
  });

  const tStart = Date.now();
  resolveAudioRun(run.id, { text, voiceId, modelId, projectId }).catch((e) => {
    console.error('[media/runner] audio run failed', run.id, e);
    updateRun(run.id, {
      status: 'error',
      error: String(e?.message || e).slice(0, 500),
      resultMeta: { durationMs: Date.now() - tStart },
    });
  });
  return run;
}

async function resolveAudioRun(runId, { text, voiceId, modelId, projectId }) {
  updateRun(runId, { status: 'running' });
  const tStart = Date.now();
  const filename = `${runId}.mp3`;
  const dir = projectDir(projectId);

  const out = await synthesizeTTS({
    text, voiceId, modelId,
    outputDir: dir, filename,
  });

  const localUrl = `/media-files/${projectId}/${filename}`;
  const costCents = ttsCostCents(modelId, out.charsBilled);
  const durationMs = Date.now() - tStart;
  updateRun(runId, {
    status: 'done',
    resultUrl: localUrl,
    costCents: Math.round(costCents),
    resultMeta: {
      durationMs,
      bytes: out.bytes,
      voiceId,
      model: modelId,
      // tokensIn/tokensOut здесь = symbol-bills (для consistency в Usage UI).
      tokensIn: out.charsBilled,
      tokensOut: 0,
    },
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
