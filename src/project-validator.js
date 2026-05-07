/**
 * Проверка целостности проекта, сгенерированного моделью.
 *
 * Цели:
 *  1) Поймать "Vite/Next/CRA-скелет" — index.html ссылается на /src/main.tsx и т.п.,
 *     которых модель не приложила. Превью таких сайтов всегда пустое.
 *  2) Найти любые локальные ссылки (src/href/import) на файлы, которых нет в наборе.
 *
 * Возвращает:
 *  {
 *    ok: boolean,
 *    hasFrameworkScaffold: boolean,
 *    scaffoldKind: 'vite' | 'next' | 'cra' | null,
 *    missing: Array<{ from: string, ref: string }>,
 *    referencedExternally: Array<{ from: string, ref: string }>,
 *  }
 */

const FRAMEWORK_PATTERNS = [
  { kind: 'vite', re: /(?:^|[\s"'(=])\/?(?:src\/main|src\/index)\.(?:tsx|jsx|ts|js)\b/i },
  { kind: 'vite', re: /(?:^|[\s"'(=])\/?vite\.svg\b/i },
  { kind: 'vite', re: /(?:^|[\s"'(=])\/?src\/(?:App|index|main)\.(?:tsx|jsx)\b/i },
  { kind: 'next', re: /\/_next\//i },
  { kind: 'cra',  re: /(?:^|[\s"'(=])\/?(?:static\/js\/main|static\/css\/main)\.[\w]+\.(?:js|css)/i },
];

/**
 * Глобальные имена/пакеты, которые модели любят подключить «через CDN», но у которых
 * НЕТ рабочей UMD-сборки на популярных CDN — в результате `window.X` остаётся undefined
 * и Babel падает на `Cannot destructure property 'motion' of 'window.FramerMotion'`.
 * Ловим как глобальный паттерн в любом файле проекта.
 */
const BAD_RUNTIME_PATTERNS = [
  { kind: 'framer-motion', re: /\bwindow\.FramerMotion\b/ },
  { kind: 'framer-motion', re: /\bunpkg\.com\/framer-motion\b/i },
  { kind: 'framer-motion', re: /\bcdn\.jsdelivr\.net\/npm\/framer-motion\b/i },
  { kind: 'react-router-dom', re: /\bwindow\.ReactRouterDOM\b/ },
  { kind: 'react-router-dom', re: /\bunpkg\.com\/react-router-dom\b/i },
  { kind: 'lucide-react', re: /\bwindow\.LucideReact\b/ },
  { kind: 'lucide-react', re: /\bunpkg\.com\/lucide-react\b/i },
  // ESM-импорты пакетов из npm в JSX/JS — без сборщика не работают.
  { kind: 'npm-import', re: /\bimport\s+[\w*{},\s]+\s+from\s+["'](?:react|react-dom|react-router(?:-dom)?|framer-motion|lucide-react|next\/[\w-]+|@?[\w@-]+\/[\w-]+)["']/ },
];

/** Внешние схемы — пропускаем. */
const EXTERNAL_SCHEME_RE = /^(?:https?:|data:|blob:|mailto:|tel:|sms:|javascript:|about:|#)/i;

/** Извлечь все ссылки из HTML/JS/CSS-источника файла. */
export function extractRefsFromHtml(html) {
  const refs = [];
  if (typeof html !== 'string' || !html) return refs;

  // <tag attr="value">
  const attrRe = /\b(?:src|href|action|poster|data-src)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  let m;
  while ((m = attrRe.exec(html)) !== null) {
    const v = (m[1] ?? m[2] ?? '').trim();
    if (v) refs.push(v);
  }
  // <script type="module"> import "..."
  const importRe = /\bimport\s+(?:[\w*{},\s]+\s+from\s+)?["']([^"']+)["']/g;
  while ((m = importRe.exec(html)) !== null) {
    const v = (m[1] ?? '').trim();
    if (v) refs.push(v);
  }
  // CSS @import url("...")
  const cssImportRe = /@import\s+(?:url\()?["']([^"')]+)["']/g;
  while ((m = cssImportRe.exec(html)) !== null) {
    const v = (m[1] ?? '').trim();
    if (v) refs.push(v);
  }
  return refs;
}

/** Нормализовать локальную ссылку относительно файла-источника. Возвращает null для внешних. */
export function normalizeLocalRef(ref, fromFile) {
  if (!ref || typeof ref !== 'string') return null;
  const trimmed = ref.trim();
  if (!trimmed) return null;
  if (EXTERNAL_SCHEME_RE.test(trimmed)) return null;
  if (trimmed.startsWith('//')) return null; // protocol-relative — внешние

  // Очистка: query/fragment/leading slash
  let clean = trimmed.split(/[?#]/)[0];
  if (!clean) return null;
  // Абсолютный путь от корня сайта = от корня проекта
  const startedWithSlash = /^[/]/.test(clean);
  if (startedWithSlash) clean = clean.replace(/^\/+/, '');
  if (!clean) return null;

  // Простое разрешение относительно директории fromFile (для не-абсолютных ссылок).
  const fromDir = (fromFile || 'index.html').replace(/[^/]+$/, '');
  const joined = startedWithSlash ? clean : (fromDir + clean);
  // Свернуть ./ и ../
  const out = collapsePath(joined);
  if (!out || out.startsWith('..')) return null;
  return out;
}

function collapsePath(p) {
  const parts = p.split('/');
  const out = [];
  for (const seg of parts) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

/** Контент стартового App.tsx из builder/template (ещё не реализован UI по запросу). */
export function isReactBundleAppPlaceholder(text) {
  if (!text || typeof text !== 'string') return false;
  // Любая из фирменных строк шаблона = всё ещё заглушка (модель может убрать только часть текста).
  if (/Шаблон react-bundle/i.test(text)) return true;
  if (
    /React\s*\+\s*Tailwind[^\n]{0,120}esbuild/i.test(text)
    && (/Здесь стартует/i.test(text) || /Замените содержимое/i.test(text))
  ) {
    return true;
  }
  return false;
}

/** Исходники, которые собирает esbuild: import from 'react' ≠ отсутствующий файл в проекте. */
export function isBundlerManagedSource(normName) {
  return /^src\/.+\.(tsx|ts|jsx|js|cjs|mjs)$/i.test(normName);
}

/** Корневой шаблон index.html ссылается на bundle.*; артефакты лежат в dist/. */
function projectContainsPath(fileSet, normalized) {
  if (fileSet.has(normalized)) return true;
  if (normalized === 'bundle.js' || normalized === 'bundle.css') {
    if (fileSet.has(`dist/${normalized}`)) return true;
  }
  return false;
}

/** Главная проверка. files: Map<string,string> или объект с тем же интерфейсом. */
export function validateProjectIntegrity(files) {
  const fileSet = files instanceof Map
    ? new Set([...files.keys()])
    : new Set(Object.keys(files || {}));
  const truncatedHtml = [];

  const missing = [];
  const referencedExternally = [];
  let hasFrameworkScaffold = false;
  let scaffoldKind = null;
  const badRuntime = []; // Array<{ kind, sample }>
  let reactBundlePlaceholder = false;

  const entries = files instanceof Map ? [...files.entries()] : Object.entries(files || {});

  for (const [name, content] of entries) {
    if (!/\.(html?|jsx?|tsx?|css|mjs|cjs)$/i.test(name)) continue;
    const text = content || '';
    const normName = String(name).replace(/\\/g, '/');
    if (/^src\/App\.tsx$/i.test(normName) && isReactBundleAppPlaceholder(text)) {
      reactBundlePlaceholder = true;
    }

    // Глобальные патологические паттерны — без UMD-сборки / npm-импорты в HTML/CDN.
    // В src/*.tsx импорты npm — норма для react-bundle (резолвит сборщик).
    for (const bp of BAD_RUNTIME_PATTERNS) {
      if (bp.kind === 'npm-import' && isBundlerManagedSource(normName)) continue;
      if (bp.re.test(text) && !badRuntime.some((b) => b.kind === bp.kind)) {
        const m = text.match(bp.re);
        badRuntime.push({ kind: bp.kind, from: name, sample: (m?.[0] || '').slice(0, 80) });
      }
    }

    // Файл оборвался по лимиту токенов?
    if (/\.html?$/i.test(name) && /^\s*<!doctype/i.test(text) && !/<\/html\s*>/i.test(text)) {
      // помечаем как «truncated» — отдельный флаг ниже
      truncatedHtml.push(name);
    }

    // Импорты и href внутри собираемого TS/JS не являются путями к статике превью.
    if (isBundlerManagedSource(normName)) continue;

    const refs = extractRefsFromHtml(text);
    for (const ref of refs) {
      // Скан scaffold-маркеров делаем по сырому ref, до нормализации.
      for (const fp of FRAMEWORK_PATTERNS) {
        if (fp.re.test(ref) && !hasFrameworkScaffold) {
          hasFrameworkScaffold = true;
          scaffoldKind = fp.kind;
        }
      }
      const local = normalizeLocalRef(ref, name);
      if (local === null) {
        if (EXTERNAL_SCHEME_RE.test((ref || '').trim())) {
          // внешний ресурс — ок
          continue;
        }
        // Не нормализуется и не внешний — игнорируем (например data-аттрибуты без url).
        continue;
      }
      if (!local) continue;
      if (!projectContainsPath(fileSet, local)) {
        missing.push({ from: name, ref: ref.trim(), normalized: local });
      } else {
        referencedExternally.push({ from: name, ref: ref.trim() });
      }
    }
  }

  // Уникализируем missing по normalized пути (ref может встречаться несколько раз).
  const seen = new Set();
  const missingUniq = [];
  for (const it of missing) {
    const key = `${it.from}|${it.normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    missingUniq.push(it);
  }

  return {
    ok: !hasFrameworkScaffold && missingUniq.length === 0 && badRuntime.length === 0 && truncatedHtml.length === 0
      && !reactBundlePlaceholder,
    hasFrameworkScaffold,
    scaffoldKind,
    missing: missingUniq,
    referencedExternally,
    badRuntime,
    truncatedHtml,
    reactBundlePlaceholder,
  };
}

/** Короткое описание проблемы для текстового сообщения и для retry-промпта. */
export function describeIntegrity(report) {
  if (!report) return '';
  const parts = [];
  if (report.hasFrameworkScaffold) {
    const kind = report.scaffoldKind || 'framework';
    const missingSamples = report.missing.slice(0, 3).map((m) => m.normalized || m.ref).join(', ');
    parts.push(`пустой ${kind}-скелет (ссылается на отсутствующие файлы${missingSamples ? `: ${missingSamples}` : ''})`);
  }
  if (report.badRuntime?.length) {
    const list = report.badRuntime.map((b) => b.kind).join(', ');
    parts.push(`использование пакетов без рабочей UMD-сборки на CDN: ${list} — превью падает с TypeError`);
  }
  if (report.missing?.length && !report.hasFrameworkScaffold) {
    const list = report.missing.slice(0, 5).map((m) => m.normalized || m.ref).join(', ');
    parts.push(`ссылки на отсутствующие файлы: ${list}`);
  }
  if (report.truncatedHtml?.length) {
    parts.push(`HTML обрезан (нет </html>) в ${report.truncatedHtml.join(', ')}`);
  }
  if (report.reactBundlePlaceholder) {
    parts.push('react-bundle: в src/App.tsx остался стартовый шаблон (заголовок/бейдж из template) — основной UI не заменён');
  }
  return parts.length ? `Проблемы: ${parts.join('; ')}.` : '';
}
