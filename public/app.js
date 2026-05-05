// =============================================================
// AI Site Builder — frontend
// =============================================================

const $ = (sel) => document.querySelector(sel);

const els = {
  modelSelect: $('#modelSelect'),
  modelHint: $('#modelHint'),
  projectList: $('#projectList'),
  newChatBtn: $('#newChatBtn'),
  chatTitle: $('#chatTitle'),
  chatSub: $('#chatSub'),
  messages: $('#messages'),
  chatForm: $('#chatForm'),
  prompt: $('#prompt'),
  sendBtn: $('#sendBtn'),
  improveBtn: $('#improveBtn'),
  status: $('#status'),
  preview: $('#preview'),
  previewEmpty: $('#previewEmpty'),
  previewUrl: $('#previewUrl'),
  pageSelect: $('#pageSelect'),
  filesBadge: $('#filesBadge'),
  reloadPreview: $('#reloadPreview'),
  openPreviewBtn: $('#openPreviewBtn'),
  downloadHtml: $('#downloadHtml'),
  quickPrompts: $('#quickPrompts'),
  statsBtn: $('#statsBtn'),
  statsModal: $('#statsModal'),
  statsBody: $('#statsBody'),
  closeStatsBtn: $('#closeStatsBtn'),
  resetStatsBtn: $('#resetStatsBtn'),
};

const QUICK_PROMPTS = [
  { label: '🏠 Лендинг', text: 'Премиум лендинг для натяжных потолков в Воронеже. Цвета: чёрный + золотой. Блоки: hero с фоновым фото интерьера и заголовком «Натяжные потолки под ключ за 1 день», 4 быстрых преимущества, интерактивный калькулятор (площадь × тип), галерея работ (минимум 6 фото), 4 преимущества, услуги (5 карточек), как мы работаем (4 шага), отзывы с фото клиентов и звёздами, акция со срочностью, форма заявки, контакты с телефоном и WhatsApp. Sticky-меню, плавные AOS-анимации, hover-эффекты на всех карточках, адаптив.' },
  { label: '☕ Кофейня',  text: 'Премиум сайт для уютной кофейни «Bean & Co». Тёплая палитра (кремовый, кофейный, охра). Hero с большим фото латте-арта, секция меню (минимум 8 позиций с фото и ценами), наша история, фотогалерея интерьера, отзывы посетителей с аватарками, форма брони столика, карта и контакты. Шрифт Playfair для заголовков. Анимации, hover-эффекты, адаптив.' },
  { label: '🎮 Игра «Змейка»', text: 'Браузерная игра «Змейка» на canvas. Премиум-обёртка вокруг игры (тёмная тема, неоновый акцент). Главное меню, выбор скорости, счёт текущий и рекорд (localStorage), Game Over с рестартом. Управление WASD/стрелками + свайпы на мобильном. Плавные анимации, эффект свечения еды и головы, частицы при поедании.' },
  { label: '🚀 SaaS',    text: 'SaaS-лендинг в стиле Linear/Vercel: тёмная тема, фиолетово-циановый градиент, анимированный фон с blob и сеткой. Hero с большим градиентным заголовком и кнопкой CTA, скриншот мокап продукта, секция фич (6 карточек с lucide-иконками), как это работает (3 шага), цены (3 тарифа со сравнением), FAQ-аккордеон, CTA внизу. Все блоки с AOS-анимациями.' },
  { label: '🎨 Портфолио', text: 'Премиум портфолио для UI/UX дизайнера. Тёмная тема с акцентом #ff5e5e. Hero с большим именем и анимированной строкой профессий (typed.js), секция «обо мне», галерея работ (mansory grid из реальных фото с hover-overlay), услуги, отзывы клиентов, форма связи. Плавный smooth-scroll, parallax, AOS-анимации.' },
];

const state = {
  models: [],
  projects: [],
  currentId: null,        // ID активного проекта на сервере (или null)
  currentMessages: [],    // сообщения активного проекта
  hasHtml: false,
  busy: false,
  files: [],              // список файлов текущего проекта
  currentPage: 'index.html', // активная страница в превью
};

/** Подсказки в пузырьке ожидания — меняются со временем (генерация может идти долго). */
const GENERATION_WAIT_HINTS = [
  'Модель генерирует код и разметку — первые собранные файлы часто появляются не сразу.',
  'Большие сайты и игры могут занимать несколько минут: это нормально для качественного результата.',
  'Запрос выполняется на сервере; вкладку можно не закрывать — ответ придёт одним блоком.',
  'Если провайдер LLM перегружен, ожидание может затягиваться; соединение не оборвано, пока виден таймер.',
];

