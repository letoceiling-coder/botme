/**
 * Клиентский кеш каталога моделей AI Media Studio.
 * Загружается один раз при старте /media и используется для:
 *   - фильтрации опций в селекторах (показываем только реально доступное),
 *   - подгонки aspect/duration/scale под выбранную модель,
 *   - подсказок «нужен ключ» когда секция пустая.
 */
import { api } from './api.js';

let catalog = null;
let loadPromise = null;

const FALLBACK = {
  image: [], video: [], upscale: [], llm: [], audio: [], voices: [],
  flags: {
    replicate: false,
    elevenlabs: false,
    llm: { openai: false, claude: false, gemini: false, xai: false, ollama: false },
  },
};

/** Гарантирует, что каталог загружен (с одной параллельной попыткой). */
export function ensureCatalog() {
  if (catalog) return Promise.resolve(catalog);
  if (loadPromise) return loadPromise;
  loadPromise = api.getCatalog()
    .then((c) => {
      catalog = c;
      // Делаем простой глобальный доступ для других модулей (canvas.js
      // читает голоса прямо отсюда, чтобы не плодить импорты).
      window.__catalogCache = c;
      return c;
    })
    .catch((e) => { console.warn('[catalog] load failed', e); catalog = FALLBACK; window.__catalogCache = FALLBACK; return catalog; })
    .finally(() => { loadPromise = null; });
  return loadPromise;
}

export function getCatalog() {
  return catalog || FALLBACK;
}

/** Список спецификаций моделей нужного типа. */
export function listModels(kind) {
  const c = getCatalog();
  if (kind === 'image')   return c.image   || [];
  if (kind === 'video')   return c.video   || [];
  if (kind === 'upscale') return c.upscale || [];
  if (kind === 'audio')   return c.audio   || [];
  if (kind === 'llm')     return c.llm     || [];
  return [];
}

/** Найти спецификацию модели по id. */
export function getSpec(kind, modelId) {
  return listModels(kind).find((m) => m.id === modelId) || null;
}

/** True, если для kind вообще что-то доступно (есть ключ у провайдера). */
export function isKindAvailable(kind) {
  const flags = getCatalog().flags || {};
  if (kind === 'llm') {
    return Object.values(flags.llm || {}).some(Boolean);
  }
  if (kind === 'audio') return flags.elevenlabs === true;
  return flags.replicate === true;
}
