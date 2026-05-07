/**
 * Runtime smoke-тест собранного index.html.
 *
 * Цель: ловить классические fail'ы превью ДО того, как пользователь увидит
 * белый экран и stack trace в консоли:
 *  - `Cannot destructure property 'motion' of 'window.FramerMotion' as it is undefined`
 *  - `ReactDOM is not defined`
 *  - `Uncaught SyntaxError`
 *  - пустой `<body>` (рендер ничего не отдал)
 *
 * Используем jsdom БЕЗ выполнения внешних `<script src="https://...">` — мы
 * не хотим тянуть Tailwind/Babel/React по сети при каждой генерации. Зато
 * мы статически анализируем встроенный код и пробуем выполнить inline
 * `<script>` без `type="module"|"text/babel"` (обычный JS) с заглушками
 * для глобалок.
 *
 * Возвращает: { ok, errors: string[], warnings: string[] }.
 */

import { JSDOM, VirtualConsole } from 'jsdom';

const SMOKE_TIMEOUT_MS = 4000;

export async function smokeTestHtml(html, opts = {}) {
  const out = { ok: true, errors: [], warnings: [] };
  if (!html || typeof html !== 'string') {
    out.ok = false; out.errors.push('пустой index.html');
    return out;
  }

  // Базовая статика: явные маркеры обрыва / дубликата.
  if (!/<\/html\s*>/i.test(html)) {
    out.ok = false; out.errors.push('HTML не закрыт </html> (обрыв по токенам)');
  }
  if (/window\.FramerMotion/.test(html) && !/unpkg\.com\/framer-motion/i.test(html)) {
    out.ok = false; out.errors.push('используется window.FramerMotion, но скрипта framer-motion нет');
  }
  // Babel + JSX внутри inline-скриптов без `type="text/babel"`?
  const inlineScriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let mm;
  while ((mm = inlineScriptRe.exec(html)) !== null) {
    const attrs = mm[1] || '';
    const code = mm[2] || '';
    const hasJsx = /<\w+[\s>][\s\S]*?<\/\w+>/.test(code) || /\breturn\s*\(\s*</.test(code);
    const isModule = /type\s*=\s*["']module["']/i.test(attrs);
    const isBabel = /type\s*=\s*["']text\/babel["']/i.test(attrs);
    const isJson = /type\s*=\s*["']application\/(?:ld\+)?json["']/i.test(attrs);
    if (hasJsx && !isBabel && !isJson) {
      out.warnings.push('inline-скрипт похож на JSX, но без type="text/babel"');
    }
    if (isModule && /\bimport\s+[\w*{},\s]+\s+from\s+["'](?:react|react-dom|framer-motion|react-router-dom|lucide-react)["']/.test(code)) {
      out.ok = false; out.errors.push('ESM-импорт из npm-пакета без сборщика');
    }
  }

  // Тест в jsdom — выполняем только обычные inline-скрипты, внешние не грузим.
  const vc = new VirtualConsole();
  const jsErrors = [];
  vc.on('jsdomError', (err) => {
    const msg = err?.message || String(err);
    // Игнорируем ошибки парсинга `text/babel` — там JSX, и это нормально без Babel.
    if (/Could not parse CSS stylesheet/i.test(msg)) return;
    jsErrors.push(msg);
  });
  vc.on('error', (msg) => jsErrors.push(String(msg)));

  let dom;
  try {
    dom = new JSDOM(html, {
      runScripts: 'outside-only', // не выполняем встроенный JS автоматически
      resources: undefined,        // НЕ грузим внешние ресурсы (tailwind/babel/react)
      pretendToBeVisual: true,
      virtualConsole: vc,
    });
  } catch (e) {
    out.ok = false; out.errors.push('jsdom: ' + (e?.message || String(e)));
    return out;
  }

  try {
    const doc = dom.window.document;
    const bodyText = (doc.body?.innerHTML || '').trim();
    if (!bodyText) {
      out.warnings.push('пустой <body> до выполнения скриптов');
    }
    // Ручной прогон обычных inline-скриптов (НЕ module и НЕ babel) — детектим
    // явный ReferenceError / TypeError на этапе синхронного init.
    const scripts = doc.querySelectorAll('script:not([type]):not([src]), script[type="text/javascript"]:not([src])');
    for (const s of scripts) {
      const code = s.textContent || '';
      if (!code.trim()) continue;
      try {
        await runWithTimeout(dom, code, SMOKE_TIMEOUT_MS);
      } catch (e) {
        const msg = e?.message || String(e);
        // Ошибки из-за отсутствия глобалок (Tailwind/AOS/lucide) — это норм:
        // на превью они подгрузятся через CDN, в jsdom их нет.
        if (/AOS is not defined|lucide is not defined|tailwind is not defined|gsap is not defined/i.test(msg)) {
          continue;
        }
        out.ok = false; out.errors.push(`runtime: ${msg.slice(0, 200)}`);
      }
    }
  } finally {
    try { dom.window.close(); } catch {}
  }

  if (jsErrors.length) {
    for (const e of jsErrors.slice(0, 3)) out.warnings.push(`jsdom-warning: ${String(e).slice(0, 200)}`);
  }

  if (opts.requireBodyContent && !out.errors.length) {
    const bodyChars = (dom?.window?.document?.body?.innerHTML || '').length;
    if (bodyChars < 200) out.warnings.push('очень короткий <body> — возможно, рендер пустой');
  }

  return out;
}

function runWithTimeout(dom, code, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('inline script timeout'));
    }, ms);
    try {
      dom.window.eval(code);
      if (!done) { done = true; clearTimeout(timer); resolve(); }
    } catch (e) {
      if (!done) { done = true; clearTimeout(timer); reject(e); }
    }
  });
}
