// Клиентская логика SPA одного ассистента: Обзор / База знаний / Чат-тест / Статистика.

const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const fmt = (n) => Number(n || 0).toLocaleString('ru-RU');
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);

const PROVIDER_DOT = { claude: '#d97706', openai: '#10a37f', gemini: '#4285f4', ollama: '#a78bfa', openrouter: '#f97316' };

// =============================================================
// ID ассистента + state
// =============================================================
const ASSISTANT_ID = new URLSearchParams(location.search).get('id');
if (!ASSISTANT_ID) { location.href = '/assistant/'; }

const state = {
  assistant: null,
  models: [],
  conversationId: null,
  docPollTimer: null,
};

// =============================================================
// Tabs
// =============================================================
$$('.tab-btn').forEach((b) => {
  b.addEventListener('click', () => activateTab(b.dataset.tab));
});

function activateTab(name) {
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
  if (name === 'kb')            loadDocs();
  if (name === 'stats')         loadStats();
  if (name === 'api')           loadTokens();
  if (name === 'widget')        initWidgetTab();
  if (name === 'leads')         loadLeads();
  if (name === 'conversations') loadConversations();
}

// =============================================================
// Загрузка ассистента + моделей
// =============================================================
async function bootstrap() {
  const [a, models] = await Promise.all([
    fetch(`/api/assistants/${ASSISTANT_ID}`).then((r) => r.ok ? r.json() : null),
    fetch('/api/models').then((r) => r.json()),
  ]);
  if (!a) { alert('Ассистент не найден'); location.href = '/assistant/'; return; }

  state.assistant = a;
  state.models = models;

  $('#aTitle').textContent = a.name;
  document.title = `${a.name} · Botme Ассистенты`;

  // Заполняем форму "Обзор"
  $('#fName').value = a.name || '';
  $('#fDescription').value = a.description || '';
  $('#fGreeting').value = a.greeting || '';
  $('#fSystemPrompt').value = a.system_prompt || '';
  $('#fTemp').value = a.settings?.temperature ?? 0.4;
  $('#fTopK').value = a.settings?.top_k_chunks ?? 5;
  $('#fMaxTokens').value = a.settings?.max_tokens ?? 2048;

  // Список моделей
  const sel = $('#fModel');
  sel.innerHTML = models.map((m) => `<option value="${m.id}">${escapeHtml(m.label)}</option>`).join('');
  sel.value = a.model;

  // Greeting в чат
  resetChatUI();
}

bootstrap();

// =============================================================
// Сохранение настроек ассистента
// =============================================================
$('#saveBtn').addEventListener('click', save);

