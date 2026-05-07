/**
 * Клиентский раннер узлов AI Media Studio.
 *
 * Отвечает за:
 *  - сбор контекста (значений) из узлов, подключённых к текущему через edges;
 *  - вызов соответствующего серверного эндпоинта;
 *  - управление runtime-состоянием узла (idle / running / done / error)
 *    и перерисовкой узла при смене состояния;
 *  - polling для длинных операций (image / video / upscale / audio).
 *
 * Используется из canvas.js: см. runNode().
 */

import { api } from './api.js';
import { NODE_TYPES } from './nodes.js';

const POLL_INTERVAL = 2000;

/* ============================================================
   Сбор входных данных по edges
   ============================================================ */

/** Извлекает «полезное значение» из узла, готовое для передачи дальше. */
export function valueOf(node) {
  if (!node) return '';
  switch (node.kind) {
    case 'text':      return node.data.content || '';
    case 'list':      return node.data.items   || '';
    case 'assistant': return node.data.result  || '';
    case 'image':
    case 'upload':
    case 'stock':
    case 'upscale':   return node.data.resultUrl || '';
    case 'audio':
    case 'video':     return node.data.resultUrl || '';
  }
  return '';
}

/** Собрать входы текущего узла по edges (объект portId → string). */
export function collectInputs(node, state) {
  const def = NODE_TYPES[node.kind];
  const out = {};
  if (!def) return out;
  for (const port of def.inputs || []) {
    const edge = state.edges.find((e) => e.to.node === node.id && e.to.port === port.id);
    if (!edge) continue;
    const src = state.nodes.find((n) => n.id === edge.from.node);
    out[port.id] = valueOf(src);
  }
  return out;
}

/* ============================================================
   Управление runtime-состоянием узла
   ============================================================ */

export function setRuntime(node, runtime, helpers) {
  node.runtime = runtime;
  helpers.rerenderNode(node);
}

/* ============================================================
   Запуск конкретных типов узлов
   ============================================================ */

export async function runAssistant(node, ctx) {
  const inputs = collectInputs(node, ctx.state);
  const context = inputs.in || '';
  const prompt = node.data.prompt || '';
  if (!context && !prompt) {
    ctx.toast('Подключи Text-узел или укажи системную инструкцию', 'error');
    return;
  }

  setRuntime(node, { status: 'running', label: 'Думаю…' }, ctx);
  try {
    const r = await api.runAssistant({
      projectId: ctx.state.projectId,
      nodeId: node.id,
      prompt,
      context,
      model: node.data.model || 'auto',
      maxTokens: 1500,
    });
    node.data.result = r.text || '';
    node.data.modelUsed = r.modelUsed || node.data.model;
    setRuntime(node, { status: 'done' }, ctx);
    ctx.markDirty();
  } catch (e) {
    setRuntime(node, { status: 'error', error: e.message }, ctx);
    ctx.toast('Assistant: ' + (e.payload?.error || e.message), 'error');
  }
}

export async function runImage(node, ctx) {
  const inputs = collectInputs(node, ctx.state);
  const promptFromInput = (inputs.prompt || '').trim();
  const inlinePrompt = (node.data.prompt || '').trim();
  const prompt = promptFromInput || inlinePrompt;
  if (!prompt) {
    ctx.toast('Подключи Text-узел на вход «prompt» или впиши промпт в узле', 'error');
    return;
  }
  await runRemote(node, ctx, {
    label: 'Image',
    busyLabel: 'Генерирую…',
    apiCall: () => api.runImage({
      projectId: ctx.state.projectId,
      nodeId: node.id,
      model: node.data.model || 'flux-1.1-pro',
      prompt,
      // Поддерживаем оба формата: новый node.data.aspect ('1:1') и
      // legacy node.data.size ('1024x1024') — runner на бэке нормализует.
      aspect: node.data.aspect,
      size: node.data.size,
      referenceUrl: inputs.reference || node.data.referenceUrl || '',
    }),
  });
}

