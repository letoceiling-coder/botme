// PhaseTimeline — компактный визуальный таймлайн фаз агента генерации.
//
// Использование:
//   const tl = createPhaseTimeline(containerEl, { mode: 'fresh' });
//   tl.startPhase('brief');
//   tl.donePhase('brief');
//   tl.errorPhase('coder', 'rate_limit');
//   tl.toolCall('apply_patch', { path: 'index.html' });
//   tl.toolResult('apply_patch', { ok: true, deltaLines: -2 });
//   tl.warn('Anthropic квота кончилась, fallback на gpt-4o');
//   tl.complete();
//
// API возвращает функцию destroy(), чтобы убрать таймлайн при следующей генерации.

const PHASES = [
  { id: 'brief',     label: 'Бриф',         icon: '📝' },
  { id: 'architect', label: 'Архитектура',  icon: '🧱' },
  { id: 'context7',  label: 'Документация', icon: '📚' },
  { id: 'coder',     label: 'Кодинг',       icon: '⚙️' },
  { id: 'smoke',     label: 'Тест',         icon: '🧪' },
  { id: 'autofix',   label: 'Починка',      icon: '🔧' },
  { id: 'reviewer',  label: 'Ревью',        icon: '✨' },
];

const STATUS_LABELS = {
  pending: 'ожидает',
  running: 'идёт…',
  done:    'готово',
  skipped: 'пропущено',
  error:   'ошибка',
};

function makeEl(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('data-')) el.setAttribute(k, v);
    else el[k] = v;
  }
  for (const c of children) {
    if (c) el.appendChild(c);
  }
  return el;
}

export function createPhaseTimeline(container, opts = {}) {
  if (!container) throw new Error('createPhaseTimeline: container обязателен');

  const mode = opts.mode || 'fresh';
  const wrap = makeEl('div', { class: 'phase-timeline' });

  const header = makeEl('div', { class: 'pt-header' });
  const titleEl = makeEl('div', { class: 'pt-title', text: mode === 'patch' ? 'Правка' : 'Сборка' });
  const elapsedEl = makeEl('div', { class: 'pt-elapsed', text: '0:00' });
  header.append(titleEl, elapsedEl);

  const stepsRow = makeEl('div', { class: 'pt-steps' });
  const stepsByPhase = {};

  // В patch-режиме скрываем фазы brief/architect — они пропускаются
  const visiblePhases = mode === 'patch'
    ? PHASES.filter((p) => !['brief', 'architect'].includes(p.id))
    : PHASES;

  for (const ph of visiblePhases) {
    const dot = makeEl('div', { class: 'pt-dot', text: ph.icon });
    const lbl = makeEl('div', { class: 'pt-lbl', text: ph.label });
    const status = makeEl('div', { class: 'pt-status', text: STATUS_LABELS.pending });
    const step = makeEl('div', { class: 'pt-step', 'data-phase': ph.id, 'data-status': 'pending' }, [dot, lbl, status]);
    stepsRow.appendChild(step);
    stepsByPhase[ph.id] = { el: step, statusEl: status };
  }

  const log = makeEl('div', { class: 'pt-log' });
  const toggle = makeEl('button', {
    class: 'pt-log-toggle', type: 'button',
    text: '▾ Лог tool-calls (0)',
  });
  toggle.addEventListener('click', () => {
    const open = log.classList.toggle('open');
    toggle.textContent = (open ? '▴' : '▾') + ' Лог tool-calls (' + logCount + ')';
  });

  const warnsEl = makeEl('div', { class: 'pt-warns' });

  wrap.append(header, stepsRow, warnsEl, toggle, log);
  container.innerHTML = '';
  container.appendChild(wrap);

  let started = Date.now();
  let elapsedTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - started) / 1000);
    elapsedEl.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }, 1000);

  let logCount = 0;
  function pushLog(html, kind) {
    logCount += 1;
    toggle.textContent = (log.classList.contains('open') ? '▴' : '▾') + ' Лог tool-calls (' + logCount + ')';
    const row = makeEl('div', { class: 'pt-log-row' + (kind ? ' k-' + kind : ''), html });
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  function setStatus(phase, status, note) {
    const s = stepsByPhase[phase];
    if (!s) return;
    s.el.dataset.status = status;
    s.statusEl.textContent = note || STATUS_LABELS[status] || status;
  }

  return {
    startPhase(phase) { setStatus(phase, 'running'); },
    donePhase(phase, summary) {
      const note = summarySnippet(phase, summary);
      setStatus(phase, 'done', note);
    },
    skipPhase(phase, reason) { setStatus(phase, 'skipped', reason ? `пропущено · ${reason}` : 'пропущено'); },
    errorPhase(phase, message) { setStatus(phase, 'error', message ? message.slice(0, 60) : 'ошибка'); },
    toolCall(name, args) {
      pushLog(`<b>${escapeHtml(name)}</b> · <span class="pt-args">${escapeHtml(formatArgs(args))}</span>`, 'call');
    },
    toolResult(name, ok, summary) {
      const sumStr = summary ? formatArgs(summary) : (ok ? 'ok' : 'fail');
      pushLog(
        `<span class="pt-arrow">↳</span> <b>${escapeHtml(name)}</b>: <span class="${ok ? 'pt-ok' : 'pt-err'}">${escapeHtml(sumStr)}</span>`,
        ok ? 'res-ok' : 'res-err',
      );
    },
    warn(message) {
      const row = makeEl('div', { class: 'pt-warn', text: '⚠ ' + (message || '') });
      warnsEl.appendChild(row);
    },
    coderToken(_delta) { /* пока не отображаем дельты — слишком шумно */ },
    complete(state = 'done', message) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
      wrap.classList.add('pt-complete');
      if (state === 'error') {
        wrap.classList.add('pt-error');
        if (message) {
          const row = makeEl('div', { class: 'pt-warn pt-fatal', text: '❌ ' + message });
          warnsEl.appendChild(row);
        }
      }
    },
    destroy() {
      if (elapsedTimer) clearInterval(elapsedTimer);
      wrap.remove();
    },
  };
}