async function save() {
  const payload = {
    name: $('#fName').value.trim(),
    description: $('#fDescription').value.trim(),
    greeting: $('#fGreeting').value.trim(),
    system_prompt: $('#fSystemPrompt').value,
    model: $('#fModel').value,
    settings: {
      ...state.assistant.settings,
      temperature: parseFloat($('#fTemp').value) || 0.4,
      top_k_chunks: parseInt($('#fTopK').value, 10) || 5,
      max_tokens: parseInt($('#fMaxTokens').value, 10) || 2048,
    },
  };
  const r = await fetch(`/api/assistants/${ASSISTANT_ID}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => r.json());
  state.assistant = r;
  $('#aTitle').textContent = r.name;
  flashSaved();
}

function flashSaved() {
  const el = $('#saveStatus');
  el.classList.remove('hidden');
  el.textContent = 'Сохранено ✓';
  setTimeout(() => el.classList.add('hidden'), 1500);
}

// =============================================================
// Удаление
// =============================================================
$('#deleteBtn').addEventListener('click', async () => {
  if (!confirm(`Удалить ассистента «${state.assistant.name}» вместе со всей базой знаний и историей? Действие необратимо.`)) return;
  await fetch(`/api/assistants/${ASSISTANT_ID}`, { method: 'DELETE' });
  location.href = '/assistant/';
});

$('#reindexBtn').addEventListener('click', async () => {
  if (!confirm('Пересчитать эмбеддинги для всех документов? Может занять минуту.')) return;
  $('#reindexBtn').disabled = true;
  $('#reindexBtn').textContent = 'Запущено…';
  await fetch(`/api/assistants/${ASSISTANT_ID}/reindex`, { method: 'POST' });
  setTimeout(() => { $('#reindexBtn').disabled = false; $('#reindexBtn').textContent = 'Пересчитать эмбеддинги'; }, 1500);
});

// =============================================================
// База знаний
// =============================================================

async function loadDocs() {
  const list = await fetch(`/api/assistants/${ASSISTANT_ID}/documents`).then((r) => r.json());
  renderDocs(list);
  startPollingIfNeeded(list);
}
$('#refreshDocs').addEventListener('click', loadDocs);

const DOC_ICONS = { pdf: '📕', docx: '📘', xlsx: '📗', md: '📝', txt: '📄', text: '✍️', url: '🔗' };

function renderDocs(list) {
  const el = $('#docList');
  if (!list.length) {
    el.innerHTML = `<div class="text-muted text-sm py-8 text-center bg-panel border border-border rounded-xl">База пуста. Добавьте первый источник выше.</div>`;
    return;
  }
  el.innerHTML = list.map((d) => `
    <div class="doc-row" data-doc="${d.id}">
      <div class="doc-icon">${DOC_ICONS[d.type] || '📄'}</div>
      <div class="flex-1 min-w-0">
        <div class="font-medium text-sm truncate">${escapeHtml(d.title || d.source || 'без названия')}</div>
        <div class="text-xs text-muted mt-0.5 flex items-center gap-2 flex-wrap">
          <span class="uppercase">${d.type}</span>
          <span>·</span>
          <span>${fmt(d.char_count)} симв.</span>
          ${d.chunk_count ? `<span>·</span><span>${fmt(d.chunk_count)} чанков</span>` : ''}
          ${d.error ? `<span class="text-err truncate" title="${escapeHtml(d.error)}">· ${escapeHtml(d.error.slice(0, 80))}</span>` : ''}
        </div>
      </div>
      <span class="doc-status ${d.status}">${d.status}</span>
      ${d.status === 'ready' ? `<button class="text-xs px-2 py-1 rounded bg-panel2 border border-border hover:border-brand/50 view-btn" data-doc="${d.id}">Чанки</button>` : ''}
      <button class="text-xs px-2 py-1 rounded bg-panel2 border border-border hover:border-err/50 hover:text-err del-btn" data-doc="${d.id}">×</button>
    </div>
  `).join('');

  el.querySelectorAll('.del-btn').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Удалить документ из базы?')) return;
    await fetch(`/api/assistants/${ASSISTANT_ID}/documents/${b.dataset.doc}`, { method: 'DELETE' });
    loadDocs();
  }));
  el.querySelectorAll('.view-btn').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation(); openDocModal(b.dataset.doc);
  }));
}

// Поллинг прогресса обработки
function startPollingIfNeeded(list) {
  clearInterval(state.docPollTimer); state.docPollTimer = null;
  const hasPending = list.some((d) => d.status === 'pending' || d.status === 'chunking');
  if (!hasPending) return;
  state.docPollTimer = setInterval(loadDocs, 2500);
}

// Просмотр чанков
async function openDocModal(docId) {
  const d = await fetch(`/api/assistants/${ASSISTANT_ID}/documents/${docId}`).then((r) => r.json());
  $('#docModalTitle').textContent = d.title || d.source || 'Документ';
  $('#docModalSub').textContent = `${d.type.toUpperCase()} · ${fmt(d.char_count)} симв. · ${fmt(d.chunk_count)} чанков`;
  $('#docChunks').innerHTML = (d.chunks || []).map((c) => `
    <div class="chunk-item">
      <div class="chunk-head">
        <span>Чанк #${c.idx + 1}</span>
        <span>${fmt(c.tokens)} токенов</span>
      </div>
      ${escapeHtml(c.text)}
    </div>
  `).join('') || '<div class="text-muted text-sm">Чанков нет.</div>';
  $('#docModal').classList.remove('hidden');
}
$('#closeDocModal').addEventListener('click', () => $('#docModal').classList.add('hidden'));
$('#docModal').addEventListener('click', (e) => { if (e.target.id === 'docModal') $('#docModal').classList.add('hidden'); });

// Drop-zone
const dropZone = $('#dropZone');
const fileInput = $('#fileInput');
$('#pickFileBtn').addEventListener('click', () => fileInput.click());
dropZone.addEventListener('click', (e) => { if (e.target.id !== 'pickFileBtn') fileInput.click(); });

['dragenter', 'dragover'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); })
);
['dragleave', 'drop'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); })
);
dropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', (e) => {
  if (e.target.files?.length) uploadFiles(e.target.files);
  e.target.value = '';
});

async function uploadFiles(files) {
  for (const f of files) {
    const fd = new FormData();
    fd.append('file', f);
    try {
      const r = await fetch(`/api/assistants/${ASSISTANT_ID}/documents/file`, { method: 'POST', body: fd });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        alert(`Ошибка загрузки ${f.name}: ${err.error || r.status}`);
      }
    } catch (e) { alert(`Ошибка загрузки ${f.name}: ${e.message}`); }
  }
  loadDocs();
}

// URL
$('#addUrlBtn').addEventListener('click', addUrl);
$('#urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addUrl(); } });
async function addUrl() {
  const url = $('#urlInput').value.trim();
  if (!url) return;
  const r = await fetch(`/api/assistants/${ASSISTANT_ID}/documents/url`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j.error || 'Ошибка'); return; }
  $('#urlInput').value = '';
  loadDocs();
}

// Текст
$('#addTextBtn').addEventListener('click', () => $('#textModal').classList.remove('hidden'));
$('#cancelText').addEventListener('click', () => $('#textModal').classList.add('hidden'));
$('#closeTextModal').addEventListener('click', () => $('#textModal').classList.add('hidden'));
$('#textModal').addEventListener('click', (e) => { if (e.target.id === 'textModal') $('#textModal').classList.add('hidden'); });
$('#saveText').addEventListener('click', async () => {
  const title = $('#textTitle').value.trim();
  const content = $('#textBody').value.trim();
  if (!content) { alert('Текст пуст'); return; }
  const r = await fetch(`/api/assistants/${ASSISTANT_ID}/documents/text`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content }),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j.error || 'Ошибка'); return; }
  $('#textTitle').value = ''; $('#textBody').value = '';
  $('#textModal').classList.add('hidden');
  loadDocs();
});

// =============================================================
// Чат-тест
// =============================================================

function resetChatUI() {
  state.conversationId = null;
  const greeting = state.assistant?.greeting || 'Здравствуйте! Чем могу помочь?';
  $('#chatMsgs').innerHTML = '';
  appendMessage('assistant', greeting);
}

$('#newConvBtn').addEventListener('click', resetChatUI);

$('#chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';

  appendMessage('user', message);
  const typingEl = appendMessage('assistant', '<span class="typing"><span></span><span></span><span></span></span>', { raw: true });

  try {
    const r = await fetch(`/api/assistants/${ASSISTANT_ID}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, conversationId: state.conversationId }),
    }).then((r) => r.json());

    if (r.error) throw new Error(r.error);
    state.conversationId = r.conversationId;

    const sourcesHtml = renderSources(r.retrieval?.hits || []);
    const meta = renderMessageMeta(r);
    typingEl.querySelector('.bubble').innerHTML = escapeHtml(r.text) + sourcesHtml + meta;

    // Если триггер лида сработал — показываем inline-форму прямо в чате
    if (r.lead?.shouldOffer) {
      renderInlineLeadForm(r.lead.fields || ['name', 'phone'], r.conversationId);
    }
  } catch (e) {
    typingEl.querySelector('.bubble').innerHTML = `<span class="text-err">Ошибка: ${escapeHtml(e.message)}</span>`;
  }
  scrollChatToBottom();
});

