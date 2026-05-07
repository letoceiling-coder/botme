/**
 * Media Manager / Reference Picker — drawer с тремя колонками:
 *
 *   [sidebar]            [main grid]                       [filters + drop]
 *   Personal project       — May 2026 —                    Filters: type/aspect/model/date
 *     History              [thumb] [thumb] [thumb] ...     Drop or upload
 *     Uploads                                              [preview]
 *   All references                                         [Cancel] [Add]
 *     Stock
 *
 * UX повторяет Magnific «Creations». Открывается из любого узла:
 *   const url = await openAssetsDrawer({ kind: 'image' });
 *
 * Особенности:
 *  - В History показываем ОБА типа (image + video), даже если узел просит
 *    только image. Несовместимые карточки помечаются `.mm-card.disabled`
 *    и не выбираются — но видны (как у magnific.com).
 *  - Над гридом — фильтры в стиле magnific: TYPE / ASPECT / MODEL / DATE.
 *  - Drag&drop в правую панель загружает файлы через POST /api/media/uploads
 *    и сразу отображает их в Uploads.
 */

import { api } from './api.js';

let drawerEl = null;
let resolveCurrent = null;
let selectedItem = null;        // { url, kind, name, ... }
let activeTab = 'history';      // history | uploads | stock
let cache = { historyImage: null, historyVideo: null, uploads: null };
// Список карточек текущего таба — нужен для перерисовки фильтров.
let allItems = [];
let filters = { type: 'all', aspect: 'any', model: 'any', dateFrom: '', dateTo: '', q: '' };

// Какие типы ассетов сейчас можно ВЫБРАТЬ (определяется вызывающим узлом).
// Карточки несовместимых типов остаются видимыми, но dimmed и disabled,
// чтобы пользователь не мог прикрепить mp4 в фото-узел.
let allowedKinds = ['image'];

function ensureDrawer() {
  if (drawerEl) return drawerEl;
  drawerEl = document.createElement('aside');
  drawerEl.className = 'mm-drawer';
  drawerEl.hidden = true;
  drawerEl.innerHTML = `
    <aside class="mm-side">
      <div class="mm-side-title">Creations</div>
      <button class="mm-side-item active" data-tab="history">
        <span class="mm-icn">🕐</span><span>History</span>
      </button>
      <button class="mm-side-item" data-tab="historyVideo">
        <span class="mm-icn">▷</span><span>History · Video</span>
      </button>
      <button class="mm-side-item" data-tab="uploads">
        <span class="mm-icn">↑</span><span>Uploads</span>
      </button>

      <div class="mm-side-title">All references</div>
      <button class="mm-side-item" data-tab="stock">
        <span class="mm-icn">⬚</span><span>Stock</span>
      </button>
      <button class="mm-side-item" data-tab="style" disabled>
        <span class="mm-icn">🎨</span><span>Style</span><span class="mm-soon">soon</span>
      </button>
      <button class="mm-side-item" data-tab="character" disabled>
        <span class="mm-icn">👤</span><span>Character</span><span class="mm-soon">soon</span>
      </button>
      <button class="mm-side-item" data-tab="element" disabled>
        <span class="mm-icn">◆</span><span>Element</span><span class="mm-soon">soon</span>
      </button>
    </aside>

    <section class="mm-main">
      <header class="mm-head">
        <h2 class="mm-title">History</h2>
        <input type="search" class="mm-search" placeholder="Поиск по ассетам…">
        <button class="mm-filters-toggle" title="Фильтры" aria-pressed="false">⚙ Фильтры</button>
        <button class="mm-close" title="Закрыть (Esc)">✕</button>
      </header>
      <div class="mm-grid" id="mmGrid"></div>
    </section>

    <aside class="mm-right">
      <div class="mm-filters" id="mmFilters" hidden>
        <div class="mm-flt-group">
          <div class="mm-flt-label">DATE RANGE</div>
          <div class="mm-flt-row">
            <input type="date" class="mm-flt-date" data-flt="dateFrom">
            <span class="mm-flt-arrow">→</span>
            <input type="date" class="mm-flt-date" data-flt="dateTo">
          </div>
        </div>
        <div class="mm-flt-group">
          <div class="mm-flt-label">TYPE</div>
          <div class="mm-flt-chips" data-flt="type">
            <button class="mm-flt-chip active" data-val="all">Any</button>
            <button class="mm-flt-chip" data-val="image">Image</button>
            <button class="mm-flt-chip" data-val="video">Video</button>
          </div>
        </div>
        <div class="mm-flt-group">
          <div class="mm-flt-label">ASPECT RATIO</div>
          <div class="mm-flt-chips" data-flt="aspect">
            <button class="mm-flt-chip active" data-val="any">Any</button>
            <button class="mm-flt-chip" data-val="1:1">1:1</button>
            <button class="mm-flt-chip" data-val="4:3">4:3</button>
            <button class="mm-flt-chip" data-val="3:2">3:2</button>
            <button class="mm-flt-chip" data-val="16:9">16:9</button>
            <button class="mm-flt-chip" data-val="9:16">9:16</button>
          </div>
        </div>
        <div class="mm-flt-group">
          <div class="mm-flt-label">MODEL</div>
          <select class="mm-flt-select" data-flt="model">
            <option value="any">Any</option>
          </select>
        </div>
        <button class="mm-flt-clear" id="mmFltClear">Сбросить</button>
      </div>

      <div class="mm-drop" id="mmDrop">
        <div class="mm-drop-icon">⬆</div>
        <div class="mm-drop-text">
          Перетащи изображение или видео,<br>либо загрузи со своего устройства
        </div>
        <button class="btn btn-primary mm-upload-btn">Upload</button>
        <input type="file" multiple accept="image/*,video/*,audio/*" class="mm-file-input" hidden>
      </div>
      <div class="mm-preview" id="mmPreview">
        <div class="mm-preview-empty">Выберите ассет — здесь будет предпросмотр</div>
      </div>
      <div class="mm-actions">
        <button class="btn btn-ghost" id="mmCancel">Отмена</button>
        <button class="btn btn-primary" id="mmAdd" disabled>Add</button>
      </div>
    </aside>
  `;
  document.body.appendChild(drawerEl);
  bindDrawer();
  return drawerEl;
}

