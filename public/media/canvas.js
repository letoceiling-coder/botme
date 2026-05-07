/**
 * Главный модуль AI Media Studio: канвас с узлами и связями.
 *
 * Архитектура:
 *  - Хранилище состояния — простой объект `state` (nodes, edges, viewport).
 *  - Рендер — императивный, через SVG-элементы и foreignObject (для HTML
 *    внутри узла). Перерисовка инкрементальная (один узел / одна связь).
 *  - Координаты узлов — в "world space"; SVG-группа #viewport переносится
 *    transform: matrix() для pan и scale для zoom. World↔screen conversion
 *    делается в helpers.
 *  - Перетаскивание узлов — на pointermove, без deps.
 *  - Соединения — drag из output-порта в input-порт; ghost-линия следует за
 *    курсором. При совместимости port.kind связь фиксируется.
 *  - Persistence — debounced saveProject (500ms после правок).
 */

import { api } from './api.js';
import { NODE_TYPES } from './nodes.js';
import { runAssistant, runImage, runVideo, runUpscale, runAudio } from './runner.js';
import { openAssetsDrawer } from './assets.js';
import { ensureCatalog, listModels, getSpec, isKindAvailable } from './catalog.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// =====================================================
// State
// =====================================================
const state = {
  projectId: null,
  title: 'Untitled space',
  nodes: [],            // { id, kind, x, y, w, h, data, runtime }
  edges: [],            // { id, from: { node, port }, to: { node, port } }
  viewport: { x: 0, y: 0, zoom: 1 },
  selection: new Set(), // node ids
  dirty: false,
};

// DOM
const els = {
  svg: document.getElementById('canvasSvg'),
  viewport: document.getElementById('viewport'),
  edgesLayer: document.getElementById('edgesLayer'),
  nodesLayer: document.getElementById('nodesLayer'),
  overlay: document.getElementById('overlayLayer'),
  wrap: document.getElementById('canvasWrap'),
  emptyAdd: document.getElementById('emptyAdd'),
  hudZoom: document.getElementById('hudZoom'),
  saveStatus: document.getElementById('saveStatus'),
  projectTitle: document.getElementById('projectTitle'),
  palette: document.getElementById('palette'),
  paletteSearch: document.getElementById('paletteSearch'),
  ctx: document.getElementById('nodeCtx'),
  drawer: document.getElementById('drawer'),
  drawerList: document.getElementById('drawerList'),
  toast: document.getElementById('toast'),
};

// =====================================================
// Helpers
// =====================================================
function uid() { return 'n_' + Math.random().toString(36).slice(2, 10); }
function uidEdge() { return 'e_' + Math.random().toString(36).slice(2, 10); }

function screenToWorld(sx, sy) {
  const rect = els.svg.getBoundingClientRect();
  const x = (sx - rect.left - state.viewport.x) / state.viewport.zoom;
  const y = (sy - rect.top - state.viewport.y) / state.viewport.zoom;
  return { x, y };
}

function applyViewport() {
  const { x, y, zoom } = state.viewport;
  els.viewport.setAttribute('transform', `translate(${x} ${y}) scale(${zoom})`);
  els.hudZoom.textContent = Math.round(zoom * 100) + '%';
}

function showToast(msg, kind = '') {
  els.toast.className = 'toast ' + kind;
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(els.toast._t);
  els.toast._t = setTimeout(() => (els.toast.hidden = true), 2400);
}

function setSaveStatus(s) {
  els.saveStatus.className = 'save-status ' + s;
  els.saveStatus.textContent =
    s === 'dirty' ? 'не сохранено' :
    s === 'saving' ? 'сохраняю…' :
    s === 'saved' ? 'сохранено' :
    s === 'error' ? 'ошибка сохранения' : '';
}

