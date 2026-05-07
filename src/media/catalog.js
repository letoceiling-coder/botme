/**
 * Единый каталог моделей AI Media Studio.
 *
 * Одна точка истины: какие модели вообще существуют, какие параметры
 * принимает каждая модель и какие требования у её входов.
 *
 * Использование:
 *   - Клиент дёргает GET /api/media/catalog → получает только реально
 *     доступные модели (с учётом ключей в .env) и их схемы.
 *   - Бэкенд (runner.js) валидирует входные параметры через
 *     `validateInput(kind, modelId, params)` ДО вызова Replicate, чтобы
 *     гасить заведомо невалидные запросы и давать понятную ошибку.
 *
 * Как добавить новую модель:
 *   1) Сюда добавить запись в IMAGE_CATALOG / VIDEO_CATALOG / UPSCALE_CATALOG.
 *   2) Поправить buildImageInput / buildVideoInput / resolveUpscaleRun
 *      в src/media/runner.js, если у модели специфичный input shape.
 *   3) Добавить цену в src/media/pricing.js.
 */

import { isReplicateConfigured, REPLICATE_MODELS } from './providers/replicate.js';
import { isProviderConfigured, MODELS as LLM_CATALOG } from '../llm.js';
import { isElevenLabsConfigured, ELEVENLABS_MODELS, ELEVENLABS_VOICES } from './providers/elevenlabs.js';

// =============================================================
// IMAGE
// =============================================================
/**
 * Схема одной image-модели:
 *   id            — внутренний ID (совпадает с ключом REPLICATE_MODELS)
 *   label         — человеческое имя для UI
 *   group         — категория для optgroup
 *   aspects       — список разрешённых aspect_ratio (или null если не нужен)
 *   sizes         — список (label,value) для модели, которая хочет width/height
 *   reference     — 'required' | 'optional' | 'none'
 *   formats       — поддерживаемые output_format (для UI; не показываем если 1 вариант)
 */