// Inline-форма лида внутри админ-чата (для теста flow без виджета)
function renderInlineLeadForm(fields, conversationId) {
  // Не показываем повторно, если форма уже висит ниже последнего сообщения
  const last = $('#chatMsgs').lastElementChild;
  if (last && last.classList.contains('lead-inline')) return;

  const fieldLabels = { name: 'Имя', phone: 'Телефон', email: 'Email', telegram: 'Telegram', message: 'Описание' };
  const fieldTypes  = { name: 'text', phone: 'tel', email: 'email', telegram: 'text', message: 'text' };

  const wrap = document.createElement('div');
  wrap.className = 'lead-inline';
  wrap.innerHTML = `
    <div class="lead-inline-head">
      <div class="lead-inline-icon">📋</div>
      <div>
        <div class="lead-inline-title">Контакт для менеджера</div>
        <div class="lead-inline-sub">Заполни форму — это сохранится как лид и видно во вкладке «Лиды».</div>
      </div>
    </div>
    <form class="lead-inline-form">
      ${fields.map((f) => `
        <input name="${f}" type="${fieldTypes[f] || 'text'}" placeholder="${fieldLabels[f] || f}"
          class="lead-inline-input" ${f === 'name' || f === 'phone' ? 'required' : ''} />
      `).join('')}
      <input name="message" type="text" placeholder="Что нужно? (опционально)" class="lead-inline-input" />
      <div class="lead-inline-actions">
        <button type="button" class="lead-inline-cancel">Не сейчас</button>
        <button type="submit" class="lead-inline-submit">Сохранить лид</button>
      </div>
      <div class="lead-inline-status"></div>
    </form>
  `;
  $('#chatMsgs').appendChild(wrap);
  scrollChatToBottom();

  wrap.querySelector('.lead-inline-cancel').addEventListener('click', () => wrap.remove());
  wrap.querySelector('.lead-inline-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { conversationId };
    for (const [k, v] of fd.entries()) if (v) payload[k] = v;
    const status = wrap.querySelector('.lead-inline-status');
    status.textContent = 'Сохраняем…';
    try {
      const r = await fetch(`/api/assistants/${ASSISTANT_ID}/leads`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + r.status));
      }
      status.innerHTML = '<span class="lead-inline-ok">✓ Лид сохранён</span>';
      wrap.querySelectorAll('input, button').forEach((b) => b.disabled = true);
      setTimeout(() => wrap.remove(), 2500);
    } catch (err) {
      status.innerHTML = `<span class="text-err">Ошибка: ${escapeHtml(err.message)}</span>`;
    }
  });
}