// =====================================================
// Auto-save (debounced)
// =====================================================
let saveTimer = null;
function markDirty() {
  state.dirty = true;
  setSaveStatus('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}
async function saveNow() {
  if (!state.projectId) return;
  setSaveStatus('saving');
  try {
    const graph = serialize();
    await api.saveProject(state.projectId, graph, state.title);
    state.dirty = false;
    setSaveStatus('saved');
  } catch (e) {
    console.error('[media] save failed', e);
    setSaveStatus('error');
    showToast('Не удалось сохранить', 'error');
  }
}
function serialize() {
  return {
    viewport: { ...state.viewport },
    nodes: state.nodes.map((n) => ({
      id: n.id, kind: n.kind, x: n.x, y: n.y, w: n.w, h: n.h, data: n.data,
    })),
    edges: state.edges.map((e) => ({
      id: e.id, from: e.from, to: e.to,
    })),
  };
}

// =====================================================
// Node rendering
// =====================================================
function renderNode(node) {
  const def = NODE_TYPES[node.kind];
  if (!def) return;

  // Удалить старую группу, если перерисовываем
  document.getElementById('node-' + node.id)?.remove();

  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'node');
  g.setAttribute('id', 'node-' + node.id);
  g.dataset.id = node.id;
  g.setAttribute('transform', `translate(${node.x} ${node.y})`);

  // Тело узла (прямоугольник со скруглением)
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('class', 'node-body');
  rect.setAttribute('x', 0); rect.setAttribute('y', 0);
  rect.setAttribute('width', node.w); rect.setAttribute('height', node.h);
  rect.setAttribute('rx', 12); rect.setAttribute('ry', 12);
  g.appendChild(rect);

  // Шапка: цветной квадрат-иконка типа узла + название.
  // Для узлов, принимающих референс (Image / Video / Upscale), клик по
  // этой иконке открывает Media Manager — единый «attach» жест в стиле
  // www.magnific.com (там тоже клик по type-badge открывает picker).
  const supportsAttach = ['image', 'video', 'upscale'].includes(node.kind);
  const iconG = document.createElementNS(SVG_NS, 'g');
  iconG.setAttribute('class', 'node-typeicon' + (supportsAttach ? ' attachable' : ''));
  iconG.setAttribute('transform', 'translate(12 10)');
  if (supportsAttach) {
    const tt = document.createElementNS(SVG_NS, 'title');
    tt.textContent = 'Кликни — выбрать референс из медиатеки';
    iconG.appendChild(tt);
  }
  const iconRect = document.createElementNS(SVG_NS, 'rect');
  iconRect.setAttribute('x', 0); iconRect.setAttribute('y', 0);
  iconRect.setAttribute('width', 20); iconRect.setAttribute('height', 20);
  iconRect.setAttribute('rx', 5);
  iconRect.setAttribute('fill', def.accent || '#7c5cff');
  iconRect.setAttribute('opacity', '0.9');
  iconG.appendChild(iconRect);

  const iconText = document.createElementNS(SVG_NS, 'text');
  iconText.setAttribute('x', 10); iconText.setAttribute('y', 10);
  iconText.setAttribute('text-anchor', 'middle');
  iconText.setAttribute('dominant-baseline', 'central');
  iconText.setAttribute('font-size', '11');
  iconText.setAttribute('font-weight', '700');
  iconText.setAttribute('fill', '#07070b');
  iconText.style.pointerEvents = 'none';
  iconText.textContent = def.icon || '?';
  iconG.appendChild(iconText);

  if (supportsAttach) {
    // Различаем click и drag по порогу смещения. Если пользователь
    // зажал и сдвинул > 4px — это попытка таскать узел; pointerdown
    // на iconG останавливает propagation, чтобы не запустился глобальный
    // drag, но если двинулись — отменяем «click» и пускаем как drag.
    let downAt = null;
    let captured = false;
    iconG.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      downAt = { x: e.clientX, y: e.clientY, id: e.pointerId };
      try { iconG.setPointerCapture(e.pointerId); captured = true; } catch {}
      e.stopPropagation();
    });
    iconG.addEventListener('pointermove', (e) => {
      if (!downAt || downAt.id !== e.pointerId) return;
      const dx = e.clientX - downAt.x;
      const dy = e.clientY - downAt.y;
      if (dx * dx + dy * dy > 16) {
        // Превратился в drag — освобождаем capture и пускаем дальше.
        if (captured) try { iconG.releasePointerCapture(downAt.id); } catch {}
        downAt = null;
        captured = false;
      }
    });
    iconG.addEventListener('pointerup', (e) => {
      if (!downAt || downAt.id !== e.pointerId) return;
      const dx = e.clientX - downAt.x;
      const dy = e.clientY - downAt.y;
      if (captured) try { iconG.releasePointerCapture(downAt.id); } catch {}
      downAt = null;
      captured = false;
      if (dx * dx + dy * dy <= 16) {
        e.stopPropagation();
        attachReferenceFor(node);
      }
    });
  }
  g.appendChild(iconG);

  const title = document.createElementNS(SVG_NS, 'text');
  title.setAttribute('class', 'node-title');
  title.setAttribute('x', 40); title.setAttribute('y', 24);
  title.textContent = def.title;
  g.appendChild(title);

  // Статус-точка слева от кнопки удаления
  const status = document.createElementNS(SVG_NS, 'circle');
  status.setAttribute('cx', node.w - 38); status.setAttribute('cy', 20);
  status.setAttribute('r', 4);
  status.setAttribute('class', 'node-status-dot ' + (node.runtime?.status || 'idle'));
  g.appendChild(status);

  // Кнопка «×» удаления (постоянно видна, в стиле Magnific)
  const closeG = document.createElementNS(SVG_NS, 'g');
  closeG.setAttribute('class', 'node-close');
  closeG.setAttribute('transform', `translate(${node.w - 28} 8)`);
  const closeBg = document.createElementNS(SVG_NS, 'rect');
  closeBg.setAttribute('width', 18); closeBg.setAttribute('height', 18);
  closeBg.setAttribute('rx', 5);
  closeBg.setAttribute('class', 'node-close-bg');
  closeG.appendChild(closeBg);
  const closeIcon = document.createElementNS(SVG_NS, 'text');
  closeIcon.setAttribute('x', 9); closeIcon.setAttribute('y', 9);
  closeIcon.setAttribute('text-anchor', 'middle');
  closeIcon.setAttribute('dominant-baseline', 'central');
  closeIcon.setAttribute('class', 'node-close-icon');
  closeIcon.textContent = '\u2715';
  closeG.appendChild(closeIcon);
  // Удаляем сразу на pointerdown — click event ненадёжен внутри SVG, у
  // которого может быть pointer-capture от drag/connect handlers выше.
  closeG.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    removeNode(node.id);
  });
  // click оставляем как safety net (например при touch).
  closeG.addEventListener('click', (e) => {
    e.stopPropagation();
    removeNode(node.id);
  });
  g.appendChild(closeG);

  // Контент (HTML внутри foreignObject)
  const fo = document.createElementNS(SVG_NS, 'foreignObject');
  fo.setAttribute('x', 0); fo.setAttribute('y', 0);
  fo.setAttribute('width', node.w); fo.setAttribute('height', node.h);
  const html = document.createElement('div');
  html.className = 'node-content';
  html.innerHTML = def.render(node);
  fo.appendChild(html);
  g.appendChild(fo);

  // Привязка inputs внутри HTML к node.data
  bindNodeContent(node, html);

  // Порты — квадратные плашки с пиктограммой типа данных (text/image/video/audio/list)
  const PORT_SIZE = 24;
  const inputs = def.inputs || [];
  const outputs = def.outputs || [];
  const portStep = (kind, list) => {
    if (!list.length) return [];
    const step = node.h / (list.length + 1);
    return list.map((p, i) => ({ ...p, x: kind === 'in' ? 0 : node.w, y: step * (i + 1) }));
  };
  const inPorts = portStep('in', inputs);
  const outPorts = portStep('out', outputs);
  inPorts.forEach((p) => g.appendChild(buildPortNode(node.id, p, 'in', PORT_SIZE)));
  outPorts.forEach((p) => g.appendChild(buildPortNode(node.id, p, 'out', PORT_SIZE)));

  // closeG перемещаем в самый конец DOM, чтобы он лежал ПОВЕРХ foreignObject
  // (иначе HTML-контент узла перехватывает клики по крестику). Отдельной
  // 📎-кнопки больше нет: для прикрепления референса используется клик по
  // иконке типа узла слева (см. supportsAttach выше).
  g.appendChild(closeG);

  // Состояния через классы
  if (state.selection.has(node.id)) g.classList.add('selected');
  if (node.runtime?.status === 'running') g.classList.add('running');
  if (node.runtime?.status === 'error') g.classList.add('error');
  if (node.runtime?.status === 'done') g.classList.add('done');

  els.nodesLayer.appendChild(g);
}