const IMPROVE_WAIT_HINTS = [
  'Модель переписывает промпт в более детальный вариант…',
  'Уточняются формулировки и структура задачи для генератора…',
];

let statusTickerId = null;

function clearStatusTicker() {
  if (statusTickerId !== null) {
    clearInterval(statusTickerId);
    statusTickerId = null;
  }
}

function formatMmSs(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function removeAssistantLoadingBubble(el) {
  if (!el) return;
  if (el._waitTicker) {
    clearInterval(el._waitTicker);
    el._waitTicker = null;
  }
  el.remove();
}

// =============================================================
// API helpers
// =============================================================
async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!r.ok) {
    let payload = null;
    try { payload = await r.clone().json(); } catch { /* not json */ }
    const message = payload?.error || (await r.text().catch(() => `${r.status} ${r.statusText}`));
    const err = new Error(message || `${r.status} ${r.statusText}`);
    err.status = r.status;
    err.code = payload?.code || null;
    err.errors = payload?.errors;
    err.suggestedAlternatives = payload?.suggestedAlternatives;
    throw err;
  }
  return r.json();
}

const ERROR_KIND_RU = {
  auth: 'Ключ API провайдера не настроен или недействителен. Это решается в .env на сервере.',
  quota: 'Закончился баланс или квота у провайдера. Пополните баланс или выберите другую модель.',
  rate_limit: 'Превышен лимит запросов в минуту у провайдера. Попробуйте через 30–60 секунд или выберите другую модель.',
  overloaded: 'Сервис провайдера перегружен. Попробуйте ещё раз или выберите другую модель.',
  bad_request: 'Провайдер отклонил запрос. Попробуйте упростить промпт или сменить модель.',
  not_found: 'Эта модель сейчас недоступна у провайдера. Выберите другую из списка.',
  context_overflow: 'Запрос слишком большой для модели. Сократите контекст или выберите модель с большим окном.',
  content_filter: 'Запрос отклонён фильтром безопасности. Переформулируйте идею.',
  network: 'Сетевая ошибка между сервером и провайдером. Повторите попытку.',
  timeout: 'Модель не успела ответить за отведённое время. Повторите попытку или выберите более быструю модель.',
  aborted: 'Запрос был отменён.',
  no_models: 'Не настроен ни один ключ провайдера на сервере (.env: ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY).',
  unknown: 'Произошла ошибка при обращении к модели.',
};

function buildErrorBubble(err, primaryModel) {
  const code = err?.code || 'unknown';
  const explain = ERROR_KIND_RU[code] || ERROR_KIND_RU.unknown;
  const trail = Array.isArray(err?.errors) && err.errors.length
    ? err.errors.slice(-3).map((it) =>
        `• ${escapeHtml(it.model || '?')}${it.status ? ` [${it.status}]` : ''}: ${escapeHtml((it.message || it.raw || it.kind || '').toString().slice(0, 220))}`,
      ).join('<br>')
    : '';
  const alts = Array.isArray(err?.suggestedAlternatives) ? err.suggestedAlternatives : [];
  const altButtons = alts.length
    ? alts.slice(0, 3).map((a) =>
        `<button type="button" class="alt-model-btn px-2.5 py-1.5 rounded-md bg-panel border border-border hover:border-brand/50 text-xs" data-model="${escapeHtml(a.id)}">${escapeHtml(a.label || a.id)}</button>`
      ).join('')
    : '';

  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';
  wrap.innerHTML = `
    <div class="avatar avatar-ai">!</div>
    <div class="bubble" style="border-color: rgba(239,68,68,0.45);">
      <div class="text-sm font-semibold text-err">Не удалось получить ответ от модели</div>
      <div class="text-xs text-text/90 mt-1.5">${escapeHtml(explain)}</div>
      ${trail ? `<div class="text-[11px] text-muted mt-2 leading-relaxed">${trail}</div>` : ''}
      <div class="flex flex-wrap gap-2 mt-3">
        <button type="button" class="retry-prompt-btn px-2.5 py-1.5 rounded-md bg-gradient-to-r from-brand to-brand2 text-white text-xs">
          ↻ Повторить
        </button>
        ${altButtons}
      </div>
      ${primaryModel ? `<div class="text-[11px] text-muted mt-2">Запрос был к: <span class="text-text/90">${escapeHtml(primaryModel)}</span></div>` : ''}
    </div>`;
  els.messages.appendChild(wrap);
  els.messages.scrollTop = els.messages.scrollHeight;

  wrap.querySelector('.retry-prompt-btn')?.addEventListener('click', () => {
    if (state.busy) return;
    sendPrompt();
  });
  wrap.querySelectorAll('.alt-model-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.model;
      if (id) {
        els.modelSelect.value = id;
        flashStatus(`Переключил модель на ${id}`, 'loading');
        if (!state.busy) sendPrompt();
      }
    });
  });
  return wrap;
}