function bindDrawer() {
  drawerEl.querySelector('.mm-close').addEventListener('click', () => close(null));
  drawerEl.querySelector('#mmCancel').addEventListener('click', () => close(null));
  drawerEl.querySelector('#mmAdd').addEventListener('click', () => close(selectedItem?.url || null));

  // Ctrl/Meta + wheel внутри drawer не должен зумить страницу.
  drawerEl.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  }, { passive: false });

  drawerEl.querySelectorAll('.mm-side-item').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.disabled) return;
      switchTab(b.dataset.tab);
    });
  });

  drawerEl.querySelector('.mm-search').addEventListener('input', (e) => {
    filters.q = e.target.value;
    renderGrid(allItems);
  });

  // Toggle filters
  const fltPanel = drawerEl.querySelector('#mmFilters');
  drawerEl.querySelector('.mm-filters-toggle').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const next = fltPanel.hidden;
    fltPanel.hidden = !next;
    btn.setAttribute('aria-pressed', String(next));
  });

  // Filter chips
  drawerEl.querySelectorAll('.mm-flt-chips').forEach((row) => {
    row.addEventListener('click', (e) => {
      const chip = e.target.closest('.mm-flt-chip');
      if (!chip) return;
      const key = row.dataset.flt;
      filters[key] = chip.dataset.val;
      row.querySelectorAll('.mm-flt-chip').forEach((c) =>
        c.classList.toggle('active', c === chip)
      );
      renderGrid(allItems);
    });
  });

  // Filter inputs
  drawerEl.querySelectorAll('.mm-flt-date, .mm-flt-select').forEach((el) => {
    el.addEventListener('change', () => {
      filters[el.dataset.flt] = el.value;
      renderGrid(allItems);
    });
  });

  drawerEl.querySelector('#mmFltClear').addEventListener('click', () => {
    resetFilters();
    renderGrid(allItems);
  });

  // Upload-кнопка и drop-zone
  const drop = drawerEl.querySelector('#mmDrop');
  const fileInput = drawerEl.querySelector('.mm-file-input');
  drawerEl.querySelector('.mm-upload-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });
  drop.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) doUpload([...fileInput.files]);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hover'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hover'); })
  );
  drop.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) doUpload(files);
  });
}

function resetFilters() {
  filters = { type: 'all', aspect: 'any', model: 'any', dateFrom: '', dateTo: '', q: filters.q || '' };
  drawerEl.querySelectorAll('.mm-flt-chips').forEach((row) => {
    const def = row.dataset.flt === 'type' ? 'all' : 'any';
    row.querySelectorAll('.mm-flt-chip').forEach((c) =>
      c.classList.toggle('active', c.dataset.val === def)
    );
  });
  drawerEl.querySelectorAll('.mm-flt-date').forEach((el) => { el.value = ''; });
  const sel = drawerEl.querySelector('.mm-flt-select');
  if (sel) sel.value = 'any';
}