/**
 * Применяет каталог к селекторам узла:
 *  • в .js-model оставляет только реально доступные модели (по ключам);
 *  • для текущей модели подгоняет .js-aspect / .js-duration / .js-scale
 *    под её спецификацию (показывая/пряча ненужные).
 *  • показывает плейсхолдер «нет ключа», если для kind ничего недоступно.
 *
 * Вызывается дважды: сразу после рендера ноды и при каждой смене модели.
 */
function applyCatalogToNode(node, root) {
  const kind = node.kind;
  const isReplicateKind = kind === 'image' || kind === 'video' || kind === 'upscale';
  const isLLMKind   = kind === 'assistant';
  const isAudioKind = kind === 'audio';
  if (!isReplicateKind && !isLLMKind && !isAudioKind) return;

  const modelEl = root.querySelector('.js-model');
  if (!modelEl) return;

  // Если нет ключа — скрываем тулбар и показываем подсказку.
  const placeholder = root.querySelector('.no-keys-hint');
  const noKey = isReplicateKind ? !isKindAvailable('image') /* единый флаг replicate */
              : isAudioKind     ? !isKindAvailable('audio')
              : !isKindAvailable('llm');
  if (noKey) {
    if (!placeholder) {
      const tb = root.querySelector('.node-toolbar');
      const hint = document.createElement('div');
      hint.className = 'placeholder no-keys-hint';
      hint.textContent = isReplicateKind
        ? 'Нет REPLICATE_API_TOKEN — добавь в .env и перезапусти сервер'
        : isAudioKind
          ? 'Нет ELEVENLABS_API_KEY — добавь в .env и перезапусти сервер'
          : 'Не настроен ни один LLM-провайдер (OpenAI/Claude/Gemini/Grok)';
      if (tb && tb.parentNode) tb.parentNode.insertBefore(hint, tb);
      if (tb) tb.style.display = 'none';
    }
    return;
  }
  if (placeholder) placeholder.remove();
  const tb = root.querySelector('.node-toolbar');
  if (tb) tb.style.display = '';

  // 1) Фильтрация .js-model по реально доступным id.
  const catalogKind = isReplicateKind ? kind
                    : isAudioKind     ? 'audio'
                    : 'llm';
  const availableList = listModels(catalogKind);
  const availableIds = new Set(availableList.map((m) => m.id));
  // Для Assistant у нас есть «auto» — это не реальная модель, но мы её
  // оставляем как есть.
  if (isLLMKind) availableIds.add('auto');

  // Удаляем option-ы которых нет в каталоге; пустые optgroup тоже убираем.
  for (const optgroup of [...modelEl.querySelectorAll('optgroup')]) {
    for (const opt of [...optgroup.querySelectorAll('option')]) {
      if (!availableIds.has(opt.value)) opt.remove();
    }
    if (!optgroup.querySelector('option')) optgroup.remove();
  }
  for (const opt of [...modelEl.querySelectorAll(':scope > option')]) {
    if (opt.value !== 'auto' && !availableIds.has(opt.value)) opt.remove();
  }

  // Если выбранной модели больше нет в списке — подменим на первую доступную.
  const currentVal = node.data.model || modelEl.value;
  if (currentVal && !modelEl.querySelector(`option[value="${cssEscape(currentVal)}"]`)) {
    const firstOpt = modelEl.querySelector('option');
    const fallback = firstOpt?.value || availableList[0]?.id || '';
    if (fallback) {
      node.data.model = fallback;
      modelEl.value = fallback;
    }
  }

  // 2) Синхронизация зависимых селекторов под спецификацию модели.
  if (isReplicateKind) {
    const spec = getSpec(kind, node.data.model || modelEl.value);
    if (spec) syncDependentSelectors(node, root, spec);
  }
  if (isAudioKind) {
    fillVoiceOptions(node, root);
  }
}

/** Наполнить .js-voice голосами из каталога ElevenLabs. */
function fillVoiceOptions(node, root) {
  const voiceEl = root.querySelector('.js-voice');
  if (!voiceEl) return;
  const c = (window.__catalogCache?.voices) || [];
  if (!c.length) return; // ещё не загрузили или нет ключа — UI оставляет дефолт
  voiceEl.innerHTML = '';
  for (const v of c) {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.description ? `${v.name} — ${v.description}` : v.name;
    voiceEl.appendChild(o);
  }
  const cur = node.data.voiceId || node.data.voice;
  if (cur && voiceEl.querySelector(`option[value="${cssEscape(cur)}"]`)) {
    voiceEl.value = cur;
  } else {
    node.data.voiceId = voiceEl.value;
  }
}

/** Перестраивает .js-aspect / .js-duration / .js-scale из spec.aspects/.durations/.scales. */
function syncDependentSelectors(node, root, spec) {
  const aspectEl = root.querySelector('.js-aspect');
  const durEl    = root.querySelector('.js-duration');
  const scaleEl  = root.querySelector('.js-scale');

  // ---- aspect ----
  if (aspectEl) {
    if (Array.isArray(spec.aspects) && spec.aspects.length) {
      rebuildOptions(aspectEl, spec.aspects.map((a) => ({ v: a, l: a })));
      aspectEl.style.display = '';
      // Подгоняем текущее значение.
      if (!spec.aspects.includes(node.data.aspect)) {
        node.data.aspect = spec.aspects[0];
      }
      aspectEl.value = node.data.aspect;
    } else {
      // Модель не использует aspect — прячем селектор.
      aspectEl.style.display = 'none';
      delete node.data.aspect;
    }
  }

  // ---- duration ----
  if (durEl) {
    if (Array.isArray(spec.durations) && spec.durations.length) {
      rebuildOptions(durEl, spec.durations.map((d) => ({ v: String(d), l: d + 's' })));
      durEl.style.display = '';
      if (!spec.durations.includes(Number(node.data.duration))) {
        node.data.duration = spec.durations[0];
      }
      durEl.value = String(node.data.duration);
    } else {
      durEl.style.display = 'none';
      delete node.data.duration;
    }
  }

  // ---- scale (upscale) ----
  if (scaleEl) {
    if (Array.isArray(spec.scales) && spec.scales.length) {
      rebuildOptions(scaleEl, spec.scales.map((s) => ({ v: String(s), l: '×' + s })));
      scaleEl.style.display = '';
      if (!spec.scales.includes(Number(node.data.scale))) {
        node.data.scale = spec.scales[0];
      }
      scaleEl.value = String(node.data.scale);
    } else {
      scaleEl.style.display = 'none';
    }
  }
}

