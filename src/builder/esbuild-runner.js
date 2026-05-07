// React-bundle сборщик через esbuild + ручной Tailwind-PostCSS.
//
// Архитектура:
//   projects/<id>/
//     meta.json         (kind="react-bundle")
//     src/
//       main.tsx
//       App.tsx
//       components/...
//       styles/tailwind.css
//     package.json      (pinned dependencies)
//     tailwind.config.js
//     postcss.config.cjs
//     dist/             ← результат: index.html, bundle.js, bundle.css
//
// Зависимости (react, react-dom, framer-motion, lucide-react и т.д.) живут
// в SHARED-кэше /var/www/botme/data/node_cache/<hash>/node_modules. Для каждой
// уникальной комбинации deps делаем `npm i --prefix` ОДИН раз и потом
// симлинкаем node_modules в проект. Это избавляет от повторного npm i.
//
// Tailwind: используем @tailwindcss/cli или прямой PostCSS-pipe. Поддерживаем
// оба варианта: если есть @tailwindcss/cli — его, иначе — postcss CLI.
//
// API:
//   buildProject(projectDir) → { ok, durationMs, errors[], warnings[], outDir }
//   isBundleProject(projectDir) → boolean
//   cleanupOldCacheDirs(maxAgeMs) → { removed, remaining }

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const NODE_CACHE_ROOT = process.env.ESBUILD_CACHE_DIR
  || path.resolve(process.env.HOME || '/tmp', '.botme-node-cache');
const NPM_TIMEOUT_MS = 5 * 60 * 1000;

/** Публичный API: нормализация путей к ассетам в dist/index.html.
 * Превью открывается как /preview/<id>/..., статика монтируется из папки dist,
 * значит правильные ссылки — `./bundle.js` и `./bundle.css` (или без префикса).
 * Частая ошибка LLM: href="/dist/bundle.css" → браузер идёт на корень домена /dist/.
 */