async function doUpload(files) {
  const drop = drawerEl.querySelector('#mmDrop');
  drop.classList.add('uploading');
  try {
    const r = await api.uploadFiles(files);
    cache.uploads = null;
    if (activeTab !== 'uploads') switchTab('uploads');
    else loadUploads();
    if (r.items?.length) {
      const last = r.items[r.items.length - 1];
      selectItem({ url: last.url, kind: last.kind, name: last.origName, mime: last.mime });
    }
  } catch (e) {
    drawerEl.querySelector('#mmGrid').innerHTML = `<div class="mm-empty error">Загрузка не удалась: ${escapeHtml(e.message)}</div>`;
  } finally {
    drop.classList.remove('uploading');
  }
}

function close(value) {
  drawerEl.hidden = true;
  selectedItem = null;
  if (resolveCurrent) {
    const r = resolveCurrent;
    resolveCurrent = null;
    r(value);
  }
}

function switchTab(tab) {
  activeTab = tab;
  drawerEl.querySelectorAll('.mm-side-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  drawerEl.querySelector('.mm-title').textContent =
    tab === 'history' ? 'History'
    : tab === 'historyVideo' ? 'History · Video'
    : tab === 'uploads' ? 'Uploads'
    : tab === 'stock' ? 'Stock'
    : tab.charAt(0).toUpperCase() + tab.slice(1);
  drawerEl.querySelector('.mm-search').value = '';
  filters.q = '';
  resetFilters();

  // Прячем фильтры на табах где они не нужны
  const fltToggle = drawerEl.querySelector('.mm-filters-toggle');
  const fltPanel  = drawerEl.querySelector('#mmFilters');
  const showFlt = tab === 'history' || tab === 'historyVideo' || tab === 'uploads';
  fltToggle.style.display = showFlt ? '' : 'none';
  fltPanel.hidden = true;
  fltToggle.setAttribute('aria-pressed', 'false');

  if (tab === 'history') loadHistory({ video: false });
  else if (tab === 'historyVideo') loadHistory({ video: true });
  else if (tab === 'uploads') loadUploads();
  else if (tab === 'stock') loadStock();
}

/**
 * Загружает History. Если video=true — показываем ТОЛЬКО видео, иначе
 * единое полотно: image + video (как у magnific «History»). allowedKinds
 * влияет только на возможность выбора, не на отображение.
 */
async function loadHistory({ video } = {}) {
  const grid = drawerEl.querySelector('#mmGrid');
  grid.innerHTML = `<div class="mm-empty">Загрузка…</div>`;
  try {
    const kindsToLoad = video ? ['video'] : ['image', 'video'];
    const items = [];
    for (const kind of kindsToLoad) {
      const cacheKey = kind === 'video' ? 'historyVideo' : 'historyImage';
      if (!cache[cacheKey]) {
        const r = await api.listAssets(kind);
        cache[cacheKey] = r.items || [];
      }
      for (const a of cache[cacheKey]) {
        items.push({
          url: a.resultUrl,
          thumb: a.resultUrl,
          kind,
          model: a.model || '',
          aspect: a.aspect || aspectFromSizeHint(a.size) || guessAspectByModel(a.model) || '',
          createdAt: a.createdAt ? new Date(a.createdAt) : null,
          title: a.projectTitle || 'Untitled',
          sub: a.model || a.kind,
          search: ((a.projectTitle || '') + ' ' + (a.model || '')).toLowerCase(),
        });
      }
    }
    items.sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
    allItems = items;
    refreshModelFilter(items);
    if (!items.length) {
      grid.innerHTML = `<div class="mm-empty">
        Пока пусто. Сгенерируй ${video ? 'видео' : 'фото или видео'}
        через узлы Media Studio — они появятся здесь автоматически.</div>`;
      return;
    }
    renderGrid(items);
  } catch (e) {
    grid.innerHTML = `<div class="mm-empty error">${escapeHtml(e.message)}</div>`;
  }
}

async function loadUploads() {
  const grid = drawerEl.querySelector('#mmGrid');
  grid.innerHTML = `<div class="mm-empty">Загрузка…</div>`;
  try {
    if (!cache.uploads) {
      const r = await api.listUploads();
      cache.uploads = r.items || [];
    }
    const items = cache.uploads.map((u) => ({
      url: u.url,
      thumb: u.url,
      kind: u.kind,
      mime: u.mime,
      model: '',
      aspect: '',
      createdAt: u.createdAt ? new Date(u.createdAt) : null,
      title: u.origName || u.filename,
      sub: u.kind,
      search: (u.origName || '').toLowerCase() + ' ' + (u.kind || ''),
      uploadId: u.id,
    }));
    items.sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
    allItems = items;
    refreshModelFilter([]);
    if (!items.length) {
      grid.innerHTML = `<div class="mm-empty">
        Uploads пуст. Перетащи фото или видео в правую панель → или нажми «Upload».</div>`;
      return;
    }
    renderGrid(items);
  } catch (e) {
    grid.innerHTML = `<div class="mm-empty error">${escapeHtml(e.message)}</div>`;
  }
}

function loadStock() {
  allItems = [];
  refreshModelFilter([]);
  drawerEl.querySelector('#mmGrid').innerHTML = `<div class="mm-empty">
    Стоковая библиотека (Pexels / Unsplash интеграция) — в Фазе 6+.</div>`;
}

/** Перестраивает <select data-flt="model"> из набора моделей в видимых ассетах. */
function refreshModelFilter(items) {
  const sel = drawerEl.querySelector('.mm-flt-select[data-flt="model"]');
  if (!sel) return;
  const cur = filters.model;
  const models = new Set();
  for (const it of items) if (it.model) models.add(it.model);
  sel.innerHTML = '<option value="any">Any</option>' +
    [...models].sort().map((m) => `<option value="${escapeAttr(m)}">${escapeHtml(m)}</option>`).join('');
  if (cur && [...models].includes(cur)) sel.value = cur;
  else { sel.value = 'any'; filters.model = 'any'; }
}

function passesFilters(it) {
  // Type
  if (filters.type !== 'all' && it.kind !== filters.type) return false;
  // Aspect
  if (filters.aspect !== 'any' && it.aspect !== filters.aspect) return false;
  // Model
  if (filters.model !== 'any' && it.model !== filters.model) return false;
  // Date
  if (filters.dateFrom) {
    const from = new Date(filters.dateFrom);
    if (it.createdAt && it.createdAt < from) return false;
  }
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    to.setHours(23, 59, 59, 999);
    if (it.createdAt && it.createdAt > to) return false;
  }
  // Search
  if (filters.q) {
    const q = filters.q.toLowerCase();
    if (!(it.search || '').includes(q)) return false;
  }
  return true;
}