function rebuildOptions(selectEl, items) {
  selectEl.innerHTML = '';
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.v;
    o.textContent = it.l;
    selectEl.appendChild(o);
  }
}

/** CSS.escape с фолбэком для очень старых браузеров. */
function cssEscape(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

/** Привязать поля HTML (textarea, select, кнопка Run) к node.data. */
function bindNodeContent(node, root) {
  const set = (key, value) => { node.data[key] = value; markDirty(); };

  root.querySelector('.js-text')?.addEventListener('input', (e) => set('content', e.target.value));
  root.querySelector('.js-prompt')?.addEventListener('input', (e) => set('prompt', e.target.value));
  root.querySelector('.js-items')?.addEventListener('input', (e) => set('items', e.target.value));
  root.querySelector('.js-query')?.addEventListener('input', (e) => set('query', e.target.value));

  const model = root.querySelector('.js-model');
  const aspect = root.querySelector('.js-aspect');
  const dur = root.querySelector('.js-duration');
  const scale = root.querySelector('.js-scale');

  // Применяем каталог (фильтр доступного + синхронизация aspect/duration).
  // Это меняет options в селекторах ДО присваивания .value, чтобы значение
  // из node.data попало в актуальный список.
  applyCatalogToNode(node, root);

  if (model) {
    model.value = node.data.model || model.value;
    model.addEventListener('change', (e) => {
      set('model', e.target.value);
      // При смене модели — переинициализируем зависимые селекторы.
      applyCatalogToNode(node, root);
    });
  }
  const size = root.querySelector('.js-size');
  if (size) { size.value = node.data.size || size.value; size.addEventListener('change', (e) => set('size', e.target.value)); }
  if (aspect) { aspect.value = node.data.aspect || aspect.value; aspect.addEventListener('change', (e) => set('aspect', e.target.value)); }
  if (dur) { dur.value = String(node.data.duration || dur.value); dur.addEventListener('change', (e) => set('duration', Number(e.target.value))); }
  if (scale) { scale.value = String(node.data.scale || scale.value); scale.addEventListener('change', (e) => set('scale', Number(e.target.value))); }
  const voice = root.querySelector('.js-voice');
  if (voice) {
    // Поддержка legacy: старые проекты сохраняли voice='rachel' (имя),
    // новые — voiceId (uuid). Приоритет — voiceId.
    voice.value = node.data.voiceId || node.data.voice || voice.value;
    voice.addEventListener('change', (e) => set('voiceId', e.target.value));
  }

  // Внутри полей ввода / кнопок / медиа — НЕ запускаем drag всего узла, чтобы
  // можно было нормально печатать и выделять текст. На остальных пустых
  // местах foreignObject событие должно бабблить до nodesLayer и инициировать
  // обычный drag через делегирование (см. ниже).
  root.querySelectorAll('input, textarea, select, button, [contenteditable], audio, video').forEach((el) => {
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
  });
  // Колесо мыши внутри узла:
  //   • Ctrl/Meta + wheel  → зум канваса (не браузера). Принудительно
  //     preventDefault, иначе Chrome/Edge зумят страницу. Listener должен
  //     быть НЕ passive, иначе preventDefault игнорируется.
  //   • просто wheel       → нативный скролл контента, без зума канваса
  //     (поэтому stopPropagation, чтобы не сработал els.wrap-wheel).
  root.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    } else {
      e.stopPropagation();
    }
  }, { passive: false });

  root.querySelector('.js-run')?.addEventListener('click', (e) => {
    e.stopPropagation();
    runNode(node);
  });
  // Кнопка attach перенесена в SVG-шапку узла (см. attachReferenceFor()),
  // поэтому здесь обрабатываем только удаление референса (миниатюра).
  root.querySelector('.js-detach')?.addEventListener('click', (e) => {
    e.stopPropagation();
    node.data.referenceUrl = '';
    rerenderNode(node);
    markDirty();
  });
}


/** Открыть медиа-менеджер и прикрепить выбранный URL как референс к узлу. */
async function attachReferenceFor(node) {
  try {
    // Какие типы ассетов узел вообще способен принять как референс.
    // image-узел работает только с фото; video-узел — img2vid принимает
    // и фото (как первый кадр), и готовое видео; upscale — только фото.
    const kinds = node.kind === 'video'   ? ['image', 'video']
               : node.kind === 'upscale' ? ['image']
               :                           ['image'];
    const url = await openAssetsDrawer({ kinds, title: titleForKinds(kinds) });
    if (!url) return;
    node.data.referenceUrl = url;
    rerenderNode(node);
    markDirty();
    showToast('Референс прикреплён', 'ok');
  } catch (e) {
    showToast(e?.message || 'Не удалось прикрепить', 'err');
  }
}

function titleForKinds(kinds) {
  if (kinds.length === 1 && kinds[0] === 'image') return 'Выбор фото-референса';
  if (kinds.length === 1 && kinds[0] === 'video') return 'Выбор видео-референса';
  return 'Выбор референса';
}

/* =====================================================
   Порты: квадратная плашка + цветная иконка типа данных.
   Возвращает <g class="port"> готовый к добавлению в SVG-узел.
   ===================================================== */
