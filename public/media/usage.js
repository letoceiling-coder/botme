/**
 * Usage drawer для AI Media Studio.
 * Показывает расход токенов / времени / денег текущего пользователя.
 * Открывается по клику на кнопку #btnUsage в топбаре.
 */
import { api } from './api.js';

let drawerEl = null;
let isOpen = false;

const KIND_LABEL = {
  image:   'Изображения',
  video:   'Видео',
  upscale: 'Апскейл',
  audio:   'Аудио',
  llm:     'LLM (Assistant)',
};
const KIND_COLOR = {
  image:   '#7c5cff',
  video:   '#22d3ee',
  upscale: '#f472b6',
  audio:   '#34d399',
  llm:     '#fbbf24',
};

function ensureDrawer() {
  if (drawerEl) return drawerEl;
  drawerEl = document.createElement('div');
  drawerEl.className = 'usage-drawer';
  drawerEl.hidden = true;
  drawerEl.innerHTML = /*html*/`
    <div class="usage-backdrop" data-close></div>
    <div class="usage-panel" role="dialog" aria-label="Usage">
      <header class="usage-head">
        <div>
          <div class="usage-title">Расход и статистика</div>
          <div class="usage-sub" id="usageOwner">—</div>
        </div>
        <div class="usage-range" role="tablist">
          <button class="usage-range-btn" data-range="7d">7 дней</button>
          <button class="usage-range-btn is-active" data-range="30d">30 дней</button>
          <button class="usage-range-btn" data-range="90d">90 дней</button>
          <button class="usage-range-btn" data-range="all">Всё время</button>
        </div>
        <button class="usage-close" data-close title="Закрыть">✕</button>
      </header>

      <section class="usage-totals" id="usageTotals">
        <div class="usage-card"><div class="usage-card-k">Запусков</div><div class="usage-card-v" data-k="calls">—</div></div>
        <div class="usage-card"><div class="usage-card-k">Расход</div><div class="usage-card-v" data-k="cost">—</div></div>
        <div class="usage-card"><div class="usage-card-k">Токены (in/out)</div><div class="usage-card-v" data-k="tokens">—</div></div>
        <div class="usage-card"><div class="usage-card-k">Время</div><div class="usage-card-v" data-k="duration">—</div></div>
        <div class="usage-card"><div class="usage-card-k">Ошибок</div><div class="usage-card-v" data-k="failed">—</div></div>
      </section>

      <section class="usage-grid">
        <div class="usage-block">
          <h3>По типу узла</h3>
          <div class="usage-bars" id="usageByKind"></div>
        </div>
        <div class="usage-block">
          <h3>По модели</h3>
          <div class="usage-bars" id="usageByModel"></div>
        </div>
      </section>

      <section class="usage-recent">
        <h3>Последние запуски</h3>
        <div class="usage-table-wrap">
          <table class="usage-table">
            <thead>
              <tr>
                <th>Когда</th>
                <th>Тип</th>
                <th>Модель</th>
                <th>Статус</th>
                <th>Время</th>
                <th>Токены</th>
                <th>Расход</th>
                <th>Проект</th>
              </tr>
            </thead>
            <tbody id="usageRecentBody">
              <tr><td colspan="8" class="usage-empty">…загрузка</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `;
  document.body.appendChild(drawerEl);

  drawerEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
  });
  drawerEl.addEventListener('wheel', (e) => {
    // Гасим Ctrl+wheel, чтобы браузер не зумил содержимое drawer-а.
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  }, { passive: false });

  drawerEl.querySelectorAll('.usage-range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      drawerEl.querySelectorAll('.usage-range-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
      load(btn.dataset.range || '30d');
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) { e.preventDefault(); close(); }
  });
  return drawerEl;
}

export function openUsage() {
  ensureDrawer();
  drawerEl.hidden = false;
  isOpen = true;
  load('30d');
}

function close() {
  if (!drawerEl) return;
  drawerEl.hidden = true;
  isOpen = false;
}

