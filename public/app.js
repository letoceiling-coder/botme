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

// =============================================================
// API helpers
// =============================================================
async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`${r.status} ${r.statusText} ${text}`);
  }
  return r.json();
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
    els.modelHint.textContent = `${freeNote}Единый API OpenRouter, модель с поддержкой tools. Подходит для экспериментов и альтернативных провайдеров.`;
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

function addLoadingMessage() {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';
  wrap.innerHTML = `
    <div class="avatar avatar-ai">AI</div>
    <div class="bubble">
      <div class="typing"><span></span><span></span><span></span></div>
      <div class="text-xs text-muted mt-1">генерирую…</div>
    </div>`;
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
async function sendPrompt() {
  if (state.busy) return;
  const prompt = els.prompt.value.trim();
  if (!prompt) return;
  const model = els.modelSelect.value;

  state.busy = true;
  els.sendBtn.disabled = true;
  els.status.innerHTML = `<span class="dot loading"></span>модель: ${model}`;

  // Сразу отрисовываем сообщение пользователя + индикатор загрузки
  if (state.currentMessages.length === 0) els.messages.innerHTML = '';
  state.currentMessages.push({ role: 'user', content: prompt });
  addMessageToDOM('user', prompt);
  els.prompt.value = '';
  const loadingEl = addLoadingMessage();

  try {
    const res = await api('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        projectId: state.currentId,
        prompt,
        model,
      }),
    });
    loadingEl.remove();
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
    loadingEl.remove();
    addMessageToDOM('assistant', `❌ Ошибка: ${e.message}`);
    els.status.innerHTML = `<span class="dot err"></span>ошибка`;
  } finally {
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
  els.improveBtn.textContent = '⏳ Улучшаю…';
  els.status.innerHTML = `<span class="dot loading"></span>улучшаю промпт через Claude Haiku…`;

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