function buildPortNode(nodeId, p, dir, size) {
  const halfS = size / 2;
  const grp = document.createElementNS(SVG_NS, 'g');
  grp.setAttribute('class', `port port-${dir} kind-${p.kind || 'any'}`);
  grp.setAttribute('transform', `translate(${p.x - halfS} ${p.y - halfS})`);
  grp.dataset.node = nodeId;
  grp.dataset.port = p.id;
  grp.dataset.dir = dir;
  grp.dataset.kind = p.kind || 'any';

  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('class', 'port-bg');
  bg.setAttribute('width', size); bg.setAttribute('height', size);
  bg.setAttribute('rx', 6); bg.setAttribute('ry', 6);
  grp.appendChild(bg);

  // Иконки нарисованы в bbox 14×14 c визуальным центром в (7, 7), поэтому
  // translate ставим так, чтобы (7,7) совпала с центром плашки size×size.
  const iconG = document.createElementNS(SVG_NS, 'g');
  iconG.setAttribute('class', 'port-icon');
  iconG.setAttribute('transform', `translate(${size / 2 - 7} ${size / 2 - 7})`);
  iconG.appendChild(portIconPath(p.kind || 'any'));
  grp.appendChild(iconG);

  // Подпись снаружи плашки.
  const lbl = document.createElementNS(SVG_NS, 'text');
  lbl.setAttribute('class', 'port-label');
  lbl.setAttribute('y', size / 2 + 3);
  if (dir === 'in') {
    lbl.setAttribute('x', size + 6); lbl.setAttribute('text-anchor', 'start');
  } else {
    lbl.setAttribute('x', -6); lbl.setAttribute('text-anchor', 'end');
  }
  lbl.textContent = p.label || p.kind || '';
  grp.appendChild(lbl);
  return grp;
}

/** SVG path в bbox 14×14 с визуальным центром в (7, 7). */
function portIconPath(kind) {
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.6');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  let d;
  switch (kind) {
    case 'text':
      // Буква T в bbox 2..12 × 2..12
      d = 'M3 3 H11 M7 3 V12';
      break;
    case 'image':
      // Прямоугольник 2..12 × 3..11 (центр 7,7) + солнце + горы
      d = 'M2 3 H12 V11 H2 Z M5 6 a0.7 0.7 0 1 0 0.01 0 M3 10 L6 7 L8 9 L12 5';
      break;
    case 'video':
      // Кадр 2..10 × 3..11 + треугольник play в правой части. Симметрично
      // относительно (7,7) делает центр плашки = центр иконки.
      d = 'M2 3 H10 V11 H2 Z M11 5 V9 L13 7 Z';
      break;
    case 'audio':
      // Нота в bbox 2..12 × 2..12
      d = 'M5 11 V3 L11 2 V9 M5 11 a1.5 1 0 1 1 -3 0 a1.5 1 0 1 1 3 0 M11 9 a1.5 1 0 1 1 -3 0 a1.5 1 0 1 1 3 0';
      break;
    case 'list':
      // Три линии в bbox 2..12 × 3.5..10.5
      d = 'M2 3.5 H12 M2 7 H12 M2 10.5 H12';
      break;
    default:
      // any: круг радиуса 4 вокруг (7, 7)
      d = 'M7 7 m -4 0 a 4 4 0 1 0 8 0 a 4 4 0 1 0 -8 0';
  }
  p.setAttribute('d', d);
  return p;
}

// =====================================================
// Edge rendering
// =====================================================
function renderEdge(edge) {
  document.getElementById('edge-' + edge.id)?.remove();
  const a = portCenter(edge.from.node, edge.from.port, 'out');
  const b = portCenter(edge.to.node, edge.to.port, 'in');
  if (!a || !b) return;

  // Группа: путь + кликабельная зона + кнопка × посередине (видна при hover)
  const grp = document.createElementNS(SVG_NS, 'g');
  grp.setAttribute('class', 'edge-group');
  grp.setAttribute('id', 'edge-' + edge.id);
  grp.dataset.id = edge.id;

  // Толстая невидимая «hit area», чтобы по связи легко было попасть курсором.
  const hit = document.createElementNS(SVG_NS, 'path');
  hit.setAttribute('class', 'edge-hit');
  hit.setAttribute('d', cubicPath(a, b));
  grp.appendChild(hit);

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('class', 'edge');
  path.setAttribute('d', cubicPath(a, b));
  grp.appendChild(path);

  // Кнопка × в середине.
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const del = document.createElementNS(SVG_NS, 'g');
  del.setAttribute('class', 'edge-delete');
  del.setAttribute('transform', `translate(${mid.x - 9} ${mid.y - 9})`);
  const delBg = document.createElementNS(SVG_NS, 'circle');
  delBg.setAttribute('cx', 9); delBg.setAttribute('cy', 9); delBg.setAttribute('r', 9);
  del.appendChild(delBg);
  const delIcon = document.createElementNS(SVG_NS, 'text');
  delIcon.setAttribute('x', 9); delIcon.setAttribute('y', 9);
  delIcon.setAttribute('text-anchor', 'middle');
  delIcon.setAttribute('dominant-baseline', 'central');
  delIcon.textContent = '\u2715';
  del.appendChild(delIcon);
  del.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    deleteEdge(edge.id);
  });
  grp.appendChild(del);

  els.edgesLayer.appendChild(grp);
}