async function load(range) {
  const tbody = drawerEl.querySelector('#usageRecentBody');
  tbody.innerHTML = `<tr><td colspan="8" class="usage-empty">…загрузка</td></tr>`;
  try {
    const data = await api.getUsage(range);
    drawerEl.querySelector('#usageOwner').textContent = data.owner ? `Пользователь: ${data.owner}` : '';
    renderTotals(data.totals || {});
    renderBars(drawerEl.querySelector('#usageByKind'),  data.byKind  || {}, /* labelMap */ KIND_LABEL, /* colorMap */ KIND_COLOR);
    renderBars(drawerEl.querySelector('#usageByModel'), data.byModel || {});
    renderRecent(data.recent || []);
  } catch (e) {
    console.error('[usage] load failed', e);
    tbody.innerHTML = `<tr><td colspan="8" class="usage-empty">Ошибка: ${escapeHtml(e?.message || 'load failed')}</td></tr>`;
  }
}

function renderTotals(t) {
  const set = (k, v) => {
    const el = drawerEl.querySelector(`[data-k="${k}"]`);
    if (el) el.textContent = v;
  };
  set('calls',    String(t.calls || 0));
  set('cost',     formatUsd(t.costCents || 0));
  set('tokens',   `${formatNum(t.tokensIn || 0)} / ${formatNum(t.tokensOut || 0)}`);
  set('duration', formatDuration(t.durationMs || 0));
  set('failed',   String(t.failed || 0));
}

function renderBars(host, dict, labelMap = null, colorMap = null) {
  const entries = Object.entries(dict);
  if (!entries.length) {
    host.innerHTML = `<div class="usage-empty">Нет данных за выбранный период</div>`;
    return;
  }
  const max = Math.max(...entries.map(([, v]) => v.costCents || 0), 1);
  host.innerHTML = entries
    .sort((a, b) => (b[1].costCents || 0) - (a[1].costCents || 0))
    .map(([k, v]) => {
      const w = Math.max(((v.costCents || 0) / max) * 100, 4);
      const lbl   = labelMap?.[k] || k;
      const color = colorMap?.[k] || '#7c5cff';
      return /*html*/`
        <div class="usage-bar-row">
          <div class="usage-bar-lbl">${escapeHtml(lbl)}</div>
          <div class="usage-bar-track">
            <div class="usage-bar-fill" style="width:${w}%;background:${color};"></div>
          </div>
          <div class="usage-bar-meta">
            <span class="usage-bar-cost">${formatUsd(v.costCents || 0)}</span>
            <span class="usage-bar-calls">${v.calls || 0}× · ${formatDuration(v.durationMs || 0)}</span>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderRecent(rows) {
  const tbody = drawerEl.querySelector('#usageRecentBody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="usage-empty">Запусков пока нет</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r) => {
    const tokenStr = (r.tokensIn || r.tokensOut)
      ? `${formatNum(r.tokensIn || 0)} / ${formatNum(r.tokensOut || 0)}`
      : '—';
    const statusCls = r.status === 'done' ? 'ok' : (r.status === 'error' ? 'err' : 'mid');
    return /*html*/`
      <tr>
        <td title="${new Date(r.createdAt).toLocaleString()}">${formatRelative(r.createdAt)}</td>
        <td>${escapeHtml(KIND_LABEL[r.kind] || r.kind || '—')}</td>
        <td><code>${escapeHtml(r.model || '—')}</code></td>
        <td><span class="usage-status ${statusCls}">${escapeHtml(r.status)}</span></td>
        <td>${formatDuration(r.durationMs || 0)}</td>
        <td>${tokenStr}</td>
        <td>${formatUsd(r.costCents || 0)}</td>
        <td class="usage-proj">${escapeHtml(r.projectTitle || '—')}</td>
      </tr>
    `;
  }).join('');
}

/* ============= helpers ============= */
function formatUsd(cents) {
  const usd = (Number(cents) || 0) / 100;
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  if (usd < 1)   return '$' + usd.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return '$' + usd.toFixed(2);
}
function formatNum(n) {
  n = Number(n) || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}
function formatDuration(ms) {
  ms = Number(ms) || 0;
  if (ms < 1000) return ms + 'мс';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 'с';
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return m + 'м ' + rest + 'с';
}
function formatRelative(ts) {
  const diff = Date.now() - Number(ts);
  if (diff < 60_000) return 'только что';
  if (diff < 3600_000) return Math.floor(diff / 60_000) + ' мин назад';
  if (diff < 86_400_000) return Math.floor(diff / 3600_000) + ' ч назад';
  return new Date(ts).toLocaleDateString();
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

/* ============= Bind topbar button ============= */
const btn = document.getElementById('btnUsage');
if (btn) btn.addEventListener('click', () => openUsage());