function appendMessage(role, content, { raw = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = `msg msg-${role}`;
  if (role === 'assistant') {
    wrap.innerHTML = `<div class="avatar-ai">AI</div><div class="bubble">${raw ? content : escapeHtml(content)}</div>`;
  } else {
    wrap.innerHTML = `<div class="bubble">${escapeHtml(content)}</div>`;
  }
  $('#chatMsgs').appendChild(wrap);
  scrollChatToBottom();
  return wrap;
}

function scrollChatToBottom() {
  const el = $('#chatMsgs');
  el.scrollTop = el.scrollHeight;
}

function renderSources(hits) {
  if (!hits.length) return `<div class="msg-sources">📭 Релевантных фрагментов в базе не нашлось.</div>`;
  const items = hits.map((h, i) => `
    <div class="source-chunk">
      <div class="text-[10px] uppercase tracking-wider text-muted mb-1">
        #${i + 1} · ${escapeHtml(h.title || 'документ')} · score ${h.score.toFixed(3)}
      </div>
      ${escapeHtml(h.text)}
    </div>
  `).join('');
  return `
    <div class="msg-sources mt-2">
      <details>
        <summary>📚 Использовано ${hits.length} фрагмент${hits.length === 1 ? '' : 'ов'}</summary>
        <div class="mt-2 space-y-2">${items}</div>
      </details>
    </div>`;
}

function renderMessageMeta(r) {
  const parts = [];
  if (r.modelUsed) parts.push(escapeHtml(r.modelUsed.split(':').slice(1).join(':') || r.modelUsed));
  if (r.fallbackFrom) parts.push(`fallback ← ${escapeHtml(r.fallbackFrom.split(':').slice(1).join(':'))}`);
  if (r.usage?.total) parts.push(`${fmt(r.usage.total)} токенов`);
  if (r.elapsedMs) parts.push(`${(r.elapsedMs / 1000).toFixed(1)}s`);
  if (!parts.length) return '';
  return `<div class="text-[11px] text-muted mt-1">${parts.join(' · ')}</div>`;
}

// =============================================================
// Статистика
// =============================================================
async function loadStats() {
  const s = await fetch(`/api/assistants/${ASSISTANT_ID}/stats`).then((r) => r.json());
  $('#kpiCalls').textContent = fmt(s.total?.calls || 0);
  $('#kpiIn').textContent    = fmt(s.total?.input || 0);
  $('#kpiOut').textContent   = fmt(s.total?.output || 0);
  $('#kpiTotal').textContent = fmt(s.total?.total || 0);

  $('#statModels').innerHTML = renderStatRows(s.byModel, 'model');
  $('#statSources').innerHTML = renderStatRows(s.bySource, 'source');
  $('#statDays').innerHTML = (s.byDay || []).map((d) =>
    `<div class="flex justify-between border-b border-border/50 py-1">
      <span class="text-muted">${escapeHtml(d.day)}</span>
      <span>${fmt(d.calls)} запросов · ${fmt(d.total)} токенов</span>
    </div>`).join('') || '<div class="text-muted">Пока нет данных.</div>';
}

function renderStatRows(rows, key) {
  if (!rows?.length) return '<div class="text-muted">Пока нет данных.</div>';
  const max = Math.max(...rows.map((r) => r.total || 0)) || 1;
  return rows.map((r) => {
    const label = key === 'model' ? (r.model.split(':').slice(1).join(':') || r.model) : r.source;
    const pct = (r.total / max) * 100;
    const color = key === 'model' ? (PROVIDER_DOT[r.model.split(':')[0]] || '#7c5cff') : '#22d3ee';
    return `
      <div>
        <div class="flex justify-between text-xs mb-1">
          <span class="font-medium">${escapeHtml(label)}</span>
          <span class="text-muted">${fmt(r.calls)} · ${fmt(r.total)} токенов</span>
        </div>
        <div class="h-1.5 bg-panel2 rounded-full overflow-hidden">
          <div class="h-full rounded-full" style="width:${pct}%;background:${color}"></div>
        </div>
      </div>`;
  }).join('');
}

// =============================================================
// Вкладка API (токены)
// =============================================================
const HOST = location.origin;
let lastTokens = [];

async function loadTokens() {
  $('#apiBase').textContent = HOST;
  const tokens = await fetch(`/api/assistants/${ASSISTANT_ID}/tokens`).then((r) => r.json());
  lastTokens = tokens;
  renderTokens(tokens);
  renderApiDocs(tokens.find((t) => !t.revoked));
  // Виджет-snippet тоже зависит от наличия токена
  renderWidgetSnippet(tokens.find((t) => !t.revoked));
}

function renderTokens(tokens) {
  const el = $('#tokenList');
  if (!tokens.length) {
    el.innerHTML = `<div class="text-muted text-sm py-6 text-center bg-panel border border-border rounded-xl">Токенов пока нет. Создайте первый — он сразу станет доступен на <code>/api/v1/*</code>.</div>`;
    return;
  }
  el.innerHTML = tokens.map((t) => `
    <div class="token-row ${t.revoked ? 'revoked' : ''}">
      <div class="min-w-0">
        <div class="font-medium text-sm truncate">${escapeHtml(t.name || 'без названия')} ${t.revoked ? '<span class="text-err text-xs ml-1">(отозван)</span>' : ''}</div>
        <div class="token-meta mt-0.5"><span class="token-prefix">${escapeHtml(t.prefix)}…</span> · ${t.rate_limit_rpm} req/min · origins: ${escapeHtml((t.allowed_origins || ['*']).join(', '))}</div>
        <div class="token-meta">создан ${new Date(t.created_at).toLocaleString('ru-RU')}${t.last_used_at ? ' · последний раз ' + new Date(t.last_used_at).toLocaleString('ru-RU') : ' · не использовался'}</div>
      </div>
      ${t.revoked ? '' : `<button class="text-xs px-2 py-1 rounded bg-panel2 border border-border hover:border-err/50 hover:text-err revoke-btn" data-id="${t.id}">Отозвать</button>`}
      <button class="text-xs px-2 py-1 rounded bg-panel2 border border-border hover:border-err/50 hover:text-err del-tok-btn" data-id="${t.id}">×</button>
      <span></span>
    </div>
  `).join('');
  el.querySelectorAll('.revoke-btn').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Отозвать токен? Запросы по нему перестанут работать сразу.')) return;
    await fetch(`/api/assistants/${ASSISTANT_ID}/tokens/${b.dataset.id}/revoke`, { method: 'POST' });
    loadTokens();
  }));
  el.querySelectorAll('.del-tok-btn').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Удалить токен полностью?')) return;
    await fetch(`/api/assistants/${ASSISTANT_ID}/tokens/${b.dataset.id}`, { method: 'DELETE' });
    loadTokens();
  }));
}