function deleteEdge(edgeId) {
  state.edges = state.edges.filter((ed) => ed.id !== edgeId);
  document.getElementById('edge-' + edgeId)?.remove();
  markDirty();
}
function portCenter(nodeId, portId, dir) {
  const n = state.nodes.find((x) => x.id === nodeId);
  if (!n) return null;
  const def = NODE_TYPES[n.kind];
  const list = dir === 'out' ? def.outputs : def.inputs;
  const idx = list.findIndex((p) => p.id === portId);
  if (idx < 0) return null;
  const step = n.h / (list.length + 1);
  return { x: n.x + (dir === 'out' ? n.w : 0), y: n.y + step * (idx + 1) };
}
function cubicPath(a, b) {
  const dx = Math.max(Math.abs(b.x - a.x) * 0.5, 40);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function rerenderConnectedEdges(nodeId) {
  for (const e of state.edges) {
    if (e.from.node === nodeId || e.to.node === nodeId) renderEdge(e);
  }
}

// =====================================================
// Add / remove nodes
// =====================================================
function addNode(kind, worldX, worldY) {
  const def = NODE_TYPES[kind];
  if (!def) { showToast('Неизвестный тип узла: ' + kind, 'error'); return; }
  const w = def.defaultSize?.w || 280;
  const h = def.defaultSize?.h || 200;
  const node = {
    id: uid(),
    kind,
    x: worldX - w / 2, y: worldY - h / 2,
    w, h,
    data: structuredClone(def.defaultData || {}),
    runtime: null,
  };
  state.nodes.push(node);
  renderNode(node);
  markDirty();
  updateEmpty();
  return node;
}
function removeNode(id) {
  state.nodes = state.nodes.filter((n) => n.id !== id);
  state.edges = state.edges.filter((e) => e.from.node !== id && e.to.node !== id);
  document.getElementById('node-' + id)?.remove();
  els.edgesLayer.querySelectorAll('.edge-group').forEach((p) => {
    const e = state.edges.find((x) => x.id === p.dataset.id);
    if (!e) p.remove();
  });
  state.selection.delete(id);
  markDirty();
  updateEmpty();
}
function duplicateNode(id) {
  const src = state.nodes.find((n) => n.id === id);
  if (!src) return;
  const n = addNode(src.kind, src.x + src.w + 40 + src.w / 2, src.y + src.h / 2);
  n.data = structuredClone(src.data);
  document.getElementById('node-' + n.id)?.remove();
  renderNode(n);
}
function updateEmpty() {
  els.emptyAdd.hidden = state.nodes.length > 0;
}

// =====================================================
// Pan & zoom
// =====================================================
let panState = null;
els.svg.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.node') || e.target.closest('.port') ||
      e.target.closest('.edge-group')) return;
  panState = { sx: e.clientX, sy: e.clientY, vx: state.viewport.x, vy: state.viewport.y };
  els.svg.classList.add('grabbing');
  els.svg.setPointerCapture(e.pointerId);
  // Сбросим выделение при клике в пустоту.
  if (!e.shiftKey) clearSelection();
});
window.addEventListener('pointermove', (e) => {
  if (!panState) return;
  state.viewport.x = panState.vx + (e.clientX - panState.sx);
  state.viewport.y = panState.vy + (e.clientY - panState.sy);
  applyViewport();
});
window.addEventListener('pointerup', () => {
  panState = null;
  els.svg.classList.remove('grabbing');
});

els.wrap.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  } else {
    state.viewport.x -= e.deltaX;
    state.viewport.y -= e.deltaY;
    applyViewport();
  }
}, { passive: false });

function zoomAt(sx, sy, factor) {
  const before = screenToWorld(sx, sy);
  state.viewport.zoom = Math.max(0.2, Math.min(3, state.viewport.zoom * factor));
  applyViewport();
  const after = screenToWorld(sx, sy);
  state.viewport.x += (after.x - before.x) * state.viewport.zoom;
  state.viewport.y += (after.y - before.y) * state.viewport.zoom;
  applyViewport();
}

document.getElementById('btnZoomIn').addEventListener('click', () => {
  const r = els.svg.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.2);
});
document.getElementById('btnZoomOut').addEventListener('click', () => {
  const r = els.svg.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.2);
});
document.getElementById('btnFit').addEventListener('click', fitToView);

function fitToView() {
  if (!state.nodes.length) {
    state.viewport = { x: 0, y: 0, zoom: 1 };
    applyViewport();
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of state.nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
  }
  const pad = 60;
  const w = maxX - minX + pad * 2;
  const h = maxY - minY + pad * 2;
  const r = els.svg.getBoundingClientRect();
  const zoom = Math.min(r.width / w, r.height / h, 1);
  state.viewport.zoom = zoom;
  state.viewport.x = (r.width - w * zoom) / 2 - (minX - pad) * zoom;
  state.viewport.y = (r.height - h * zoom) / 2 - (minY - pad) * zoom;
  applyViewport();
}

// =====================================================
// Node drag
// =====================================================
let dragState = null;
els.nodesLayer.addEventListener('pointerdown', (e) => {
  const port = e.target.closest('.port');
  if (port) return startConnection(e, port);

  const g = e.target.closest('.node');
  if (!g) return;
  const id = g.dataset.id;
  const node = state.nodes.find((n) => n.id === id);
  if (!node) return;
  if (!state.selection.has(id) && !e.shiftKey) clearSelection();
  state.selection.add(id);
  refreshSelection();

  const start = screenToWorld(e.clientX, e.clientY);
  dragState = {
    pointerId: e.pointerId,
    startX: start.x, startY: start.y,
    nodes: [...state.selection].map((nid) => {
      const n = state.nodes.find((x) => x.id === nid);
      return { node: n, ox: n.x, oy: n.y };
    }),
  };
  els.nodesLayer.setPointerCapture(e.pointerId);
  g.classList.add('dragging');
});
window.addEventListener('pointermove', (e) => {
  if (!dragState) return;
  const cur = screenToWorld(e.clientX, e.clientY);
  const dx = cur.x - dragState.startX;
  const dy = cur.y - dragState.startY;
  for (const item of dragState.nodes) {
    item.node.x = item.ox + dx;
    item.node.y = item.oy + dy;
    document.getElementById('node-' + item.node.id)
      ?.setAttribute('transform', `translate(${item.node.x} ${item.node.y})`);
    rerenderConnectedEdges(item.node.id);
  }
});
window.addEventListener('pointerup', () => {
  if (!dragState) return;
  els.nodesLayer.querySelectorAll('.dragging').forEach((g) => g.classList.remove('dragging'));
  dragState = null;
  markDirty();
});

// =====================================================
// Selection
// =====================================================
function clearSelection() {
  state.selection.clear();
  refreshSelection();
}
function refreshSelection() {
  els.nodesLayer.querySelectorAll('.node').forEach((g) => {
    g.classList.toggle('selected', state.selection.has(g.dataset.id));
  });
}

// =====================================================
// Connections
// =====================================================
let connState = null;
function startConnection(e, portEl) {
  e.stopPropagation();
  const from = {
    node: portEl.dataset.node,
    port: portEl.dataset.port,
    dir:  portEl.dataset.dir,
    kind: portEl.dataset.kind,
  };
  // Соединять можно: out → in (обычное направление) или in → out (мы развернём).
  els.svg.classList.add('connecting');
  const ghost = document.createElementNS(SVG_NS, 'path');
  ghost.setAttribute('class', 'edge ghost');
  ghost.setAttribute('d', '');
  els.overlay.appendChild(ghost);
  // sx/sy запоминаем для click-vs-drag детекции в pointerup.
  connState = { from, ghost, sx: e.clientX, sy: e.clientY, moved: false };
  els.svg.setPointerCapture(e.pointerId);
}
/** Найти DOM-элемент порта под курсором (учитывает pointer-capture). */
function portUnder(clientX, clientY) {
  // При setPointerCapture e.target всегда совпадает с capture-элементом, а
  // не с реальным узлом DOM. Поэтому ищем элемент в координатах напрямую.
  const el = document.elementFromPoint(clientX, clientY);
  return el?.closest?.('.port') || null;
}