// =============================================================
// Init
// =============================================================
async function init() {
  await loadModels();
  await loadProjects();
  renderQuickPrompts();
  newChat();
  bindEvents();
}

function renderQuickPrompts() {
  if (!els.quickPrompts) return;
  els.quickPrompts.innerHTML = '';
  for (const q of QUICK_PROMPTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'text-[11px] px-2 py-1 rounded-md bg-panel border border-border text-muted hover:text-text hover:border-brand/50 transition';
    b.textContent = q.label;
    b.title = q.text.slice(0, 200) + '…';
    b.onclick = () => {
      els.prompt.value = q.text;
      els.prompt.focus();
    };
    els.quickPrompts.appendChild(b);
  }
}

async function loadModels() {
  const models = await api('/api/models');
  state.models = models;
  els.modelSelect.innerHTML = '';
  const groups = {};
  for (const m of models) {
    (groups[m.provider] ||= []).push(m);
  }
  const labels = {
    ollama: 'Ollama (локально, qwen)',
    openai: 'OpenAI',
    claude: 'Anthropic Claude',
    gemini: 'Google Gemini',
    openrouter: 'OpenRouter (tools)',
  };
  const order = ['ollama', 'openai', 'claude', 'gemini', 'openrouter'];
  const keys = Object.keys(groups).sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  for (const provider of keys) {
    const og = document.createElement('optgroup');
    og.label = labels[provider] || provider;
    for (const m of groups[provider]) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      og.appendChild(opt);
    }
    els.modelSelect.appendChild(og);
  }
  // По умолчанию — Claude Sonnet 4.6 (лучше всего справляется с премиум-дизайном).
  // Если её нет в списке — упадём на любой Claude, потом на OpenAI, иначе — qwen.
  const preferred = ['claude:claude-sonnet-4-6', 'claude:claude-sonnet-4-5-20250929', 'openai:gpt-5.4', 'openai:gpt-4.1-mini', 'ollama:qwen2.5-coder:7b'];
  const ids = new Set(state.models.map((m) => m.id));
  els.modelSelect.value = preferred.find((id) => ids.has(id)) || state.models[0]?.id;
  updateModelHint();
}

function updateModelHint() {
  const id = els.modelSelect.value;
  const m = state.models.find((x) => x.id === id);
  if (!m) return;
  if (m.provider === 'openrouter') {
    const freeNote = m.free ? '🆓 Бесплатная по тарифам OpenRouter · ' : '';
    const keyNote = m.needsOpenRouterKey
      ? '⚠ На сервере не задан OPENROUTER_API_KEY в .env или процесс не перезапущен. '
      : '';
    els.modelHint.textContent = `${keyNote}${freeNote}Маршрутизация через OpenRouter (поддержка tools).`;
    return;
  }
  const tips = {
    'ollama:qwen2.5-coder:7b': '⚠ Маленькая модель — для простых страниц и прототипов. Для премиум-лендингов выбирай Claude Sonnet 4.6 или GPT-5.4.',
    'ollama:llama3:latest':    '⚠ Общая модель, не лучший выбор для UI. Лучше Claude/GPT для дизайна.',
    'openai:gpt-5.4':          '⭐ Топ для премиум-сайтов и сложного кода.',
    'openai:gpt-5.4-mini':     'Хороший баланс цена/качество.',
    'openai:gpt-5.1-codex':    'Заточена под код. Отлично для игр на canvas.',
    'openai:gpt-4.1-mini':     'Лёгкая и быстрая. Подходит для итераций.',
    'openai:gpt-4o':           'Стабильная классика.',
    'claude:claude-sonnet-4-6':          '⭐ Лучший выбор для красивых премиум-лендингов.',
    'claude:claude-sonnet-4-5-20250929': 'Сильна в дизайне и длинном коде.',
    'claude:claude-haiku-4-5-20251001':  'Быстрая, для быстрых правок.',
    'claude:claude-opus-4-7':            '⭐⭐ Самый мощный — для сложных проектов.',
  };
  els.modelHint.textContent = tips[id] || `Провайдер: ${m.provider}`;
}