export function normalizeBundleIndexHtml(html) {
  if (!html || typeof html !== 'string') return html;
  let s = html;
  // 1) Явное «./dist/» — только лишний сегмент dist
  s = s.replace(
    /\b(href|src)=(["'])\.\/dist\/(bundle\.(?:css|js))(\?\S*)?\2/gi,
    (m, attr, q, file, qs) => `${attr}=${q}./${file}${qs || ''}${q}`,
  );
  // 2) Полные URL и protocol-relative
  s = s.replace(/https?:\/\/[^\s"'<>]+\/dist\/(bundle\.css|bundle\.js)(\?[^\s"'<>]*)?/gi, './$1$2');
  s = s.replace(/\/\/[^\s"'<>]+\/dist\/(bundle\.css|bundle\.js)(\?[^\s"'<>]*)?/gi, './$1$2');
  // 3) /dist/bundle от корена — НЕ трогаем «./dist/» (иначе будет ../bundle)
  s = s.replace(/(?<!\.)\/dist\/bundle\.css(\?[^\s"'<>]*)?/gi, './bundle.css$1');
  s = s.replace(/(?<!\.)\/dist\/bundle\.js(\?[^\s"'<>]*)?/gi, './bundle.js$1');

  // Атрибуты со кавычками (после массовых замен — добиваем экзотические варианты)
  s = s.replace(
    /\b(href|src)=(["'])(https?:\/\/[^/"']+)\/dist\/(bundle\.(?:css|js))(\?\S*)?\2/gi,
    (m, attr, q, _host, file, qs) => `${attr}=${q}./${file}${qs || ''}${q}`,
  );
  s = s.replace(
    /\b(href|src)=(["'])\/dist\/(bundle\.(?:css|js))(\?\S*)?\2/gi,
    (m, attr, q, file, qs) => `${attr}=${q}./${file}${qs || ''}${q}`,
  );
  // href=/dist/bundle.css или src=/dist/bundle.js без кавычек
  s = s.replace(/\bhref\s*=\s*\/dist\/bundle\.css(\?[^\s>)]+)?/gi, 'href="./bundle.css$1"');
  s = s.replace(/\bsrc\s*=\s*\/dist\/bundle\.js(\?[^\s>)]+)?/gi, 'src="./bundle.js$1"');

  // /bundle.* от корня (ещё один анти-паттерн)
  s = s.replace(/\b(href)=(["'])\/bundle\.css(\?\S*)?\2/gi, (m, q, qs) => `href=${q}./bundle.css${qs || ''}${q}`);
  s = s.replace(/\b(src)=(["'])\/bundle\.js(\?\S*)?\2/gi, (m, q, qs) => `src=${q}./bundle.js${qs || ''}${q}`);
  return s;
}

export async function isBundleProject(projectDir) {
  try {
    const meta = JSON.parse(await fs.readFile(path.join(projectDir, 'meta.json'), 'utf8'));
    return meta?.kind === 'react-bundle';
  } catch {
    return false;
  }
}

async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }

function hashDeps(deps) {
  if (!deps || typeof deps !== 'object') return 'no-deps';
  const sorted = Object.keys(deps).map((k) => `${k}@${deps[k]}`).sort().join('|');
  return crypto.createHash('sha1').update(sorted).digest('hex').slice(0, 16);
}

/** LLM часто кладёт tailwind/postcss в devDependencies — а shared-cache ставит только `dependencies`. */
const MERGE_DEV_DEPS_FOR_BUILD = new Set([
  'tailwindcss',
  '@tailwindcss/cli',
  '@tailwindcss/postcss',
  'postcss',
  'postcss-cli',
  'autoprefixer',
  'tailwindcss-animate',
]);

function depsForBundlerCache(packageJson) {
  const out = { ...(packageJson.dependencies || {}) };
  const dev = packageJson.devDependencies || {};
  for (const k of MERGE_DEV_DEPS_FOR_BUILD) {
    const v = dev[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/**
 * Гарантирует наличие node_modules для проекта через shared cache.
 * Возвращает путь к node_modules, который будет залинкован/использован.
 */
async function ensureSharedDeps(projectDir, packageJson) {
  const deps = depsForBundlerCache(packageJson);
  const h = hashDeps(deps);
  const cacheRoot = path.join(NODE_CACHE_ROOT, h);
  const cacheNm = path.join(cacheRoot, 'node_modules');
  const cachePj = path.join(cacheRoot, 'package.json');

  await ensureDir(cacheRoot);

  // Если кеша нет — создаём минимальный package.json и npm i
  let needInstall = false;
  try { await fs.access(cacheNm); }
  catch { needInstall = true; }

  if (needInstall) {
    await fs.writeFile(cachePj, JSON.stringify({
      name: 'botme-shared-cache',
      version: '1.0.0',
      private: true,
      dependencies: deps,
    }, null, 2));
    try {
      await execFileP('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', '--prefix', cacheRoot], {
        timeout: NPM_TIMEOUT_MS,
        env: { ...process.env, NODE_ENV: 'production' },
      });
    } catch (e) {
      throw new Error('npm install в shared cache упал: ' + (e?.stderr || e?.message || e));
    }
  }

  // Линкуем node_modules в проект (через ln -s, перезаписываем если есть)
  const projNm = path.join(projectDir, 'node_modules');
  try { await fs.rm(projNm, { recursive: true, force: true }); } catch {}
  await fs.symlink(cacheNm, projNm, 'dir');

  return cacheNm;
}

/**
 * Собрать проект:
 *   1. Прочитать package.json + tailwind.config.js
 *   2. ensureSharedDeps → симлинк node_modules
 *   3. esbuild API на src/main.tsx → dist/bundle.js
 *   4. tailwind/postcss на src/styles/tailwind.css → dist/bundle.css
 *   5. сгенерировать dist/index.html, если его нет
 */
export async function buildProject(projectDir, opts = {}) {
  const t0 = Date.now();
  const errors = [];
  const warnings = [];

  let pj;
  try {
    pj = JSON.parse(await fs.readFile(path.join(projectDir, 'package.json'), 'utf8'));
  } catch (e) {
    return { ok: false, errors: ['package.json не найден или битый: ' + (e?.message || e)], warnings, durationMs: Date.now() - t0 };
  }

  const distDir = path.join(projectDir, 'dist');
  await ensureDir(distDir);

  // 1) Зависимости
  try {
    await ensureSharedDeps(projectDir, pj);
  } catch (e) {
    return { ok: false, errors: [e.message], warnings, durationMs: Date.now() - t0, outDir: distDir };
  }

  // 2) esbuild
  let esbuild;
  try {
    esbuild = (await import('esbuild')).default || (await import('esbuild'));
  } catch (e) {
    return { ok: false, errors: ['esbuild не установлен: ' + (e?.message || e)], warnings, durationMs: Date.now() - t0, outDir: distDir };
  }

  const entry = await pickEntryPoint(projectDir);
  if (!entry) {
    return { ok: false, errors: ['Не найден entry point (src/main.tsx | src/main.jsx | src/index.tsx)'], warnings, durationMs: Date.now() - t0, outDir: distDir };
  }

  try {
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      outfile: path.join(distDir, 'bundle.js'),
      format: 'esm',
      platform: 'browser',
      target: ['es2020'],
      minify: !opts.dev,
      sourcemap: !!opts.dev,
      loader: { '.tsx': 'tsx', '.ts': 'ts', '.jsx': 'jsx', '.js': 'jsx', '.css': 'css', '.svg': 'dataurl', '.png': 'dataurl' },
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': JSON.stringify(opts.dev ? 'development' : 'production') },
      logLevel: 'silent',
      absWorkingDir: projectDir,
    });
    for (const w of result.warnings || []) warnings.push(`esbuild: ${w.text}`);
    for (const e of result.errors || []) errors.push(`esbuild: ${e.text}`);
  } catch (e) {
    errors.push('esbuild crashed: ' + (e?.message || e));
  }

  // 3) Tailwind/PostCSS — если есть src/styles/tailwind.css
  const tailwindEntry = await firstExisting([
    path.join(projectDir, 'src', 'styles', 'tailwind.css'),
    path.join(projectDir, 'src', 'tailwind.css'),
    path.join(projectDir, 'src', 'index.css'),
  ]);
  if (tailwindEntry) {
    try {
      const cssOut = path.join(distDir, 'bundle.css');
      await runTailwindBuild(projectDir, tailwindEntry, cssOut, opts.dev);
    } catch (e) {
      // Иначе esbuild оставит сырые @tailwind в dist/bundle.css и превью «ломается» без ошибок сборки.
      errors.push('Tailwind/PostCSS: ' + (e?.message || e));
    }
  }

  // 4) index.html — если его нет в dist, генерируем дефолтный
  const indexPath = path.join(distDir, 'index.html');
  let hasIndex = false;
  try { await fs.access(indexPath); hasIndex = true; } catch {}
  if (!hasIndex) {
    const userIndex = await firstExisting([
      path.join(projectDir, 'index.html'),
      path.join(projectDir, 'src', 'index.html'),
    ]);
    if (userIndex) {
      let html = await fs.readFile(userIndex, 'utf8');
      // Подменим entry-импорт на bundle.js
      html = html.replace(/<script[^>]*src="\/?src\/main\.tsx"[^>]*>\s*<\/script>/i, '<script type="module" src="bundle.js"></script>');
      html = html.replace(/<link[^>]*href="\/?src\/styles\/tailwind\.css"[^>]*>/i, '<link rel="stylesheet" href="bundle.css">');
      // Если нет ссылок на bundle.js — добавим
      if (!/bundle\.js/.test(html)) {
        html = html.replace(/<\/body>/i, '  <script type="module" src="bundle.js"></script>\n</body>');
      }
      if (!/bundle\.css/.test(html) && tailwindEntry) {
        html = html.replace(/<\/head>/i, '  <link rel="stylesheet" href="bundle.css">\n</head>');
      }
      html = normalizeBundleIndexHtml(html);
      await fs.writeFile(indexPath, html, 'utf8');
    } else {
      // Дефолтный шаблон
      await fs.writeFile(indexPath, defaultIndexHtml(pj.name || 'app', !!tailwindEntry), 'utf8');
    }
  }

  // Всегда нормализуем пути к bundle.* (LLM часто пишет /dist/bundle.* — ломает /preview/<id>/)
  try {
    const cur = await fs.readFile(indexPath, 'utf8');
    const fixed = normalizeBundleIndexHtml(cur);
    if (fixed !== cur) await fs.writeFile(indexPath, fixed, 'utf8');
  } catch { /* нет index */ }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    durationMs: Date.now() - t0,
    outDir: distDir,
    entry,
  };
}

async function pickEntryPoint(projectDir) {
  for (const rel of ['src/main.tsx', 'src/main.jsx', 'src/index.tsx', 'src/index.jsx', 'src/main.ts']) {
    const abs = path.join(projectDir, rel);
    try { await fs.access(abs); return abs; } catch {}
  }
  return null;
}

async function firstExisting(paths) {
  for (const p of paths) {
    try { await fs.access(p); return p; } catch {}
  }
  return null;
}

function defaultIndexHtml(title, hasCss) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
${hasCss ? '<link rel="stylesheet" href="bundle.css">' : ''}
</head>
<body>
<div id="root"></div>
<script type="module" src="bundle.js"></script>
</body>
</html>
`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/**
 * Tailwind build через @tailwindcss/cli (если есть в node_modules) или
 * через postcss CLI. Используем npx с явным --prefix=projectDir.
 */
async function runTailwindBuild(projectDir, inputCss, outputCss, dev) {
  // Попытка 1: @tailwindcss/cli (Tailwind v4) — самый быстрый путь
  const tailwindCli = path.join(projectDir, 'node_modules', '.bin', 'tailwindcss');
  let exists = false;
  try { await fs.access(tailwindCli); exists = true; } catch {}
  if (exists) {
    await new Promise((resolve, reject) => {
      const child = spawn(tailwindCli, [
        '-i', inputCss,
        '-o', outputCss,
        ...(dev ? [] : ['--minify']),
      ], { cwd: projectDir, env: process.env });
      let stderr = '';
      child.stderr.on('data', (b) => { stderr += b.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tailwindcss exit ${code}: ${stderr.slice(0, 500)}`));
      });
      setTimeout(() => { child.kill('SIGTERM'); reject(new Error('tailwindcss timeout')); }, 60_000);
    });
    return;
  }
  // Попытка 2: postcss с tailwind/autoprefixer плагинами (PostCSS 8)
  const postcssCli = path.join(projectDir, 'node_modules', '.bin', 'postcss');
  try { await fs.access(postcssCli); exists = true; } catch { exists = false; }
  if (exists) {
    await new Promise((resolve, reject) => {
      const child = spawn(postcssCli, [
        inputCss, '-o', outputCss,
        ...(dev ? [] : ['--env', 'production']),
      ], { cwd: projectDir, env: process.env });
      let stderr = '';
      child.stderr.on('data', (b) => { stderr += b.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`postcss exit ${code}: ${stderr.slice(0, 500)}`));
      });
      setTimeout(() => { child.kill('SIGTERM'); reject(new Error('postcss timeout')); }, 60_000);
    });
    return;
  }
  throw new Error('Ни tailwindcss CLI, ни postcss CLI не найдены в node_modules/.bin');
}

/**
 * Удалить кеши node_modules старше maxAgeMs. Запускается раз в сутки.
 */
export async function cleanupOldCacheDirs(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
  let dirs;
  try { dirs = await fs.readdir(NODE_CACHE_ROOT, { withFileTypes: true }); }
  catch { return { removed: 0, remaining: 0 }; }
  let removed = 0;
  let remaining = 0;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const sub = path.join(NODE_CACHE_ROOT, d.name);
    try {
      const stat = await fs.stat(sub);
      if (Date.now() - stat.mtimeMs > maxAgeMs) {
        await fs.rm(sub, { recursive: true, force: true });
        removed += 1;
      } else {
        remaining += 1;
      }
    } catch {
      remaining += 1;
    }
  }
  return { removed, remaining };
}