els.svg.addEventListener('pointermove', (e) => {
  if (!connState) return;
  const dx = e.clientX - connState.sx;
  const dy = e.clientY - connState.sy;
  if (dx * dx + dy * dy > 16) connState.moved = true;
  const a = portCenter(connState.from.node, connState.from.port, connState.from.dir);
  if (!a) return;
  const w = screenToWorld(e.clientX, e.clientY);
  connState.ghost.setAttribute('d', cubicPath(a, w));

  // Подсвечиваем совместимый порт под курсором.
  const cand = portUnder(e.clientX, e.clientY);
  document.querySelectorAll('.port.hot').forEach((p) => p.classList.remove('hot'));
  if (cand && cand.dataset.dir !== connState.from.dir &&
      cand.dataset.kind === connState.from.kind &&
      cand.dataset.node !== connState.from.node) {
    cand.classList.add('hot');
  }
});

els.svg.addEventListener('pointerup', (e) => {
  if (!connState) return;
  const target = portUnder(e.clientX, e.clientY);
  document.querySelectorAll('.port.hot').forEach((p) => p.classList.remove('hot'));

  // Чистый клик по input-порту image/video без drag → открываем
  // Media Manager и прикрепляем выбранный URL как референс к узлу.
  // Это поведение Magnific: «иконка фото = выбор референса».
  if (!connState.moved && connState.from.dir === 'in' &&
      ['image', 'video'].includes(connState.from.kind)) {
    const node = state.nodes.find((n) => n.id === connState.from.node);
    connState.ghost.remove();
    connState = null;
    els.svg.classList.remove('connecting');
    if (node) attachReferenceFor(node);
    return;
  }

  if (target && target.dataset.dir !== connState.from.dir) {
    const otherKind = target.dataset.kind;
    if (otherKind === connState.from.kind) {
      const a = connState.from;
      const b = {
        node: target.dataset.node, port: target.dataset.port,
        dir: target.dataset.dir, kind: otherKind,
      };
      const out = a.dir === 'out' ? a : b;
      const inp = a.dir === 'in' ? a : b;
      if (out.node === inp.node) {
        showToast('Нельзя соединять узел с самим собой', 'error');
      } else if (state.edges.some((ed) => ed.to.node === inp.node && ed.to.port === inp.port)) {
        showToast('Этот вход уже занят', 'error');
      } else {
        const edge = {
          id: uidEdge(),
          from: { node: out.node, port: out.port },
          to:   { node: inp.node, port: inp.port },
        };
        state.edges.push(edge);
        renderEdge(edge);
        markDirty();
      }
    } else {
      showToast(`Несовместимые типы (${connState.from.kind} → ${otherKind})`, 'error');
    }
  }
  connState.ghost.remove();
  connState = null;
  els.svg.classList.remove('connecting');
});

// Единый обработчик правого клика по канвасу:
//  - по узлу       → контекстное меню (Run / Preview / Duplicate / Delete)
//  - по связи      → удалить связь
//  - в пустую зону → открыть палитру в точке клика
// При клике по input/textarea внутри узла оставляем браузерное меню (paste и т.п.).
els.wrap.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input, textarea, [contenteditable]')) return;
  e.preventDefault();
  const node = e.target.closest('.node');
  const edge = e.target.closest('.edge-group');
  if (node) {
    ctxNodeId = node.dataset.id;
    els.ctx.style.left = e.clientX + 'px';
    els.ctx.style.top = e.clientY + 'px';
    els.ctx.hidden = false;
    return;
  }
  if (edge) {
    deleteEdge(edge.dataset.id);
    return;
  }
  openPalette(screenToWorld(e.clientX, e.clientY));
});

// =====================================================
// Palette
// =====================================================
let paletteSpawnPos = null; // mouse pos in world coords при открытии
function openPalette(worldPos) {
  paletteSpawnPos = worldPos || screenCenterWorld();
  els.palette.hidden = false;
  els.paletteSearch.value = '';
  filterPalette('');
  setTimeout(() => els.paletteSearch.focus(), 0);
}
function closePalette() {
  els.palette.hidden = true;
  paletteSpawnPos = null;
}
function filterPalette(q) {
  q = q.trim().toLowerCase();
  els.palette.querySelectorAll('.palette-item').forEach((b) => {
    const text = b.textContent.toLowerCase();
    b.style.display = !q || text.includes(q) ? '' : 'none';
  });
}
function screenCenterWorld() {
  const r = els.svg.getBoundingClientRect();
  return screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
}
els.paletteSearch.addEventListener('input', (e) => filterPalette(e.target.value));
els.palette.addEventListener('click', (e) => {
  const btn = e.target.closest('.palette-item');
  if (!btn) return;
  const kind = btn.dataset.add;
  addNode(kind, paletteSpawnPos?.x || 0, paletteSpawnPos?.y || 0);
  closePalette();
});
document.querySelectorAll('.rail-btn').forEach((b) => {
  b.addEventListener('click', () => {
    const c = screenCenterWorld();
    addNode(b.dataset.add, c.x, c.y);
  });
});
els.emptyAdd.addEventListener('click', () => openPalette());

// Двойной клик по пустоте — палитра
els.svg.addEventListener('dblclick', (e) => {
  if (e.target.closest('.node') || e.target.closest('.port')) return;
  openPalette(screenToWorld(e.clientX, e.clientY));
});