function summarySnippet(phase, summary) {
  if (!summary) return STATUS_LABELS.done;
  switch (phase) {
    case 'brief':     return `${summary.kind || ''} · секций: ${summary.sections || 0}`;
    case 'architect': return `${summary.kind || 'static'} · ${(summary.libraries || []).slice(0, 3).join(', ')}`;
    case 'context7':  return summary.libraries?.length ? `${summary.libraries.length} либ · ${summary.chars} симв.` : 'нет либ';
    case 'coder':     return `итераций: ${summary.iterations || 0} · tools: ${summary.tools || 0}`;
    case 'smoke':     return summary.ok ? '✅ чисто' : `⚠ ${(summary.errors || []).length || 0} ошибок`;
    case 'autofix':   return summary.fixed ? `починено за ${summary.rounds} раунд(ов)` : `не починено (${summary.rounds})`;
    case 'reviewer':  return `${summary.suggestions || 0} предложений${summary.rating ? ` · ${summary.rating}` : ''}`;
    default:          return STATUS_LABELS.done;
  }
}

function formatArgs(args) {
  if (!args) return '';
  if (typeof args === 'string') return args;
  try {
    const trimmed = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string' && v.length > 80) trimmed[k] = v.slice(0, 80) + '…';
      else if (Array.isArray(v)) trimmed[k] = v.length > 4 ? v.slice(0, 4).concat(`+${v.length - 4}`) : v;
      else trimmed[k] = v;
    }
    return JSON.stringify(trimmed)
      .replace(/^\{/, '').replace(/\}$/, '')
      .replace(/"([^"]+)":/g, '$1=')
      .replace(/,(\S)/g, ', $1');
  } catch {
    return '';
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
