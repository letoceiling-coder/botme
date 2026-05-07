/**
 * Определения типов узлов AI Media Studio.
 *
 * Узел — самостоятельная единица графа. Каждый kind имеет:
 *   - title, icon, accent: оформление шапки
 *   - inputs / outputs: декларация портов (для соединений)
 *   - defaultData: начальные значения полей
 *   - defaultSize: ширина/высота прямоугольника узла на канвасе
 *   - render(node, helpers): возвращает HTML-строку контентной части узла
 *
 * Сама логика выполнения (запуск Replicate, ElevenLabs и т.д.) живёт в
 * runner-е (фаза 4+); сейчас узлы только хранят данные и рисуют UI.
 */

export const NODE_TYPES = {
  text: {
    title: 'Text',
    icon: 'T',
    accent: '#6b7280',
    inputs: [],
    outputs: [{ id: 'out', label: 'text', kind: 'text' }],
    defaultData: { content: '' },
    defaultSize: { w: 280, h: 180 },
    render(node) {
      return `
        <textarea class="js-text" rows="6" placeholder="Введите текст или промпт…">${escapeHtml(node.data.content || '')}</textarea>
      `;
    },
  },

  assistant: {
    title: 'Assistant',
    icon: '✱',
    accent: '#7c5cff',
    inputs: [{ id: 'in', label: 'context', kind: 'text', optional: true }],
    outputs: [{ id: 'out', label: 'text', kind: 'text' }],
    defaultData: { model: 'auto', prompt: '', result: '' },
    defaultSize: { w: 320, h: 220 },
    render(node) {
      const has = node.data.result && node.runtime?.status !== 'running';
      return `
        <textarea class="js-prompt" rows="3" placeholder="Системная инструкция…">${escapeHtml(node.data.prompt || '')}</textarea>
        ${
          node.runtime?.status === 'running'
            ? `<div class="progress"><div class="spinner"></div><div>${escapeHtml(node.runtime.label || 'генерирую…')}</div></div>`
            : has
              ? `<div class="placeholder" style="text-align:left;color:var(--text);overflow:auto">${escapeHtml(node.data.result).slice(0, 600)}</div>`
              : `<div class="placeholder">Подключи Text на вход или укажи инструкцию выше</div>`
        }
        <div class="node-toolbar">
          <select class="js-model" title="Модель LLM">
            <option value="auto">Auto · с фоллбеком</option>
            <optgroup label="Claude (Anthropic)">
              <option value="claude:claude-haiku-4-5-20251001">Haiku 4.5</option>
              <option value="claude:claude-sonnet-4-6">Sonnet 4.6</option>
              <option value="claude:claude-opus-4-7">Opus 4.7</option>
            </optgroup>
            <optgroup label="OpenAI">
              <option value="openai:gpt-4o">GPT-4o</option>
              <option value="openai:gpt-4.1-mini">GPT-4.1 mini</option>
              <option value="openai:gpt-5.4-mini">GPT-5.4 mini</option>
              <option value="openai:gpt-5.4">GPT-5.4</option>
            </optgroup>
            <optgroup label="Gemini">
              <option value="gemini:gemini-2.5-flash">Gemini 2.5 Flash</option>
              <option value="gemini:gemini-2.5-pro">Gemini 2.5 Pro</option>
            </optgroup>
            <optgroup label="xAI Grok">
              <option value="xai:grok-4-fast">Grok 4 Fast</option>
              <option value="xai:grok-4">Grok 4</option>
              <option value="xai:grok-3-mini">Grok 3 mini</option>
              <option value="xai:grok-code-fast-1">Grok Code Fast</option>
            </optgroup>
            <optgroup label="OpenRouter · бесплатные">
              <option value="openrouter:meta-llama/llama-3.3-70b-instruct:free">Llama 3.3 70B · free</option>
              <option value="openrouter:google/gemini-2.0-flash-exp:free">Gemini 2.0 Flash · free</option>
              <option value="openrouter:deepseek/deepseek-chat-v3:free">DeepSeek Chat v3 · free</option>
              <option value="openrouter:qwen/qwen-2.5-coder-32b-instruct:free">Qwen 2.5 Coder 32B · free</option>
              <option value="openrouter:nvidia/nemotron-nano-9b-v2:free">Nemotron Nano 9B · free</option>
              <option value="openrouter:mistralai/mistral-small-3.2-24b-instruct:free">Mistral Small 3.2 24B · free</option>
              <option value="openrouter:meta-llama/llama-3.2-3b-instruct:free">Llama 3.2 3B · free</option>
            </optgroup>
          </select>
          <button class="run-btn js-run">Run</button>
        </div>
      `;
    },
  },

  image: {
    title: 'Image Generator',
    icon: '▦',
    accent: '#22d3ee',
    inputs: [
      { id: 'prompt',    label: 'prompt',    kind: 'text',  optional: true },
      { id: 'reference', label: 'image',     kind: 'image', optional: true },
    ],
    outputs: [{ id: 'out', label: 'image', kind: 'image' }],
    defaultData: { model: 'flux-1.1-pro', aspect: '1:1', prompt: '', referenceUrl: '', resultUrl: '' },
    defaultSize: { w: 320, h: 400 },
    render(node) {
      return `
        ${
          node.runtime?.status === 'running'
            ? `<div class="progress"><div class="spinner"></div><div>${escapeHtml(node.runtime.label || 'Generating image…')} ${node.runtime.elapsed || 0}s</div></div>`
            : node.data.resultUrl
              ? `<img class="preview-img" src="${escapeAttr(node.data.resultUrl)}" alt="">`
              : `<div class="placeholder">Подключи Text-узел или впиши промпт ниже и нажми Run</div>`
        }
        ${refThumbHtml(node)}
        <div class="node-toolbar">
          <select class="js-model" title="Модель генерации">
            <optgroup label="FLUX (Black Forest Labs)">
              <option value="flux-1.1-pro">FLUX 1.1 Pro</option>
              <option value="flux-1.1-pro-ultra">FLUX 1.1 Pro Ultra</option>
              <option value="flux-schnell">FLUX schnell · быстрая</option>
              <option value="flux-dev">FLUX dev</option>
              <option value="flux-kontext-pro">FLUX Kontext · img2img</option>
            </optgroup>
            <optgroup label="Универсальные">
              <option value="ideogram-v3-turbo">Ideogram v3 · текст в картинке</option>
              <option value="imagen-4">Google Imagen 4</option>
              <option value="seedream-4">Seedream 4 · ByteDance</option>
              <option value="nano-banana">Nano Banana · img-edit</option>
              <option value="recraft-v3">Recraft v3 · иллюстрации</option>
              <option value="sdxl">SDXL</option>
            </optgroup>
          </select>
          <select class="js-aspect" title="Соотношение сторон">
            <option value="1:1">1:1</option>
            <option value="16:9">16:9</option>
            <option value="9:16">9:16</option>
            <option value="3:2">3:2</option>
            <option value="2:3">2:3</option>
            <option value="4:3">4:3</option>
            <option value="3:4">3:4</option>
            <option value="4:5">4:5</option>
            <option value="5:4">5:4</option>
            <option value="21:9">21:9</option>
            <option value="match_input_image">по референсу</option>
          </select>
          <button class="run-btn js-run">Run</button>
        </div>
      `;
    },
  },

  video: {
    title: 'Video Generator',
    icon: '▷',
    accent: '#f472b6',
    inputs: [
      { id: 'image', label: 'image', kind: 'image', optional: true },
      { id: 'prompt', label: 'prompt', kind: 'text', optional: true },
    ],
    outputs: [{ id: 'out', label: 'video', kind: 'video' }],
    defaultData: { model: 'kling-v2.5-turbo', duration: 5, aspect: '16:9', resultUrl: '' },
    defaultSize: { w: 360, h: 360 },
    render(node) {
      return `
        ${
          node.runtime?.status === 'running'
            ? `<div class="progress"><div class="spinner"></div><div>${escapeHtml(node.runtime.label || 'Generating video…')} ${node.runtime.elapsed || 0}s</div></div>`
            : node.data.resultUrl
              ? `<video class="preview-video" src="${escapeAttr(node.data.resultUrl)}" controls preload="metadata"></video>`
              : `<div class="placeholder">Подключи Image (для img2vid) и/или впиши Prompt → нажми Run</div>`
        }
        ${refThumbHtml(node)}
        <div class="node-toolbar">
          <select class="js-model" title="Модель видео">
            <optgroup label="Kling">
              <option value="kling-v2.5-turbo">Kling 2.5 Turbo</option>
              <option value="kling-v1.6-pro">Kling 1.6 Pro</option>
            </optgroup>
            <optgroup label="Google Veo">
              <option value="veo-3">Veo 3</option>
              <option value="veo-3-fast">Veo 3 Fast</option>
            </optgroup>
            <optgroup label="Image-to-video">
              <option value="wan-2.5-i2v-fast">Wan 2.5 I2V · быстрая</option>
              <option value="seedance-1-pro">Seedance Pro · ByteDance</option>
              <option value="hailuo-02">Hailuo-02 · MiniMax</option>
              <option value="pixverse-v4.5">PixVerse v4.5</option>
            </optgroup>
            <optgroup label="Прочие">
              <option value="hunyuan-video">Hunyuan · text2video</option>
            </optgroup>
          </select>
          <select class="js-aspect">
            <option value="16:9">16:9</option>
            <option value="9:16">9:16</option>
            <option value="1:1">1:1</option>
          </select>
          <select class="js-duration">
            <option value="5">5s</option>
            <option value="8">8s</option>
            <option value="10">10s</option>
          </select>
          <button class="run-btn js-run">Run</button>
        </div>
      `;
    },
  },

  upscale: {
    title: 'Image Upscaler',
    icon: '⤢',
    accent: '#fbbf24',
    inputs: [{ id: 'in', label: 'image', kind: 'image' }],
    outputs: [{ id: 'out', label: 'image', kind: 'image' }],
    defaultData: { model: 'clarity-upscaler', scale: 2, creativity: 0.35, referenceUrl: '', resultUrl: '' },
    defaultSize: { w: 320, h: 320 },
    render(node) {
      return `
        ${
          node.runtime?.status === 'running'
            ? `<div class="progress"><div class="spinner"></div><div>${escapeHtml(node.runtime.label || 'Upscaling…')} ${node.runtime.elapsed || 0}s</div></div>`
            : node.data.resultUrl
              ? `<img class="preview-img" src="${escapeAttr(node.data.resultUrl)}">`
              : `<div class="placeholder">Подключи Image или прикрепи референс</div>`
        }
        ${refThumbHtml(node)}
        <div class="node-toolbar">
          <select class="js-model" title="Модель апскейла">
            <option value="clarity-upscaler">Clarity · Magnific-style</option>
            <option value="topaz-upscale">Topaz · премиум</option>
            <option value="real-esrgan">Real-ESRGAN · экономный</option>
          </select>
          <select class="js-scale">
            <option value="2">×2</option>
            <option value="4">×4</option>
            <option value="6">×6</option>
          </select>
          <button class="run-btn js-run">Upscale</button>
        </div>
      `;
    },
  },

  audio: {
    title: 'Audio (TTS)',
    icon: '♪',
    accent: '#34d399',
    inputs: [{ id: 'in', label: 'text', kind: 'text' }],
    outputs: [{ id: 'out', label: 'audio', kind: 'audio' }],
    // voiceId — конкретный voice_id ElevenLabs; voice — устаревший human-name,
    // оставляем только для миграции старых проектов.
    defaultData: { model: 'eleven_multilingual_v2', voiceId: '21m00Tcm4TlvDq8ikWAM', resultUrl: '' },
    defaultSize: { w: 320, h: 280 },
    render(node) {
      return `
        ${
          node.runtime?.status === 'running'
            ? `<div class="progress"><div class="spinner"></div><div>${escapeHtml(node.runtime.label || 'Синтезирую речь…')} ${node.runtime.elapsed || 0}s</div></div>`
            : node.data.resultUrl
              ? `<audio class="preview-audio" controls preload="metadata" src="${escapeAttr(node.data.resultUrl)}"></audio>`
              : `<div class="placeholder">Подключи Text — озвучу через ElevenLabs</div>`
        }
        <div class="node-toolbar">
          <select class="js-model" title="Модель TTS">
            <option value="eleven_multilingual_v2">Multilingual v2 — качество</option>
            <option value="eleven_turbo_v2_5">Turbo v2.5 — быстро</option>
            <option value="eleven_flash_v2_5">Flash v2.5 — самая быстрая</option>
          </select>
          <select class="js-voice" title="Голос">
            <!-- Опции подгружаются из каталога ElevenLabs -->
          </select>
          <button class="run-btn js-run">Speak</button>
        </div>
      `;
    },
  },

  list: {
    title: 'List',
    icon: '≡',
    accent: '#94a3b8',
    inputs: [],
    outputs: [{ id: 'out', label: 'items', kind: 'list' }],
    defaultData: { items: '' },
    defaultSize: { w: 280, h: 220 },
    render(node) {
      return `
        <textarea class="js-items" rows="8" placeholder="Каждая строка — отдельный элемент списка">${escapeHtml(node.data.items || '')}</textarea>
      `;
    },
  },

  upload: {
    title: 'Upload',
    icon: '↑',
    accent: '#a78bfa',
    inputs: [],
    outputs: [{ id: 'out', label: 'image', kind: 'image' }],
    defaultData: { resultUrl: '' },
    defaultSize: { w: 280, h: 240 },
    render(node) {
      return `
        ${
          node.data.resultUrl
            ? `<img class="preview-img" src="${escapeAttr(node.data.resultUrl)}">`
            : `<div class="placeholder">Перетащи файл сюда или кликни «Загрузить» (фаза 2)</div>`
        }
        <div class="node-toolbar">
          <button class="run-btn js-run">Загрузить</button>
        </div>
      `;
    },
  },

  stock: {
    title: 'Stock',
    icon: '⬚',
    accent: '#f97316',
    inputs: [],
    outputs: [{ id: 'out', label: 'image', kind: 'image' }],
    defaultData: { query: '', resultUrl: '' },
    defaultSize: { w: 280, h: 240 },
    render(node) {
      return `
        <input type="text" class="js-query" placeholder="Поиск по стокам…" value="${escapeAttr(node.data.query || '')}">
        <div class="placeholder">Каталог стоков — фаза 2</div>
      `;
    },
  },
};

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

/** Мини-плашка с превью прикреплённого референса и кнопкой «убрать». */
function refThumbHtml(node) {
  const url = node.data.referenceUrl;
  if (!url) return '';
  return `
    <div class="ref-thumb" title="Прикреплённый референс">
      <img src="${escapeAttr(url)}" alt="">
      <span>ref</span>
      <button class="ref-detach js-detach" title="Убрать референс">\u2715</button>
    </div>
  `;
}