// =====================================================
// Context menu (правый клик по узлу)
// =====================================================
let ctxNodeId = null;
els.ctx.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (!ctxNodeId) return;
  if (act === 'delete') removeNode(ctxNodeId);
  else if (act === 'duplicate') duplicateNode(ctxNodeId);
  else if (act === 'run') {
    const n = state.nodes.find((x) => x.id === ctxNodeId);
    if (n) runNode(n);
  } else if (act === 'preview') {
    const n = state.nodes.find((x) => x.id === ctxNodeId);
    const url = n?.data?.resultUrl;
    if (url) window.open(url, '_blank');
    else showToast('Нет результата для предпросмотра');
  }
  els.ctx.hidden = true;
  ctxNodeId = null;
});
window.addEventListener('click', (e) => {
  if (!e.target.closest('.ctx')) els.ctx.hidden = true;
  if (!e.target.closest('.palette') && !e.target.closest('[data-add]') && !e.target.closest('.rail-btn')) {
    if (!els.palette.hidden) closePalette();
  }
});

// =====================================================
// Node execution
// =====================================================
/** Перерисовывает узел и его связи, сохраняя выделение. */
function rerenderNode(node) {
  renderNode(node);
  rerenderConnectedEdges(node.id);
}

/** Контекст, передаваемый в runner-функции. */
const runnerCtx = {
  state,
  rerenderNode,
  markDirty,
  toast: showToast,
};

async function runNode(node) {
  if (node.kind === 'assistant') return runAssistant(node, runnerCtx);
  if (node.kind === 'image')     return runImage(node, runnerCtx);
  if (node.kind === 'video')     return runVideo(node, runnerCtx);
  if (node.kind === 'upscale')   return runUpscale(node, runnerCtx);
  if (node.kind === 'audio')     return runAudio(node, runnerCtx);

  // Upload / Stock — это контейнеры данных, у них нет «запуска».
  if (['upload', 'stock'].includes(node.kind)) {
    showToast(NODE_TYPES[node.kind].title + ' — выбери файл/референс через медиа-менеджер');
    return;
  }
  showToast('Этот узел не запускается');
}

// =====================================================
// Keyboard
// =====================================================
window.addEventListener('keydown', (e) => {
  // Не перехватываем когда печатаем в поле узла.
  const isField = e.target.closest('input, textarea, [contenteditable]');
  if (isField) return;

  if (e.key === '+' || (e.key === '=' && !e.shiftKey === false)) {
    e.preventDefault(); openPalette();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selection.size) {
      e.preventDefault();
      [...state.selection].forEach(removeNode);
    }
  } else if (e.key === 'f' || e.key === 'F') {
    fitToView();
  } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveNow();
  } else if (e.key === 'Escape') {
    closePalette();
    clearSelection();
    els.ctx.hidden = true;
  }
});

// =====================================================
// Top-bar buttons
// =====================================================
document.getElementById('btnNew').addEventListener('click', async () => {
  if (state.dirty) await saveNow();
  const p = await api.createProject('Untitled space');
  await loadProject(p.id);
  showToast('Создан новый проект');
});
document.getElementById('btnRename').addEventListener('click', renameDialog);
els.projectTitle.addEventListener('click', renameDialog);
async function renameDialog() {
  const t = prompt('Название проекта:', state.title);
  if (!t || !t.trim() || t === state.title) return;
  state.title = t.trim();
  els.projectTitle.textContent = state.title;
  markDirty();
}

document.getElementById('btnProjects').addEventListener('click', toggleDrawer);
document.getElementById('drawerClose').addEventListener('click', () => (els.drawer.hidden = true));
async function toggleDrawer() {
  els.drawer.hidden = !els.drawer.hidden;
  if (!els.drawer.hidden) await refreshProjects();
}
async function refreshProjects() {
  const r = await api.listProjects();
  els.drawerList.innerHTML = '';
  for (const p of r.items) {
    const div = document.createElement('div');
    div.className = 'drawer-item' + (p.id === state.projectId ? ' active' : '');
    const ago = new Date(p.updatedAt).toLocaleString();
    div.innerHTML = `
      <div>
        <div>${escapeHtml(p.title)}</div>
        <div class="meta">${ago}</div>
      </div>
      <button class="btn btn-ghost" title="Удалить">✕</button>
    `;
    div.addEventListener('click', () => {
      els.drawer.hidden = true;
      loadProject(p.id);
    });
    div.querySelector('button').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Удалить проект «' + p.title + '»?')) return;
      await api.deleteProject(p.id);
      await refreshProjects();
      if (p.id === state.projectId) await bootstrapDefault();
    });
    els.drawerList.appendChild(div);
  }
}

document.getElementById('btnRun').addEventListener('click', () => {
  // Run from here: запускаем все узлы, у которых нет входов,
  // потом каскадом по графу. Реализуется в фазе 3+.
  showToast('Run появится в фазе 3 (Assistant) и далее');
});

// =====================================================
// Project lifecycle
// =====================================================
async function loadProject(id) {
  // Очистим текущее состояние
  state.nodes = []; state.edges = []; state.selection.clear();
  els.nodesLayer.innerHTML = '';
  els.edgesLayer.innerHTML = '';

  const p = await api.getProject(id);
  state.projectId = p.id;
  state.title = p.title || 'Untitled space';
  els.projectTitle.textContent = state.title;
  state.viewport = p.graph?.viewport || { x: 0, y: 0, zoom: 1 };
  applyViewport();

  for (const n of p.graph?.nodes || []) {
    state.nodes.push({ ...n, runtime: null });
    renderNode(state.nodes[state.nodes.length - 1]);
  }
  for (const e of p.graph?.edges || []) {
    state.edges.push(e);
    renderEdge(e);
  }
  state.dirty = false;
  setSaveStatus('saved');
  updateEmpty();
}

async function bootstrapDefault() {
  // Список проектов; если ничего нет — создаём пустой; иначе берём самый свежий.
  let r;
  try { r = await api.listProjects(); }
  catch (e) {
    if (e.status === 401) { window.location.href = '/login.html'; return; }
    throw e;
  }
  const id = r.items?.[0]?.id || (await api.createProject('Untitled space')).id;
  await loadProject(id);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// =====================================================
// Init
// =====================================================
applyViewport();
updateEmpty();
// Каталог моделей нужно загрузить ДО первого рендера ноды, иначе селекторы
// покажут весь зашитый список вместо реально доступного.
ensureCatalog()
  .then(() => bootstrapDefault())
  .catch((e) => {
    console.error('[media] bootstrap failed', e);
    showToast('Не удалось загрузить', 'error');
  });