async function loadProjects() {
  state.projects = await api('/api/projects');
  renderProjectList();
}

// Сводка по моделям: цвет точки и короткое имя для значка в списке проектов
const PROVIDER_DOT = {
  claude: '#d97706',  // янтарный
  openai: '#10a37f',  // зелёный
  gemini: '#4285f4',  // синий Google
  ollama: '#a78bfa',  // фиолетовый
  openrouter: '#f97316', // оранжевый OpenRouter
};

function modelShortName(modelId) {
  if (!modelId) return '—';
  // Сначала пробуем взять "красивое" имя из каталога моделей (до тире/скобок)
  const m = state.models.find((x) => x.id === modelId);
  if (m && m.label) return m.label.split(/\s+[—–-]\s+|\s*\(/)[0].trim();
  // Иначе — последняя часть после ":" с человеческой формой
  const tail = modelId.split(':').slice(1).join(':');
  return tail.replace(/^gpt-/i, 'GPT-').replace(/^claude-/i, 'Claude ');
}

function providerOf(modelId) {
  return (modelId || '').split(':')[0];
}

function renderProjectList() {
  const list = state.projects;
  if (!list.length) {
    els.projectList.innerHTML = `<div class="text-xs text-muted px-3 py-4 text-center">Пока пусто</div>`;
    return;
  }
  els.projectList.innerHTML = '';
  for (const p of list) {
    const provider = providerOf(p.model);
    const dotColor = PROVIDER_DOT[provider] || '#6b7280';
    const short = modelShortName(p.model);
    const tokens = p.usage?.total ? formatTokens(p.usage.total) : '';
    const calls = p.usage?.calls || 0;

    const row = document.createElement('div');
    row.className = 'proj-item' + (p.id === state.currentId ? ' active' : '');
    row.innerHTML = `
      <div class="proj-main">
        <div class="proj-title" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</div>
        <div class="proj-meta">
          <span class="proj-dot" style="background:${dotColor}"></span>
          <span class="proj-model" title="${escapeHtml(p.model || '')}">${escapeHtml(short)}</span>
          ${tokens ? `<span class="proj-tokens" title="${calls} вызов(ов), ${(p.usage.total || 0).toLocaleString('ru-RU')} токенов">· ${tokens}</span>` : ''}
        </div>
      </div>
      <span class="proj-del" title="Удалить">✕</span>
    `;
    row.querySelector('.proj-main').onclick = () => openProject(p.id);
    row.querySelector('.proj-del').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Удалить проект «${p.title}»?`)) return;
      await api(`/api/projects/${p.id}`, { method: 'DELETE' });
      if (state.currentId === p.id) newChat();
      await loadProjects();
    };
    els.projectList.appendChild(row);
  }
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}

async function openProject(id) {
  const p = await api(`/api/projects/${id}`);
  state.currentId = p.id;
  state.currentMessages = p.messages || [];
  state.hasHtml = !!p.hasHtml;
  state.currentPage = 'index.html';
  if (p.model) {
    els.modelSelect.value = p.model;
    updateModelHint();
  }
  els.chatTitle.textContent = p.title || 'Проект';
  const u = p.usage || { calls: 0, total: 0 };
  const filesNote = (p.files && p.files.length > 1) ? ` • ${p.files.length} файлов` : '';
  els.chatSub.textContent = `id: ${p.id.slice(0, 8)} • обновлён ${formatDate(p.updatedAt)} • ${u.calls} вызовов, ${(u.total || 0).toLocaleString('ru-RU')} токенов${filesNote}`;
  renderMessages();
  if (p.hasHtml) showPreview(p.id, p.files || ['index.html']);
  else hidePreview();
  renderProjectList();
}

function newChat() {
  state.currentId = null;
  state.currentMessages = [];
  state.hasHtml = false;
  els.chatTitle.textContent = 'Новый проект';
  els.chatSub.textContent = 'Опиши, что построить';
  els.messages.innerHTML = `
    <div class="text-center text-sm text-muted py-8">
      Опиши идею сайта или игры, и агент создаст рабочий HTML-файл.<br>
      <span class="text-text/70">Например:</span> «3D-крутилка планеты на three.js с подписями»
    </div>`;
  hidePreview();
  renderProjectList();
}

// =============================================================
// Messages
// =============================================================
function renderMessages() {
  els.messages.innerHTML = '';
  for (const m of state.currentMessages) {
    addMessageToDOM(m.role, m.content);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

function addMessageToDOM(role, content) {
  const wrap = document.createElement('div');
  wrap.className = `msg msg-${role}`;
  if (role === 'assistant') {
    wrap.innerHTML = `
      <div class="avatar avatar-ai">AI</div>
      <div class="bubble">${formatContent(content)}</div>`;
  } else {
    wrap.innerHTML = `<div class="bubble">${formatContent(content)}</div>`;
  }
  els.messages.appendChild(wrap);
  els.messages.scrollTop = els.messages.scrollHeight;
  return wrap;
}

function addLoadingMessage(hints = GENERATION_WAIT_HINTS) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';
  wrap.innerHTML = `
    <div class="avatar avatar-ai">AI</div>
    <div class="bubble loading-bubble">
      <div class="typing"><span></span><span></span><span></span></div>
      <div class="text-sm text-text/95 mt-2 font-medium">Генерация ответа модели…</div>
      <div class="loading-hint text-xs text-muted mt-2 leading-relaxed"></div>
      <div class="loading-elapsed text-[11px] text-muted/85 mt-1.5 tabular-nums"></div>
    </div>`;
  const hintEl = wrap.querySelector('.loading-hint');
  const elapsedEl = wrap.querySelector('.loading-elapsed');
  const t0 = Date.now();
  const stepMs = 26000;
  const tick = () => {
    const sec = Math.floor((Date.now() - t0) / 1000);
    const idx = Math.min(Math.floor(sec / (stepMs / 1000)), hints.length - 1);
    hintEl.textContent = hints[idx];
    elapsedEl.textContent = `Прошло ${formatMmSs(sec)} · запрос обрабатывается, страница не зависла`;
  };
  tick();
  wrap._waitTicker = setInterval(tick, 1000);
  els.messages.appendChild(wrap);
  els.messages.scrollTop = els.messages.scrollHeight;
  return wrap;
}

function formatContent(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

// =============================================================
// Preview (с поддержкой многостраничных проектов)
// =============================================================
function showPreview(id, files = state.files, page = state.currentPage || 'index.html') {
  state.files = files || [];
  // Если запрошенной страницы нет — fallback на index.html
  if (!state.files.includes(page)) page = 'index.html';
  state.currentPage = page;

  const url = `/preview/${id}/${page}?t=${Date.now()}`;
  els.preview.src = url;
  els.preview.classList.remove('hidden');
  els.previewEmpty.classList.add('hidden');
  els.previewUrl.textContent = `/preview/${id}/${page === 'index.html' ? '' : page}`;
  els.openPreviewBtn.classList.remove('hidden');
  els.downloadHtml.classList.remove('hidden');
  state.hasHtml = true;

  // Селектор страниц: показываем только если HTML-страниц > 1
  const htmlPages = state.files.filter((f) => /\.html?$/i.test(f));
  if (htmlPages.length > 1) {
    els.pageSelect.classList.remove('hidden');
    els.pageSelect.innerHTML = htmlPages
      .sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)))
      .map((f) => `<option value="${escapeHtml(f)}" ${f === page ? 'selected' : ''}>${escapeHtml(f)}</option>`)
      .join('');
  } else {
    els.pageSelect.classList.add('hidden');
  }

  // Бейдж с числом файлов
  if (state.files.length > 1) {
    els.filesBadge.classList.remove('hidden');
    els.filesBadge.textContent = `${state.files.length} файлов`;
    els.filesBadge.title = state.files.join('\n');
    els.downloadHtml.textContent = '⬇ Скачать .zip';
  } else {
    els.filesBadge.classList.add('hidden');
    els.downloadHtml.textContent = '⬇ Скачать .html';
  }
}

function hidePreview() {
  els.preview.src = 'about:blank';
  els.preview.classList.add('hidden');
  els.previewEmpty.classList.remove('hidden');
  els.previewUrl.textContent = 'preview';
  els.openPreviewBtn.classList.add('hidden');
  els.downloadHtml.classList.add('hidden');
  els.pageSelect.classList.add('hidden');
  els.filesBadge.classList.add('hidden');
  state.hasHtml = false;
  state.files = [];
  state.currentPage = 'index.html';
}

// =============================================================
// Send prompt
// =============================================================
async function sendPrompt(prefilledPrompt) {
  if (state.busy) return;
  // Если повторяем после ошибки — берём последний user-промпт.
  let prompt;
  if (typeof prefilledPrompt === 'string' && prefilledPrompt.trim()) {
    prompt = prefilledPrompt.trim();
  } else if (els.prompt.value.trim()) {
    prompt = els.prompt.value.trim();
  } else {
    const lastUser = [...state.currentMessages].reverse().find((m) => m.role === 'user');
    prompt = lastUser?.content || '';
  }
  if (!prompt) return;
  const model = els.modelSelect.value;

  state.busy = true;
  els.sendBtn.disabled = true;

  const genStarted = Date.now();
  clearStatusTicker();
  const tickGenStatus = () => {
    const sec = Math.floor((Date.now() - genStarted) / 1000);
    els.status.innerHTML =
      `<span class="dot loading"></span><span>${escapeHtml(model)} · генерация · ${formatMmSs(sec)} · подождите</span>`;
  };
  tickGenStatus();
  statusTickerId = setInterval(tickGenStatus, 1000);

  // Сразу отрисовываем сообщение пользователя + индикатор загрузки.
  // При повторе того же промпта — не дублируем user-сообщение.
  if (state.currentMessages.length === 0) els.messages.innerHTML = '';
  const lastUser = [...state.currentMessages].reverse().find((m) => m.role === 'user');
  if (!lastUser || lastUser.content !== prompt) {
    state.currentMessages.push({ role: 'user', content: prompt });
    addMessageToDOM('user', prompt);
  }
  els.prompt.value = '';
  const loadingEl = addLoadingMessage(GENERATION_WAIT_HINTS);

  try {
    const res = await api('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        projectId: state.currentId,
        prompt,
        model,
      }),
    });
    removeAssistantLoadingBubble(loadingEl);
    state.currentId = res.id;
    state.currentMessages.push({ role: 'assistant', content: res.assistant });
    addMessageToDOM('assistant', res.assistant);
    els.chatTitle.textContent = res.title;
    const pu = res.projectUsage || { calls: 0, total: 0 };
    const filesNote = (res.files && res.files.length > 1) ? ` • ${res.files.length} файлов` : '';
    els.chatSub.textContent = `id: ${res.id.slice(0, 8)} • ${res.modelUsed || res.model} • ${pu.calls} вызовов, ${pu.total.toLocaleString('ru-RU')} токенов${filesNote}`;
    if (res.hasHtml) showPreview(res.id, res.files || ['index.html']);
    await loadProjects();
    const fb = res.fallbackFrom ? ` (fallback с ${res.fallbackFrom})` : '';
    els.status.innerHTML = `<span class="dot"></span>готово • ${res.usage.total} токенов${fb}`;
  } catch (e) {
    removeAssistantLoadingBubble(loadingEl);
    buildErrorBubble(e, model);
    const code = e?.code || 'error';
    els.status.innerHTML = `<span class="dot err"></span>${escapeHtml(code)} · попробуйте повторить или сменить модель`;
  } finally {
    clearStatusTicker();
    state.busy = false;
    els.sendBtn.disabled = false;
  }
}

// =============================================================
// Improve prompt — переписывает текст в textarea детальной премиум-версией
// =============================================================
async function improvePrompt() {
  if (state.busy) return;
  const raw = els.prompt.value.trim();
  if (!raw) {
    flashStatus('Сначала впиши идею в поле', 'err');
    return;
  }
  state.busy = true;
  els.improveBtn.disabled = true;
  els.sendBtn.disabled = true;
  const oldText = els.improveBtn.textContent;
  const impStarted = Date.now();
  clearStatusTicker();
  const tickImprove = () => {
    const sec = Math.floor((Date.now() - impStarted) / 1000);
    const hi = IMPROVE_WAIT_HINTS[Math.min(Math.floor(sec / 18), IMPROVE_WAIT_HINTS.length - 1)];
    els.status.innerHTML =
      `<span class="dot loading"></span><span>${escapeHtml(hi)} · ${formatMmSs(sec)}</span>`;
    els.improveBtn.textContent = `⏳ Улучшаю… ${formatMmSs(sec)}`;
  };
  tickImprove();
  statusTickerId = setInterval(tickImprove, 1000);

  try {
    const res = await api('/api/improve-prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt: raw }),
    });
    els.prompt.value = res.improvedPrompt;
    els.prompt.focus();
    const fb = res.fallbackFrom ? ` (fallback с ${res.fallbackFrom})` : '';
    els.status.innerHTML = `<span class="dot"></span>промпт улучшен моделью ${res.modelUsed}${fb} • ${res.usage.total} токенов`;
  } catch (e) {
    flashStatus('Ошибка: ' + e.message, 'err');
  } finally {
    clearStatusTicker();
    state.busy = false;
    els.improveBtn.disabled = false;
    els.sendBtn.disabled = false;
    els.improveBtn.textContent = oldText;
  }
}

function flashStatus(text, kind) {
  const cls = kind === 'err' ? 'err' : (kind === 'loading' ? 'loading' : '');
  els.status.innerHTML = `<span class="dot ${cls}"></span>${escapeHtml(text)}`;
}

// =============================================================
// Stats modal
// =============================================================
function fmt(n) { return Number(n || 0).toLocaleString('ru-RU'); }

async function openStats() {
  els.statsModal.classList.remove('hidden');
  els.statsBody.innerHTML = '<div class="text-center text-muted py-12">Загрузка…</div>';
  try {
    const s = await api('/api/stats');
    els.statsBody.innerHTML = renderStats(s);
  } catch (e) {
    els.statsBody.innerHTML = `<div class="text-err">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

function renderStats(s) {
  const t = s.totals || { calls: 0, input: 0, output: 0, total: 0 };
  const labels = s.modelLabels || {};
  const taskNames = { generate: 'Генерация сайтов', improve_prompt: 'Улучшение промптов' };

  const card = (title, val, sub) => `
    <div class="bg-panel2 border border-border rounded-xl p-3">
      <div class="text-xs text-muted uppercase tracking-wider">${escapeHtml(title)}</div>
      <div class="text-2xl font-bold mt-1">${val}</div>
      ${sub ? `<div class="text-xs text-muted mt-1">${sub}</div>` : ''}
    </div>`;

  const row = (label, agg) => {
    const calls = agg.calls || 0, inp = agg.input || 0, out = agg.output || 0, tot = agg.total || (inp + out);
    return `
      <tr class="border-t border-border/60 hover:bg-panel2/40">
        <td class="py-2 px-2">${escapeHtml(label)}</td>
        <td class="py-2 px-2 text-right tabular-nums">${fmt(calls)}</td>
        <td class="py-2 px-2 text-right tabular-nums text-muted">${fmt(inp)}</td>
        <td class="py-2 px-2 text-right tabular-nums text-muted">${fmt(out)}</td>
        <td class="py-2 px-2 text-right tabular-nums font-semibold">${fmt(tot)}</td>
      </tr>`;
  };

  const tableHead = `
    <thead class="text-xs text-muted uppercase tracking-wider">
      <tr>
        <th class="py-1.5 px-2 text-left">Название</th>
        <th class="py-1.5 px-2 text-right">Вызовы</th>
        <th class="py-1.5 px-2 text-right">Input</th>
        <th class="py-1.5 px-2 text-right">Output</th>
        <th class="py-1.5 px-2 text-right">Всего</th>
      </tr>
    </thead>`;

  const taskRows = Object.entries(s.byTask || {})
    .sort((a, b) => (b[1].total || 0) - (a[1].total || 0))
    .map(([k, v]) => row(taskNames[k] || k, v))
    .join('');

  const modelRows = Object.entries(s.byModel || {})
    .sort((a, b) => (b[1].total || 0) - (a[1].total || 0))
    .map(([k, v]) => row(labels[k] || k, v))
    .join('');

  const projects = Object.entries(s.byProject || {})
    .sort((a, b) => (b[1].total || 0) - (a[1].total || 0));
  const projectRows = projects.length
    ? projects.map(([id, v]) => row(id.slice(0, 8) + '…', v)).join('')
    : `<tr><td colspan="5" class="py-3 px-2 text-center text-muted text-xs">Пока пусто</td></tr>`;

  const histRows = (s.history || []).slice(0, 15).map((h) => `
    <tr class="border-t border-border/60">
      <td class="py-1.5 px-2 text-xs text-muted">${new Date(h.ts).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</td>
      <td class="py-1.5 px-2 text-xs">${escapeHtml(taskNames[h.task] || h.task)}</td>
      <td class="py-1.5 px-2 text-xs text-muted">${escapeHtml(labels[h.modelId] || h.modelId)}</td>
      <td class="py-1.5 px-2 text-xs text-right tabular-nums">${fmt(h.total)}</td>
      <td class="py-1.5 px-2 text-xs text-right tabular-nums text-muted">${(h.elapsedMs / 1000).toFixed(1)}s</td>
    </tr>`).join('');

  return `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      ${card('Всего вызовов',   fmt(t.calls))}
      ${card('Всего токенов',   fmt(t.total),  `in ${fmt(t.input)} + out ${fmt(t.output)}`)}
      ${card('Моделей',         fmt(Object.keys(s.byModel || {}).length))}
      ${card('Проектов',        fmt(Object.keys(s.byProject || {}).length))}
    </div>

    <div>
      <div class="text-xs uppercase tracking-wider text-muted mb-2">По задачам</div>
      <table class="w-full">${tableHead}<tbody>${taskRows || `<tr><td colspan="5" class="py-3 text-center text-muted text-xs">Пусто</td></tr>`}</tbody></table>
    </div>

    <div>
      <div class="text-xs uppercase tracking-wider text-muted mb-2">По моделям</div>
      <table class="w-full">${tableHead}<tbody>${modelRows || `<tr><td colspan="5" class="py-3 text-center text-muted text-xs">Пусто</td></tr>`}</tbody></table>
    </div>

    <div>
      <div class="text-xs uppercase tracking-wider text-muted mb-2">По проектам (топ)</div>
      <table class="w-full">${tableHead}<tbody>${projectRows}</tbody></table>
    </div>

    <div>
      <div class="text-xs uppercase tracking-wider text-muted mb-2">Последние события</div>
      <table class="w-full">
        <thead class="text-xs text-muted uppercase tracking-wider">
          <tr>
            <th class="py-1.5 px-2 text-left">Время</th>
            <th class="py-1.5 px-2 text-left">Задача</th>
            <th class="py-1.5 px-2 text-left">Модель</th>
            <th class="py-1.5 px-2 text-right">Токенов</th>
            <th class="py-1.5 px-2 text-right">Длительность</th>
          </tr>
        </thead>
        <tbody>${histRows || `<tr><td colspan="5" class="py-3 text-center text-muted text-xs">Пусто</td></tr>`}</tbody>
      </table>
    </div>`;
}

// =============================================================
// Events
// =============================================================
function bindEvents() {
  els.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendPrompt();
  });

  els.prompt.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      sendPrompt();
    }
  });

  els.newChatBtn.addEventListener('click', newChat);
  els.modelSelect.addEventListener('change', updateModelHint);
  els.improveBtn.addEventListener('click', improvePrompt);

  els.statsBtn.addEventListener('click', openStats);
  els.closeStatsBtn.addEventListener('click', () => els.statsModal.classList.add('hidden'));
  els.statsModal.addEventListener('click', (e) => {
    if (e.target === els.statsModal) els.statsModal.classList.add('hidden');
  });
  els.resetStatsBtn.addEventListener('click', async () => {
    if (!confirm('Сбросить всю статистику?')) return;
    await api('/api/stats', { method: 'DELETE' });
    openStats();
  });

  els.reloadPreview.addEventListener('click', () => {
    if (state.currentId && state.hasHtml) showPreview(state.currentId, state.files, state.currentPage);
  });

  els.pageSelect.addEventListener('change', () => {
    if (state.currentId && state.hasHtml) {
      showPreview(state.currentId, state.files, els.pageSelect.value);
    }
  });

  els.openPreviewBtn.addEventListener('click', () => {
    if (state.currentId) window.open(`/preview/${state.currentId}/${state.currentPage || ''}`, '_blank');
  });

  els.downloadHtml.addEventListener('click', async () => {
    if (!state.currentId) return;
    const baseName = (els.chatTitle.textContent || 'project').replace(/[^\w\-]+/g, '_');
    const filesCount = (state.files || []).length;
    if (filesCount <= 1) {
      const a = document.createElement('a');
      a.href = `/preview/${state.currentId}/index.html`;
      a.download = `${baseName}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else {
      // Многофайловый проект — собираем ZIP через JSZip CDN
      try {
        await ensureScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
        const zip = new window.JSZip();
        for (const rel of state.files) {
          const resp = await fetch(`/preview/${state.currentId}/${rel}`);
          if (!resp.ok) continue;
          zip.file(rel, await resp.blob());
        }
        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${baseName}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        alert('Не удалось собрать ZIP: ' + e.message);
      }
    }
  });
}

function ensureScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.src === src)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Не удалось загрузить ' + src));
    document.head.appendChild(s);
  });
}

init().catch((e) => {
  console.error(e);
  alert('Не удалось загрузить интерфейс: ' + e.message);
});