export const IMAGE_CATALOG = [
  {
    id: 'flux-1.1-pro',
    label: 'FLUX 1.1 Pro',
    group: 'FLUX (Black Forest Labs)',
    aspects: ['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '21:9'],
    reference: 'none',
  },
  {
    id: 'flux-1.1-pro-ultra',
    label: 'FLUX 1.1 Pro Ultra',
    group: 'FLUX (Black Forest Labs)',
    aspects: ['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '21:9'],
    reference: 'optional', // image_prompt
  },
  {
    id: 'flux-schnell',
    label: 'FLUX Schnell · самая быстрая',
    group: 'FLUX (Black Forest Labs)',
    aspects: ['1:1', '16:9', '9:16', '3:2', '2:3', '4:5', '5:4'],
    reference: 'none',
  },
  {
    id: 'flux-dev',
    label: 'FLUX Dev',
    group: 'FLUX (Black Forest Labs)',
    aspects: ['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4'],
    reference: 'optional', // img2img через image+prompt_strength
  },
  {
    id: 'flux-kontext-pro',
    label: 'FLUX Kontext Pro · img2img / редактирование',
    group: 'FLUX (Black Forest Labs)',
    aspects: ['match_input_image', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
    reference: 'required', // input_image обязателен
  },
  {
    id: 'sdxl',
    label: 'SDXL',
    group: 'Универсальные',
    aspects: ['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4'],
    reference: 'optional', // img2img
  },
  {
    id: 'recraft-v3',
    label: 'Recraft v3 · иллюстрации',
    group: 'Универсальные',
    aspects: ['1:1', '16:9', '9:16', '3:2', '2:3'],
    reference: 'none',
  },
  {
    id: 'ideogram-v3-turbo',
    label: 'Ideogram v3 Turbo · текст в картинке',
    group: 'Универсальные',
    aspects: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
    reference: 'none',
  },
  {
    id: 'imagen-4',
    label: 'Google Imagen 4',
    group: 'Универсальные',
    aspects: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    reference: 'none',
  },
  {
    id: 'seedream-4',
    label: 'Seedream 4 · ByteDance',
    group: 'Универсальные',
    aspects: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
    reference: 'optional', // image input
  },
  {
    id: 'nano-banana',
    label: 'Nano Banana · Gemini Flash Image',
    group: 'Универсальные',
    aspects: null, // не использует aspect_ratio, размер от input или фикс
    reference: 'optional', // image_input array
  },
];

// =============================================================
// VIDEO
// =============================================================
/**
 * Схема video-модели:
 *   aspects   — список разрешённых aspect_ratio (или null)
 *   durations — список разрешённых длительностей в секундах (или null если фикс)
 *   reference — 'required' | 'optional' | 'none'
 */
export const VIDEO_CATALOG = [
  {
    id: 'kling-v2.5-turbo',
    label: 'Kling 2.5 Turbo',
    group: 'Kling',
    aspects: ['16:9', '9:16', '1:1'],
    durations: [5, 10],
    reference: 'optional',
  },
  {
    id: 'kling-v1.6-pro',
    label: 'Kling 1.6 Pro',
    group: 'Kling',
    aspects: ['16:9', '9:16', '1:1'],
    durations: [5, 10],
    reference: 'optional',
  },
  {
    id: 'veo-3',
    label: 'Google Veo 3',
    group: 'Google Veo',
    aspects: ['16:9', '9:16'],
    durations: null, // фикс ~8s
    reference: 'optional',
  },
  {
    id: 'veo-3-fast',
    label: 'Google Veo 3 Fast',
    group: 'Google Veo',
    aspects: ['16:9', '9:16'],
    durations: null,
    reference: 'optional',
  },
  {
    id: 'wan-2.5-i2v-fast',
    label: 'Wan 2.5 I2V Fast · быстрая',
    group: 'Image-to-video',
    aspects: null, // от размера входной картинки
    durations: [5, 8],
    reference: 'required', // image обязателен
  },
  {
    id: 'seedance-1-pro',
    label: 'Seedance Pro · ByteDance',
    group: 'Image-to-video',
    aspects: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    durations: [5, 10],
    reference: 'optional',
  },
  {
    id: 'hailuo-02',
    label: 'Hailuo-02 · MiniMax',
    group: 'Image-to-video',
    aspects: ['16:9', '9:16', '1:1'],
    durations: [6, 10],
    reference: 'optional',
  },
  {
    id: 'pixverse-v4.5',
    label: 'PixVerse v4.5',
    group: 'Image-to-video',
    aspects: ['16:9', '9:16', '1:1'],
    durations: [5, 8],
    reference: 'optional',
  },
  {
    id: 'hunyuan-video',
    label: 'Hunyuan Video · text2video',
    group: 'Прочие',
    aspects: null, // через width/height
    durations: [5, 10], // мапим в num_frames
    reference: 'none',
  },
];

// =============================================================
// UPSCALE
// =============================================================
export const UPSCALE_CATALOG = [
  {
    id: 'clarity-upscaler',
    label: 'Clarity · Magnific-style',
    group: 'Upscale',
    scales: [2, 3, 4, 6],
    reference: 'required',
  },
  {
    id: 'topaz-upscale',
    label: 'Topaz · премиум',
    group: 'Upscale',
    scales: [2, 4, 6],
    reference: 'required',
  },
  {
    id: 'real-esrgan',
    label: 'Real-ESRGAN · экономный',
    group: 'Upscale',
    scales: [2, 4],
    reference: 'required',
  },
];

// =============================================================
// AUDIO (TTS / ElevenLabs)
// =============================================================
/**
 * Каталог моделей TTS. Голоса передаём отдельно (их сильно больше) и
 * клиент рендерит их как ещё один селектор.
 */
export const AUDIO_CATALOG = ELEVENLABS_MODELS.map((m) => ({
  id: m.id,
  label: m.label,
  group: 'ElevenLabs',
}));

// =============================================================
// LLM (для Assistant узла)
// =============================================================
/**
 * Описания моделей строим из llm.js → MODELS, добавляя осмысленную группу.
 * Берём только те, у которых провайдер сконфигурирован (есть ключ).
 */
const LLM_GROUPS = {
  ollama:     'Ollama (локально)',
  openai:     'OpenAI',
  claude:     'Claude (Anthropic)',
  gemini:     'Gemini (Google)',
  xai:        'xAI Grok',
  openrouter: 'OpenRouter',
};

export function getLLMCatalog() {
  return LLM_CATALOG
    .filter((m) => isProviderConfigured(m.provider))
    .map((m) => ({
      id: m.id,
      label: m.label,
      // Бесплатные модели OpenRouter выделяем в отдельную группу
      // «OpenRouter · бесплатные», чтобы было сразу понятно что они free.
      group: m.openrouterFree
        ? 'OpenRouter · бесплатные'
        : (LLM_GROUPS[m.provider] || m.provider),
      free: !!m.openrouterFree,
    }));
}

// =============================================================
// Helpers: получить доступный каталог с учётом ключей
// =============================================================

function filterReplicate(catalog) {
  if (!isReplicateConfigured()) return [];
  // Ещё подстраховка: если кто-то описал модель в catalog.js, но забыл
  // добавить её в REPLICATE_MODELS — отфильтруем, иначе runner упадёт.
  return catalog.filter((m) => REPLICATE_MODELS[m.id]);
}

/**
 * Полный каталог для фронта. Возвращает только реально доступные модели.
 * Если ключа Replicate нет — соответствующие массивы будут пустыми; UI
 * сам это обработает (покажет «Нужен REPLICATE_API_TOKEN»).
 */
export function getAvailableCatalog() {
  const elevenOk = isElevenLabsConfigured();
  return {
    image:   filterReplicate(IMAGE_CATALOG),
    video:   filterReplicate(VIDEO_CATALOG),
    upscale: filterReplicate(UPSCALE_CATALOG),
    llm:     getLLMCatalog(),
    audio:   elevenOk ? AUDIO_CATALOG : [],
    voices:  elevenOk ? ELEVENLABS_VOICES : [],
    flags: {
      replicate: isReplicateConfigured(),
      elevenlabs: elevenOk,
      llm: {
        openai:  isProviderConfigured('openai'),
        claude:  isProviderConfigured('claude'),
        gemini:  isProviderConfigured('gemini'),
        xai:     isProviderConfigured('xai'),
        ollama:  isProviderConfigured('ollama'),
      },
    },
  };
}

// =============================================================
// Validation: используется в runner.js перед вызовом Replicate
// =============================================================
function findInList(list, id) {
  return list.find((m) => m.id === id);
}

/**
 * Валидирует и нормализует параметры в зависимости от kind+model.
 * Возвращает «очищенные» params, где значения подгоняются под допустимые
 * (или бросает Error с понятным текстом).
 */
export function validateInput(kind, modelId, params = {}) {
  const out = { ...params };
  // Audio (TTS): валидация минимальная — модель и текст. Голос проверяем только
  // на «не пустой», конкретный voice_id может быть от пользовательского клона.
  if (kind === 'audio') {
    const known = AUDIO_CATALOG.find((m) => m.id === modelId);
    if (!known) {
      // Просто подменим на дефолт; ElevenLabs ругнётся раньше нас, если
      // что-то совсем странное.
      out.model = AUDIO_CATALOG[0]?.id || 'eleven_multilingual_v2';
    }
    return out;
  }
  const list = kind === 'image' ? IMAGE_CATALOG
             : kind === 'video' ? VIDEO_CATALOG
             : kind === 'upscale' ? UPSCALE_CATALOG
             : null;
  if (!list) return out;

  const spec = findInList(list, modelId);
  if (!spec) {
    throw new Error(`Модель не зарегистрирована в каталоге: ${modelId}`);
  }

  // Reference (входное изображение)
  if (spec.reference === 'required') {
    if (!String(params.referenceUrl || '').trim()) {
      throw new Error(`Модель «${spec.label}» требует обязательную входную картинку. Подключи Image-узел или загрузи реф.`);
    }
  }

  // Aspect ratio
  if (spec.aspects) {
    if (params.aspect && !spec.aspects.includes(params.aspect)) {
      // Подгоняем к ближайшему допустимому, не падая.
      out.aspect = spec.aspects[0];
    }
  } else {
    delete out.aspect;
  }

  // Duration
  if (spec.durations) {
    const d = Number(params.duration);
    if (!spec.durations.includes(d)) {
      // Берём ближайшее.
      out.duration = spec.durations.reduce(
        (best, x) => Math.abs(x - d) < Math.abs(best - d) ? x : best,
        spec.durations[0],
      );
    }
  } else {
    delete out.duration;
  }

  // Scale (для upscale)
  if (spec.scales) {
    const s = Number(params.scale);
    if (!spec.scales.includes(s)) {
      out.scale = spec.scales.reduce(
        (best, x) => Math.abs(x - s) < Math.abs(best - s) ? x : best,
        spec.scales[0],
      );
    }
  }

  return out;
}

/** Найти спецификацию модели (для других модулей). */
export function getSpec(kind, modelId) {
  const list = kind === 'image' ? IMAGE_CATALOG
             : kind === 'video' ? VIDEO_CATALOG
             : kind === 'upscale' ? UPSCALE_CATALOG
             : null;
  return list ? findInList(list, modelId) : null;
}