function renderGrid(items) {
  const grid = drawerEl.querySelector('#mmGrid');
  grid.innerHTML = '';
  const visible = items.filter(passesFilters);
  if (!visible.length) {
    grid.innerHTML = `<div class="mm-empty">
      Под текущие фильтры ничего не найдено. Сбрось фильтры или измени запрос.</div>`;
    return;
  }

  // Группируем по году+месяцу, чтобы выглядело как в magnific.
  const groups = new Map();
  for (const it of visible) {
    const key = it.createdAt
      ? it.createdAt.toLocaleString('default', { month: 'long', year: 'numeric' })
      : 'Без даты';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  for (const [groupKey, list] of groups) {
    const groupTitle = document.createElement('div');
    groupTitle.className = 'mm-group';
    groupTitle.textContent = groupKey;
    grid.appendChild(groupTitle);

    const gridInner = document.createElement('div');
    gridInner.className = 'mm-grid-inner';
    for (const it of list) {
      const card = document.createElement('button');
      card.className = 'mm-card';
      card.dataset.search = it.search || '';
      const isVideo = it.kind === 'video' || (it.mime || '').startsWith('video/');
      const isAudio = it.kind === 'audio' || (it.mime || '').startsWith('audio/');
      // Несовместимые с allowedKinds — видны, но disabled, как у magnific.
      const disabled = !allowedKinds.includes(it.kind);
      if (disabled) card.classList.add('disabled');
      if (isVideo) {
        card.innerHTML = `
          <div class="mm-card-media">
            <video src="${escapeAttr(it.thumb)}" muted preload="metadata"></video>
            <span class="mm-badge">▷ video</span>
          </div>
          <div class="mm-card-meta"><span>${escapeHtml(it.title || '')}</span>${it.sub ? `<span class="mm-card-sub">${escapeHtml(it.sub)}</span>` : ''}</div>
        `;
      } else if (isAudio) {
        card.innerHTML = `
          <div class="mm-card-media mm-audio"><span>♪</span></div>
          <div class="mm-card-meta"><span>${escapeHtml(it.title || '')}</span></div>
        `;
      } else {
        card.innerHTML = `
          <div class="mm-card-media"><img loading="lazy" src="${escapeAttr(it.thumb)}" alt=""></div>
          <div class="mm-card-meta">
            <span>${escapeHtml(it.title || '')}</span>
            ${it.sub ? `<span class="mm-card-sub">${escapeHtml(it.sub)}</span>` : ''}
          </div>
        `;
      }
      if (disabled) {
        card.title = `Несовместимый тип (${it.kind}). Открой Media Manager из ${it.kind}-узла.`;
        card.addEventListener('click', (e) => e.preventDefault());
      } else {
        card.addEventListener('click', () => selectItem(it, card));
      }
      if (it.uploadId) {
        const del = document.createElement('button');
        del.className = 'mm-card-del';
        del.title = 'Удалить';
        del.textContent = '×';
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm('Удалить файл из Uploads?')) return;
          await api.deleteUpload(it.uploadId);
          cache.uploads = null;
          loadUploads();
        });
        card.appendChild(del);
      }
      gridInner.appendChild(card);
    }
    grid.appendChild(gridInner);
  }
}

