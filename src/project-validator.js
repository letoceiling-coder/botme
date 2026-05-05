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

/** Главная проверка. files: Map<string,string> или объект с тем же интерфейсом. */
export function validateProjectIntegrity(files) {
  const fileSet = files instanceof Map
    ? new Set([...files.keys()])
    : new Set(Object.keys(files || {}));

  const missing = [];
  const referencedExternally = [];
  let hasFrameworkScaffold = false;
  let scaffoldKind = null;

  const entries = files instanceof Map ? [...files.entries()] : Object.entries(files || {});

  for (const [name, content] of entries) {
    if (!/\.(html?|jsx?|tsx?|css|mjs|cjs)$/i.test(name)) continue;
    const refs = extractRefsFromHtml(content || '');
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
      if (!fileSet.has(local)) {
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
    ok: !hasFrameworkScaffold && missingUniq.length === 0,
    hasFrameworkScaffold,
    scaffoldKind,
    missing: missingUniq,
    referencedExternally,
  };
}

/** Короткое описание проблемы для текстового сообщения и для retry-промпта. */
export function describeIntegrity(report) {
  if (!report) return '';
  if (report.hasFrameworkScaffold) {
    const kind = report.scaffoldKind || 'framework';
    const missingSamples = report.missing.slice(0, 3).map((m) => m.normalized || m.ref).join(', ');
    return `Ответ модели — пустой ${kind}-скелет (ссылается на отсутствующие файлы${missingSamples ? `: ${missingSamples}` : ''}). Превью будет пустым.`;
  }
  if (report.missing.length) {
    const list = report.missing.slice(0, 5).map((m) => m.normalized || m.ref).join(', ');
    return `В проекте есть ссылки на файлы, которых модель не приложила: ${list}.`;
  }
  return '';
}
