// Реальный smoke-тест на Playwright headless Chromium.
//
// Что ловит лучше jsdom-варианта:
//   • реальные pageerror (TypeError, ReferenceError из выполнения JS)
//   • console.error / console.warning от браузера
//   • requestfailed / 404 на CDN-ресурсах (битый Tailwind, неподключённый React UMD)
//   • белый экран (body.innerText.trim() === '')
//   • screenshot для UI-thumbnail
//
// API:
//   runRealSmoke(projectDir, { previewUrl, timeoutMs }) →
//     { ok, errors, warnings, failedRequests, bodyChars, screenshotPath }
//
// Опции:
//   PLAYWRIGHT_DISABLED=1 — глобально отключает Playwright (только jsdom-fallback).

import path from 'node:path';
import fs from 'node:fs/promises';

let _browser = null;       // переиспользуемый headless Chromium (один на процесс)
let _browserPromise = null;
let _browserUnavailable = false;

const DEFAULT_TIMEOUT_MS = 12_000;

export function isPlaywrightDisabled() {
  return process.env.PLAYWRIGHT_DISABLED === '1';
}

async function getBrowser() {
  if (_browserUnavailable) throw new Error('Playwright недоступен в этом инстансе');
  if (_browser) return _browser;
  if (_browserPromise) return await _browserPromise;
  _browserPromise = (async () => {
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch (e) {
      _browserUnavailable = true;
      throw new Error('Пакет playwright не установлен: ' + (e?.message || e));
    }
    try {
      const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      _browser = browser;
      // Чистим browser, если процесс гасится
      const cleanup = async () => { try { await browser.close(); } catch {} };
      process.once('exit', cleanup);
      process.once('SIGINT', cleanup);
      process.once('SIGTERM', cleanup);
      return browser;
    } catch (e) {
      _browserUnavailable = true;
      throw new Error('Не удалось запустить Chromium: ' + (e?.message || e));
    } finally {
      _browserPromise = null;
    }
  })();
  return await _browserPromise;
}

/**
 * Если Playwright недоступен (нет пакета, нет Chromium, отключён через env) — кидаем,
 * чтобы оркестратор сделал fallback на jsdom-smoke.
 */
export async function runRealSmoke(projectDir, opts = {}) {
  if (isPlaywrightDisabled()) {
    throw new Error('Playwright отключён через PLAYWRIGHT_DISABLED=1');
  }
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const previewUrl = opts.previewUrl;
  if (!previewUrl) throw new Error('runRealSmoke: previewUrl обязателен');

  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  const errors = [];
  const warnings = [];
  const failedRequests = [];

  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err?.message || String(err)}`);
  });
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') errors.push(`console.error: ${text}`);
    else if (type === 'warning' || type === 'warn') warnings.push(`console.warn: ${text}`);
  });
  page.on('requestfailed', (req) => {
    const failure = req.failure();
    failedRequests.push({
      url: req.url(),
      method: req.method(),
      reason: failure?.errorText || 'unknown',
      resourceType: req.resourceType(),
    });
  });
  page.on('response', (resp) => {
    const status = resp.status();
    const url = resp.url();
    // 4xx/5xx на ассеты — критичные ошибки (битые CDN-пути)
    if (status >= 400 && status < 600 && !url.startsWith('data:')) {
      const isAsset = /\.(css|js|png|jpe?g|svg|webp|woff2?|ttf|otf)(\?|$)/i.test(url)
        || resp.request().resourceType() !== 'document';
      if (isAsset) {
        failedRequests.push({
          url,
          method: resp.request().method(),
          reason: `HTTP ${status}`,
          resourceType: resp.request().resourceType(),
          status,
        });
      }
    }
  });

  let bodyChars = 0;
  let screenshotPath = null;
  let timedOut = false;

  try {
    await page.goto(previewUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // Дадим JS немного отработать (AOS / lucide / Babel)
    await page.waitForTimeout(Math.min(2500, Math.floor(timeoutMs / 4)));

    bodyChars = await page.evaluate(() => {
      try { return (document.body?.innerText || '').trim().length; } catch { return 0; }
    });

    // Сохраним скриншот для thumbnail; невалидный путь — не критично
    try {
      const dir = path.join(projectDir, '.smoke');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, 'screenshot.png');
      await page.screenshot({ path: file, fullPage: false });
      screenshotPath = file;
    } catch {}
  } catch (e) {
    if (e?.name === 'TimeoutError') {
      timedOut = true;
      errors.push(`timeout: страница не загрузилась за ${timeoutMs}ms`);
    } else {
      errors.push(`navigation: ${e?.message || String(e)}`);
    }
  } finally {
    try { await ctx.close(); } catch {}
  }

  // Уникализируем ошибки (часто один pageerror дублируется через console.error)
  const uniq = (arr) => Array.from(new Set(arr));
  const ok = !timedOut
    && errors.length === 0
    && failedRequests.filter((r) => r.resourceType !== 'image').length === 0  // битый image — не блокер
    && bodyChars > 0;

  return {
    ok,
    errors: uniq(errors).slice(0, 20),
    warnings: uniq(warnings).slice(0, 20),
    failedRequests: failedRequests.slice(0, 20),
    bodyChars,
    screenshotPath,
    runner: 'playwright',
  };
}

/** Закрыть переиспользуемый браузер. Полезно для тестов / shutdown-хуков. */
export async function closePlaywright() {
  if (_browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
  }
  _browserPromise = null;
  _browserUnavailable = false;
}