export async function runVideo(node, ctx) {
  const inputs = collectInputs(node, ctx.state);
  const promptFromInput = (inputs.prompt || '').trim();
  const inlinePrompt = (node.data.prompt || '').trim();
  const prompt = promptFromInput || inlinePrompt;
  // Видео может стартовать только с image (img2vid) — но хотя бы одно нужно.
  const ref = (inputs.image || node.data.referenceUrl || '').trim();
  if (!prompt && !ref) {
    ctx.toast('Подключи Image и/или Text — нужен либо prompt, либо стартовая картинка', 'error');
    return;
  }
  await runRemote(node, ctx, {
    label: 'Video',
    busyLabel: 'Генерирую видео…',
    apiCall: () => api.runVideo({
      projectId: ctx.state.projectId,
      nodeId: node.id,
      model: node.data.model || 'kling-v2.5-turbo',
      prompt,
      aspect: node.data.aspect || '16:9',
      duration: Number(node.data.duration) || 5,
      referenceUrl: ref,
    }),
  });
}

export async function runAudio(node, ctx) {
  const inputs = collectInputs(node, ctx.state);
  const text = (inputs.in || node.data.text || '').trim();
  if (!text) {
    ctx.toast('Подключи Text-узел или впиши текст для озвучки', 'error');
    return;
  }
  await runRemote(node, ctx, {
    label: 'TTS',
    busyLabel: 'Синтезирую речь…',
    apiCall: () => api.runAudio({
      projectId: ctx.state.projectId,
      nodeId: node.id,
      model: node.data.model || 'eleven_multilingual_v2',
      voiceId: node.data.voiceId || node.data.voice || '21m00Tcm4TlvDq8ikWAM',
      text,
    }),
  });
}

export async function runUpscale(node, ctx) {
  const inputs = collectInputs(node, ctx.state);
  const ref = (inputs.in || node.data.referenceUrl || '').trim();
  if (!ref) {
    ctx.toast('Подключи Image / Upload или прикрепи референс', 'error');
    return;
  }
  await runRemote(node, ctx, {
    label: 'Upscale',
    busyLabel: 'Апскейлю…',
    apiCall: () => api.runUpscale({
      projectId: ctx.state.projectId,
      nodeId: node.id,
      model: node.data.model || 'clarity-upscaler',
      scale: Number(node.data.scale) || 2,
      creativity: typeof node.data.creativity === 'number' ? node.data.creativity : 0.35,
      referenceUrl: ref,
    }),
  });
}

/**
 * Универсальный исполнитель для long-running узлов (Image / Video / Upscale).
 * Запускает run на бэке, потом раз в POLL_INTERVAL ходит за статусом и пишет
 * результат в node.data.resultUrl. Узел рисует свой собственный preview.
 */
async function runRemote(node, ctx, { label, busyLabel, apiCall }) {
  setRuntime(node, { status: 'running', label: 'Отправляю…', elapsed: 0 }, ctx);
  let runId;
  try {
    const r = await apiCall();
    runId = r.runId;
  } catch (e) {
    setRuntime(node, { status: 'error', error: e.message }, ctx);
    ctx.toast(label + ': ' + (e.payload?.error || e.message), 'error');
    return;
  }

  const start = Date.now();
  const tick = async () => {
    if (!ctx.state.nodes.find((n) => n.id === node.id)) return; // узел удалён
    let r;
    try { r = await api.getRun(runId); }
    catch { return setTimeout(tick, POLL_INTERVAL); }

    const elapsed = Math.round((Date.now() - start) / 1000);
    if (r.status === 'done') {
      node.data.resultUrl = r.resultUrl;
      setRuntime(node, { status: 'done' }, ctx);
      ctx.markDirty();
      return;
    }
    if (r.status === 'error') {
      setRuntime(node, { status: 'error', error: r.error || 'failed' }, ctx);
      ctx.toast(label + ': ' + (r.error || 'ошибка генерации'), 'error');
      return;
    }
    setRuntime(node, {
      status: 'running',
      label: r.status === 'queued' ? 'В очереди…' : busyLabel,
      elapsed,
    }, ctx);
    setTimeout(tick, POLL_INTERVAL);
  };
  setTimeout(tick, POLL_INTERVAL);
}