function renderApiDocs(activeToken) {
  const sample = activeToken ? `${activeToken.prefix}…` : 'ast_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const note = activeToken ? '' : '\n# (создайте токен слева, чтобы получить значение)';
  setBlock('#codeCurl', `curl -X POST ${HOST}/api/v1/chat \\
  -H "Authorization: Bearer ${sample}" \\
  -H "Content-Type: application/json" \\
  -d '{"message":"Привет!"}'${note}`);

  setBlock('#codeCurlStream', `curl -N -X POST "${HOST}/api/v1/chat?stream=1" \\
  -H "Authorization: Bearer ${sample}" \\
  -H "Content-Type: application/json" \\
  -d '{"message":"Расскажи о ваших услугах"}'`);

  setBlock('#codeJs', `const r = await fetch("${HOST}/api/v1/chat", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${sample}",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ message: "Привет!", sessionId: "user-123" })
});
const data = await r.json();
console.log(data.text);`);

  setBlock('#codePy', `import requests
r = requests.post(
    "${HOST}/api/v1/chat",
    headers={"Authorization": "Bearer ${sample}"},
    json={"message": "Привет!", "sessionId": "user-123"},
)
print(r.json()["text"])`);
}

function setBlock(sel, code) {
  const el = $(sel);
  el.innerHTML = '';
  el.textContent = code;
  const btn = document.createElement('button');
  btn.className = 'copy-btn'; btn.textContent = 'copy';
  btn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      btn.textContent = '✓ copied'; btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 1500);
    } catch {}
  };
  el.appendChild(btn);
}

$('#newTokenBtn').addEventListener('click', () => {
  $('#tokenFormStep').classList.remove('hidden');
  $('#tokenSuccessStep').classList.add('hidden');
  $('#tokName').value = '';
  $('#tokRpm').value = 60;
  $('#tokOrigins').value = '*';
  $('#tokenModal').classList.remove('hidden');
  $('#tokName').focus();
});
$('#closeTokenModal').addEventListener('click', () => $('#tokenModal').classList.add('hidden'));
$('#cancelTokenCreate').addEventListener('click', () => $('#tokenModal').classList.add('hidden'));
$('#doneTokenStep').addEventListener('click', () => { $('#tokenModal').classList.add('hidden'); loadTokens(); });
$('#tokenModal').addEventListener('click', (e) => { if (e.target.id === 'tokenModal') $('#tokenModal').classList.add('hidden'); });

$('#createTokenBtn').addEventListener('click', async () => {
  const origins = $('#tokOrigins').value.split(',').map((s) => s.trim()).filter(Boolean);
  const payload = {
    name: $('#tokName').value.trim(),
    rateLimitRpm: parseInt($('#tokRpm').value, 10) || 60,
    allowedOrigins: origins.length ? origins : ['*'],
  };
  const r = await fetch(`/api/assistants/${ASSISTANT_ID}/tokens`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => r.json());
  if (!r.plainToken) { alert('Ошибка создания'); return; }
  $('#tokenFormStep').classList.add('hidden');
  $('#tokenSuccessStep').classList.remove('hidden');
  setBlock('#newTokenValue', r.plainToken);
});