function selectItem(it, cardEl) {
  selectedItem = it;
  drawerEl.querySelectorAll('.mm-card.selected').forEach((c) => c.classList.remove('selected'));
  if (cardEl) cardEl.classList.add('selected');

  const preview = drawerEl.querySelector('#mmPreview');
  if (it.kind === 'video' || (it.mime || '').startsWith('video/')) {
    preview.innerHTML = `<video src="${escapeAttr(it.url)}" controls preload="metadata"></video>`;
  } else if (it.kind === 'audio' || (it.mime || '').startsWith('audio/')) {
    preview.innerHTML = `<audio src="${escapeAttr(it.url)}" controls></audio>`;
  } else {
    preview.innerHTML = `<img src="${escapeAttr(it.url)}" alt="">`;
  }
  drawerEl.querySelector('#mmAdd').disabled = false;
}

/** Преобразует "1024x1536" → "2:3" (приближённо). */
function aspectFromSizeHint(size) {
  if (!size) return '';
  const m = String(size).match(/^(\d+)x(\d+)$/);
  if (!m) return '';
  const w = +m[1], h = +m[2];
  if (!w || !h) return '';
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}
function gcd(a, b) { return b ? gcd(b, a % b) : a; }
/** Эвристика для legacy-записей без сохранённого aspect. */
function guessAspectByModel() { return ''; }

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

document.addEventListener('keydown', (e) => {
  if (drawerEl && !drawerEl.hidden && e.key === 'Escape') close(null);
});

/**
 * Открывает media manager.
 *   kinds — список разрешённых типов ассетов ('image' | 'video' | 'audio')
 *   title — заголовок (необязательно)
 * Возвращает выбранный URL или null (отмена).
 */
export function openAssetsDrawer({ kinds = ['image'], kind, title } = {}) {
  if (kind && !kinds) kinds = [kind];
  allowedKinds = Array.isArray(kinds) && kinds.length ? kinds : ['image'];

  ensureDrawer();
  drawerEl.hidden = false;
  selectedItem = null;
  cache = { historyImage: null, historyVideo: null, uploads: null };
  resetFilters();

  // Адаптируем accept у скрытого input под разрешённые типы.
  const accept = allowedKinds.map((k) =>
    k === 'image' ? 'image/*' : k === 'video' ? 'video/*' : k === 'audio' ? 'audio/*' : ''
  ).filter(Boolean).join(',');
  drawerEl.querySelector('.mm-file-input').setAttribute('accept', accept || '*/*');

  // Подсказка drop-zone сообщает что ожидается.
  const dropText = drawerEl.querySelector('.mm-drop-text');
  if (allowedKinds.length === 1 && allowedKinds[0] === 'image') {
    dropText.innerHTML = 'Перетащи изображение,<br>либо загрузи со своего устройства';
  } else if (allowedKinds.length === 1 && allowedKinds[0] === 'video') {
    dropText.innerHTML = 'Перетащи видео,<br>либо загрузи со своего устройства';
  } else {
    dropText.innerHTML = 'Перетащи изображение или видео,<br>либо загрузи со своего устройства';
  }

  drawerEl.querySelector('#mmAdd').disabled = true;
  drawerEl.querySelector('#mmPreview').innerHTML =
    '<div class="mm-preview-empty">Выберите ассет — здесь будет предпросмотр</div>';

  // Если узел просит ТОЛЬКО видео — открываем сразу таб History · Video,
  // иначе — общий History (с image+video).
  const initialTab = (allowedKinds.length === 1 && allowedKinds[0] === 'video')
    ? 'historyVideo' : 'history';
  switchTab(initialTab);
  if (title) drawerEl.querySelector('.mm-title').textContent = title;

  return new Promise((resolve) => { resolveCurrent = resolve; });
}