// =============================================================
// Вкладка Виджет
// =============================================================
let widgetReady = false;

function initWidgetTab() {
  const a = state.assistant;
  if (!a) return;
  const t = a.theme || {};
  $('#wColor').value    = t.color    || '#7c5cff';
  $('#wBrand').value    = t.brand    || '';
  $('#wAvatar').value   = t.avatar   || '';
  $('#wGreeting').value = a.greeting || '';

  $$('.theme-color-dot').forEach((d) => d.classList.toggle('active', d.dataset.color === (t.color || '#7c5cff')));
  $$('.position-btn').forEach((b) => b.classList.toggle('active', b.dataset.pos === (t.position || 'br')));

  // Активный токен ищем последним загруженным или подгружаем
  if (!lastTokens.length) {
    fetch(`/api/assistants/${ASSISTANT_ID}/tokens`).then((r) => r.json()).then((tokens) => {
      lastTokens = tokens;
      renderWidgetSnippet(tokens.find((t) => !t.revoked));
      reloadWidgetPreview();
    });
  } else {
    renderWidgetSnippet(lastTokens.find((t) => !t.revoked));
    reloadWidgetPreview();
  }
  widgetReady = true;
}

$$('.theme-color-dot').forEach((d) => d.addEventListener('click', () => {
  $('#wColor').value = d.dataset.color;
  $$('.theme-color-dot').forEach((x) => x.classList.toggle('active', x === d));
}));
$$('.position-btn').forEach((b) => b.addEventListener('click', () => {
  $$('.position-btn').forEach((x) => x.classList.toggle('active', x === b));
}));

$('#saveWidgetBtn').addEventListener('click', async () => {
  const theme = {
    color: $('#wColor').value,
    position: ($$('.position-btn').find((b) => b.classList.contains('active'))?.dataset.pos) || 'br',
    brand: $('#wBrand').value.trim(),
    avatar: $('#wAvatar').value.trim(),
    dark: true,
  };
  const greeting = $('#wGreeting').value.trim();
  const r = await fetch(`/api/assistants/${ASSISTANT_ID}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme, greeting }),
  }).then((r) => r.json());
  state.assistant = r;
  const el = $('#wSaveStatus');
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 1500);
  reloadWidgetPreview();
});

function reloadWidgetPreview() {
  const active = lastTokens.find((t) => !t.revoked);
  const frame = $('#widgetPreviewFrame');
  if (!active) {
    frame.srcdoc = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#8a93a6;font-family:Inter,sans-serif;font-size:14px;text-align:center;padding:20px;">
      Создайте API-токен на вкладке API,<br>чтобы увидеть превью виджета.
    </div>`;
    return;
  }
  // У нас нет plainToken после создания (он одноразовый). Превью использует тот же admin endpoint /widget/?token=…,
  // но без plain мы не можем его открыть через виджет. Решение: показать только что выпущенный токен через
  // временное хранение в памяти (или иной способ). Пока даём подсказку: после создания — открыть превью на новой вкладке.
  frame.srcdoc = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#8a93a6;font-family:Inter,sans-serif;font-size:14px;text-align:center;padding:20px;line-height:1.6;">
    Превью виджета доступно только с plain-токеном.<br>
    Скопируйте токен при создании и откройте<br>
    <a target="_blank" style="color:#a78bfa;" href="${HOST}/widget/?token=ВАШ_ТОКЕН">${HOST}/widget/?token=ВАШ_ТОКЕН</a><br>
    в новой вкладке.
  </div>`;
}

function renderWidgetSnippet(activeToken) {
  if (!activeToken) {
    setBlock('#widgetSnippet', '// Создайте токен на вкладке API, и здесь появится готовый код.');
    return;
  }
  const snippet = `<!-- Botme AI-ассистент -->\n<script src="${HOST}/widget.js"\n        data-token="${activeToken.prefix}…ВСТАВЬТЕ_ПОЛНЫЙ_ТОКЕН"></script>`;
  setBlock('#widgetSnippet', snippet);
}

// =============================================================
// Вкладка Лиды
// =============================================================
async function loadLeads() {
  const leads = await fetch(`/api/assistants/${ASSISTANT_ID}/leads`).then((r) => r.json());
  renderLeads(leads);
  $('#exportLeadsBtn').href = `/api/assistants/${ASSISTANT_ID}/leads.csv`;
}
$('#refreshLeads').addEventListener('click', loadLeads);

function renderLeads(leads) {
  const el = $('#leadList');
  if (!leads.length) {
    el.innerHTML = `<div class="text-muted text-sm py-8 text-center bg-panel border border-border rounded-xl">Пока нет лидов. Они появятся здесь, когда пользователи оставят контакты в виджете или через API.</div>`;
    return;
  }
  el.innerHTML = leads.map((l) => {
    const convId = l.conversation_id || '';
    const chatBtn = convId
      ? `<button type="button" class="lead-chat-btn open-lead-conv-btn" data-conv="${escapeHtml(convId)}">Чат</button>`
      : '<span class="text-muted text-xs">—</span>';
    return `
    <div class="lead-row" data-id="${l.id}">
      <div>
        <div class="font-medium">${escapeHtml(l.name || '—')}</div>
        <div class="lead-date">${new Date(l.created_at).toLocaleString('ru-RU')}</div>
      </div>
      <div>${escapeHtml(l.phone || '—')}</div>
      <div class="truncate" title="${escapeHtml(l.email || '')}">${escapeHtml(l.email || '—')}</div>
      <div>${chatBtn}</div>
      <div class="truncate text-muted text-xs" title="${escapeHtml(l.message || '')}">${escapeHtml(l.message || '—')}</div>
      <button class="text-xs px-2 py-1 rounded bg-panel2 border border-border hover:border-err/50 hover:text-err del-lead-btn" data-id="${l.id}">×</button>
    </div>`;
  }).join('');
  el.querySelectorAll('.del-lead-btn').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Удалить лид?')) return;
    await fetch(`/api/assistants/${ASSISTANT_ID}/leads/${b.dataset.id}`, { method: 'DELETE' });
    loadLeads();
  }));
  el.querySelectorAll('.open-lead-conv-btn').forEach((b) => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openConversation(b.dataset.conv);
  }));
}

// =============================================================
// Вкладка Разговоры
// =============================================================
async function loadConversations() {
  const list = await fetch(`/api/assistants/${ASSISTANT_ID}/conversations`).then((r) => r.json());
  const el = $('#convList');
  if (!list.length) {
    el.innerHTML = `<div class="text-muted text-sm py-8 text-center bg-panel border border-border rounded-xl">Разговоров пока нет.</div>`;
    return;
  }
  el.innerHTML = list.map((c) => `
    <div class="conv-row" data-id="${c.id}">
      <span class="conv-source ${c.source}">${c.source}</span>
      <div class="flex-1 min-w-0">
        <div class="text-sm truncate">${escapeHtml(c.first_user_msg || '(нет сообщений)')}</div>
        <div class="text-xs text-muted mt-0.5">
          ${c.message_count} сообщ. · последнее ${new Date(c.last_at).toLocaleString('ru-RU')}
          ${c.session_id ? ' · sid: ' + escapeHtml(c.session_id.slice(0, 12)) + '…' : ''}
        </div>
      </div>
    </div>`).join('');
  el.querySelectorAll('.conv-row').forEach((r) => r.addEventListener('click', () => openConversation(r.dataset.id)));
}
$('#refreshConvs').addEventListener('click', loadConversations);

async function openConversation(cid) {
  const r = await fetch(`/api/assistants/${ASSISTANT_ID}/conversations/${cid}`).then((r) => r.json());
  $('#convModalTitle').textContent = `Разговор #${cid.slice(0, 8)}`;
  $('#convModalSub').textContent   = `${r.messages.length} сообщений`;
  $('#convMessages').innerHTML = r.messages.map((m) => {
    const sources = m.sources_json ? safeJson(m.sources_json, []) : [];
    const meta = m.role === 'assistant'
      ? `<div class="text-[11px] text-muted mt-1">${m.model_used ? escapeHtml(m.model_used.split(':').slice(1).join(':')) + ' · ' : ''}${fmt(m.input_tokens)} in / ${fmt(m.output_tokens)} out</div>`
      : '';
    const srcHtml = sources.length
      ? `<div class="text-[11px] text-muted mt-1">📚 ${sources.length} фрагмент(ов)</div>`
      : '';
    return `<div class="msg msg-${m.role}">
      ${m.role === 'assistant' ? '<div class="avatar-ai">AI</div>' : ''}
      <div class="bubble">${escapeHtml(m.content)}${srcHtml}${meta}</div>
    </div>`;
  }).join('');
  $('#convModal').classList.remove('hidden');
}
$('#closeConvModal').addEventListener('click', () => $('#convModal').classList.add('hidden'));
$('#convModal').addEventListener('click', (e) => { if (e.target.id === 'convModal') $('#convModal').classList.add('hidden'); });

function safeJson(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }

// =============================================================
// Краулер сайта (sitemap.xml)
// =============================================================
$('#crawlSiteBtn').addEventListener('click', () => {
  const prefill = $('#urlInput').value.trim();
  if (prefill) $('#crawlUrl').value = prefill;
  $('#crawlStep1').classList.remove('hidden');
  $('#crawlStep2').classList.add('hidden');
  $('#crawlStep3').classList.add('hidden');
  $('#crawlModal').classList.remove('hidden');
  setTimeout(() => $('#crawlUrl').focus(), 50);
});

$('#closeCrawl').addEventListener('click', () => $('#crawlModal').classList.add('hidden'));
$('#cancelCrawl').addEventListener('click', () => $('#crawlModal').classList.add('hidden'));
$('#doneCrawl').addEventListener('click', () => { $('#crawlModal').classList.add('hidden'); loadDocs(); });
$('#crawlModal').addEventListener('click', (e) => { if (e.target.id === 'crawlModal') $('#crawlModal').classList.add('hidden'); });

$('#runCrawl').addEventListener('click', async () => {
  const url = $('#crawlUrl').value.trim();
  if (!url || !/^https?:\/\//i.test(url)) { alert('Введите валидный URL'); return; }
  const payload = {
    url,
    maxPages: parseInt($('#crawlLimit').value, 10) || 30,
    sameOriginOnly: $('#crawlSameOrigin').value === 'true',
  };

  $('#crawlStep1').classList.add('hidden');
  $('#crawlStep2').classList.remove('hidden');

  try {
    const r = await fetch(`/api/assistants/${ASSISTANT_ID}/documents/crawl`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ('HTTP ' + r.status));
    }
    const data = await r.json();
    $('#crawlStep2').classList.add('hidden');
    $('#crawlStep3').classList.remove('hidden');
    $('#crawlCount').textContent = data.count;
    $('#crawlList').innerHTML = data.pages.map((p) => `
      <div class="flex items-center gap-2 py-1 border-b border-border/50">
        <span class="text-muted">${escapeHtml((new URL(p.url)).pathname || '/')}</span>
        <span class="ml-auto text-muted/70 text-[10px] uppercase">pending</span>
      </div>`).join('');
    loadDocs();
  } catch (e) {
    $('#crawlStep2').classList.add('hidden');
    $('#crawlStep1').classList.remove('hidden');
    alert('Ошибка краула: ' + e.message);
  }
});

// =============================================================
// AI-генератор базы знаний
// =============================================================
$('#aiGenBtn').addEventListener('click', () => {
  // Заполняем список моделей
  const sel = $('#aiGenModel');
  if (state.models.length && !sel.options.length) {
    sel.innerHTML = state.models.map((m) => `<option value="${m.id}">${escapeHtml(m.label)}</option>`).join('');
    sel.value = state.assistant?.model || 'claude:claude-haiku-4-5-20251001';
  }
  $('#aiGenStep1').classList.remove('hidden');
  $('#aiGenStep2').classList.add('hidden');
  $('#aiGenStep3').classList.add('hidden');
  $('#aiGenModal').classList.remove('hidden');
  setTimeout(() => $('#aiGenDesc').focus(), 50);
});

$('#closeAiGen').addEventListener('click', () => $('#aiGenModal').classList.add('hidden'));
$('#cancelAiGen').addEventListener('click', () => $('#aiGenModal').classList.add('hidden'));
$('#doneAiGen').addEventListener('click', () => { $('#aiGenModal').classList.add('hidden'); loadDocs(); });
$('#aiGenModal').addEventListener('click', (e) => { if (e.target.id === 'aiGenModal') $('#aiGenModal').classList.add('hidden'); });

$('#runAiGen').addEventListener('click', async () => {
  const description = $('#aiGenDesc').value.trim();
  if (!description) { alert('Опишите бизнес'); return; }
  const payload = {
    description,
    tone: $('#aiGenTone').value,
    targetCount: parseInt($('#aiGenCount').value, 10) || 7,
    modelId: $('#aiGenModel').value,
  };

  $('#aiGenStep1').classList.add('hidden');
  $('#aiGenStep2').classList.remove('hidden');
  $('#aiGenStep3').classList.add('hidden');

  try {
    const r = await fetch(`/api/assistants/${ASSISTANT_ID}/documents/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ('HTTP ' + r.status));
    }
    const data = await r.json();
    $('#aiGenStep2').classList.add('hidden');
    $('#aiGenStep3').classList.remove('hidden');
    $('#aiGenResult').innerHTML = data.documents.map((d) => `
      <div class="doc-row">
        <div class="doc-icon">${({ overview: '🏢', services: '🛠️', pricing: '💰', faq: '❓', policies: '🛡️', contacts: '📞', guide: '📋', other: '📄' })[d.kind] || '📄'}</div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium truncate">${escapeHtml(d.title)}</div>
          <div class="text-xs text-muted">${escapeHtml(d.kind)}</div>
        </div>
        <span class="doc-status pending">в обработке</span>
      </div>`).join('');
    $('#aiGenMeta').textContent =
      `Модель: ${data.modelUsed.split(':').slice(1).join(':') || data.modelUsed} · ${fmt(data.usage.total)} токенов`
      + (data.fallbackFrom ? ` · fallback ← ${data.fallbackFrom.split(':').slice(1).join(':')}` : '');
    // Обновим список документов под модалкой — они пойдут в pending->ready
    loadDocs();
  } catch (e) {
    $('#aiGenStep2').classList.add('hidden');
    $('#aiGenStep1').classList.remove('hidden');
    alert('Ошибка генерации: ' + e.message);
  }
});
