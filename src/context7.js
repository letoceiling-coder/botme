/**
 * Context7 client — подмешивает в системный промпт свежие сниппеты документации
 * для библиотек, которые модель собирается использовать. Без этого LLM часто
 * выдаёт устаревшие API (Tailwind v3 вместо v4, framer-motion CDN, lucide-react
 * вместо просто lucide и т.д.) — что и приводит к битым превью.
 *
 * Источник данных: https://context7.com/api/v2  (Bearer ctx7sk-...).
 *
 * Дизайн:
 *  • Простой fetch-клиент с in-memory кэшем (TTL 30 мин).
 *  • Словарь «известных» библиотек с заранее зафиксированными library-ID, чтобы
 *    избежать лишнего search-запроса в типовых случаях.
 *  • Безопасный фейл: при отсутствии ключа / ошибке / таймауте — возвращаем
 *    пустой результат, не ломая основной поток генерации.
 */

const API_BASE = 'https://context7.com/api/v2';
const DEFAULT_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map(); // key -> { ts, value }

/**
 * Канонические library-ID для библиотек, которые наш Site Builder реально
 * использует / которые модели любят. Названия подобраны под текст промпта.
 * При желании добавляйте сюда новые.
 */
// Канонические ID проверены вручную (см. .tmp-ctx-probe — для каждой библиотеки
// был выбран вариант с наибольшим trustScore и реальным `state: finalized`).
const KNOWN_LIBRARIES = {
  tailwind: '/tailwindlabs/tailwindcss.com',
  tailwindcss: '/tailwindlabs/tailwindcss.com',
  aos: '/michalsnik/aos',
  gsap: '/websites/gsap',
  swiper: '/nolimits4web/swiper',
  lucide: '/lucide-icons/lucide',
  alpine: '/alpinejs/alpine',
  alpinejs: '/alpinejs/alpine',
  htmx: '/bigskysoftware/htmx',
  threejs: '/mrdoob/three.js',
  three: '/mrdoob/three.js',
  react: '/reactjs/react.dev',
  nextjs: '/vercel/next.js',
  'animate.css': '/animate-css/animate.css',
};

/**
 * Список ключевых слов, при срабатывании которых мы дёргаем доки соответствующей
 * библиотеки. Регексы — case-insensitive по сырому тексту промпта.
 */
const TRIGGER_PATTERNS = [
  { lib: 'tailwindcss', re: /\btailwind(?:css)?\b/i },
  { lib: 'aos', re: /\b(?:aos|animate on scroll)\b/i },
  { lib: 'gsap', re: /\bgsap\b/i },
  { lib: 'swiper', re: /\bswiper\b/i },
  { lib: 'lucide', re: /\blucide\b/i },
  { lib: 'alpinejs', re: /\balpine(?:\.?js)?\b/i },
  { lib: 'htmx', re: /\bhtmx\b/i },
  { lib: 'threejs', re: /\bthree(?:\.?js)?\b/i },
  { lib: 'nextjs', re: /\bnext\.?js\b/i },
  { lib: 'react', re: /\breact\b/i },
  { lib: 'animate.css', re: /\banimate\.css\b/i },
];

/**
 * Достать API-ключ из env. Выходит из строя «беззвучно» — фича опциональна.
 */
function getApiKey() {
  return process.env.CONTEXT7_API_KEY || '';
}

export function isContext7Enabled() {
  // CONTEXT7_DISABLED=1 — kill-switch на проде, если что-то пошло не так.
  if (process.env.CONTEXT7_DISABLED === '1') return false;
  return Boolean(getApiKey());
}

function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return v.value;
}
function cacheSet(key, value) { cache.set(key, { ts: Date.now(), value }); }

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        Accept: 'text/plain, application/json',
      },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      const err = new Error(`Context7 ${r.status}: ${body.slice(0, 200)}`);
      err.status = r.status;
      err.body = body;
      throw err;
    }
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) return await r.json();
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Найти Context7 library-ID для свободного имени библиотеки.
 * Возвращает строку вида `/owner/repo` или null.
 */
export async function searchLibrary(libraryName, query = libraryName) {
  if (!isContext7Enabled()) return null;
  const cacheKey = `search:${libraryName.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  const url = `${API_BASE}/libs/search?libraryName=${encodeURIComponent(libraryName)}&query=${encodeURIComponent(query)}&fast=true`;
  try {
    const data = await fetchJson(url);
    const top = data?.results?.[0];
    const id = top?.id || null;
    cacheSet(cacheKey, id);
    return id;
  } catch (e) {
    cacheSet(cacheKey, null);
    return null;
  }
}

/**
 * Достать сниппеты документации для библиотеки по запросу. Возвращает строку
 * (формат txt) или пустую строку при ошибке/отсутствии данных.
 *
 * @param {string} libraryId  Например `/tailwindlabs/tailwindcss` или `/facebook/react`
 * @param {string} query      Естественно-языковой запрос («mobile-first responsive grid»)
 * @param {object} opts       { timeoutMs, maxChars, fast }
 */
export async function getContextDocs(libraryId, query, opts = {}) {
  if (!isContext7Enabled()) return '';
  if (!libraryId || !query) return '';
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxChars = 2400, fast = true } = opts;
  const cacheKey = `ctx:${libraryId}|${query.slice(0, 200)}|${fast}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  const url = `${API_BASE}/context?libraryId=${encodeURIComponent(libraryId)}&query=${encodeURIComponent(query.slice(0, 400))}&type=txt&fast=${fast ? 'true' : 'false'}`;
  try {
    const text = await fetchJson(url, { timeoutMs });
    const trimmed = trimToChars(String(text || ''), maxChars);
    cacheSet(cacheKey, trimmed);
    return trimmed;
  } catch (e) {
    // Library 301 redirect — пробуем перейти один раз.
    if (e?.status === 301 && e.body && opts._depth !== 1) {
      try {
        const j = JSON.parse(e.body);
        if (j?.redirectUrl && typeof j.redirectUrl === 'string') {
          return await getContextDocs(j.redirectUrl, query, { ...opts, _depth: 1 });
        }
      } catch {}
    }
    cacheSet(cacheKey, '');
    return '';
  }
}

function trimToChars(s, n) {
  if (s.length <= n) return s;
  // Срезаем по границе абзаца, чтобы не рвать сниппет посередине.
  const cut = s.slice(0, n);
  const lastBlank = cut.lastIndexOf('\n\n');
  return (lastBlank > n * 0.5 ? cut.slice(0, lastBlank) : cut) + '\n…';
}

/**
 * По тексту пользовательского промпта определить, какие библиотеки модель
 * скорее всего захочет использовать, и вернуть массив { name, libraryId }.
 *
 * Не обращается к сети — чистый regex по словарю TRIGGER_PATTERNS.
 */
export function detectLibrariesFromPrompt(promptText, { max = 3 } = {}) {
  if (!promptText) return [];
  const text = String(promptText);
  const out = [];
  const seen = new Set();
  for (const { lib, re } of TRIGGER_PATTERNS) {
    if (out.length >= max) break;
    if (re.test(text) && !seen.has(lib)) {
      seen.add(lib);
      const id = KNOWN_LIBRARIES[lib];
      if (id) out.push({ name: lib, libraryId: id });
    }
  }
  return out;
}

/**
 * Высокоуровневый помощник для /api/generate: по тексту промпта найти
 * релевантные библиотеки и вернуть готовый markdown-блок для системного
 * промпта. Безопасен: при ошибках возвращает пустую строку.
 *
 * @param {string} promptText
 * @param {object} opts { max, perLibChars, totalCharsBudget }
 * @returns {Promise<{ block: string, used: Array<{name, libraryId, chars}>, totalChars: number }>}
 */
export async function buildContextBlockForPrompt(promptText, opts = {}) {
  const { max = 3, perLibChars = 1800, totalCharsBudget = 5000 } = opts;
  const empty = { block: '', used: [], totalChars: 0 };
  if (!isContext7Enabled()) return empty;

  const libs = detectLibrariesFromPrompt(promptText, { max });
  if (!libs.length) return empty;

  const settled = await Promise.allSettled(
    libs.map((l) => getContextDocs(l.libraryId, promptText.slice(0, 400), {
      maxChars: perLibChars,
      fast: true,
    })),
  );

  const used = [];
  let total = 0;
  let block = '';
  for (let i = 0; i < libs.length; i++) {
    const r = settled[i];
    const text = r.status === 'fulfilled' ? r.value : '';
    if (!text) continue;
    if (total + text.length > totalCharsBudget) break;
    block += `\n\n## ${libs[i].name} (${libs[i].libraryId})\n${text}`;
    used.push({ name: libs[i].name, libraryId: libs[i].libraryId, chars: text.length });
    total += text.length;
  }
  if (!block) return empty;
  return {
    block: '\n\n============================================================\n📚 АКТУАЛЬНАЯ ДОКУМЕНТАЦИЯ (Context7) — используй именно эти примеры/API:\n============================================================' + block,
    used,
    totalChars: total,
  };
}

/**
 * Подобрать library-ID по свободному имени:
 *  1) ищем в KNOWN_LIBRARIES (точное совпадение по нормализованному ключу),
 *  2) если нет — searchLibrary через API.
 * Возвращает строку или null.
 */
export async function resolveLibraryId(libName) {
  if (!libName) return null;
  const key = String(libName).trim().toLowerCase();
  if (!key) return null;
  // Прямой словарь
  if (KNOWN_LIBRARIES[key]) return KNOWN_LIBRARIES[key];
  // Простые синонимы / частые опечатки
  const simplified = key
    .replace(/-?(react|vue|angular|js)$/, '')
    .replace(/[\s.]/g, '')
    .toLowerCase();
  if (KNOWN_LIBRARIES[simplified]) return KNOWN_LIBRARIES[simplified];
  // Ищем через API
  return await searchLibrary(libName);
}

/**
 * Получить блок документации по ЯВНОМУ списку имён библиотек (для tool-call
 * `context7_lookup` или для post-lookup по фактически использованным libs в коде).
 *
 * @param {string[]} libraryNames  ["tailwindcss", "react", ...]
 * @param {object} opts            { perLibChars, totalCharsBudget, query }
 */
export async function buildContextBlockForLibraries(libraryNames, opts = {}) {
  const { perLibChars = 1800, totalCharsBudget = 5000, query = 'usage examples' } = opts;
  const empty = { block: '', used: [], totalChars: 0 };
  if (!isContext7Enabled()) return empty;
  if (!Array.isArray(libraryNames) || !libraryNames.length) return empty;

  // Резолвим ID по каждому имени
  const resolved = [];
  for (const name of libraryNames.slice(0, 8)) {
    const id = await resolveLibraryId(name);
    if (id) resolved.push({ name: String(name), libraryId: id });
  }
  if (!resolved.length) return empty;

  const settled = await Promise.allSettled(
    resolved.map((l) => getContextDocs(l.libraryId, query, { maxChars: perLibChars, fast: true })),
  );
  const used = [];
  let total = 0;
  let block = '';
  for (let i = 0; i < resolved.length; i++) {
    const r = settled[i];
    const text = r.status === 'fulfilled' ? r.value : '';
    if (!text) continue;
    if (total + text.length > totalCharsBudget) break;
    block += `\n\n## ${resolved[i].name} (${resolved[i].libraryId})\n${text}`;
    used.push({ name: resolved[i].name, libraryId: resolved[i].libraryId, chars: text.length });
    total += text.length;
  }
  if (!block) return empty;
  return {
    block: '\n\n============================================================\n📚 АКТУАЛЬНАЯ ДОКУМЕНТАЦИЯ (Context7) — используй именно эти примеры/API:\n============================================================' + block,
    used,
    totalChars: total,
  };
}

/**
 * Найти библиотеки, которые ФАКТИЧЕСКИ используются в файлах проекта (по
 * CDN-URL и import-импортам). Возвращает массив имён без дубликатов, в
 * порядке частоты упоминания.
 */
export function detectLibrariesInFiles(filesObj) {
  if (!filesObj || typeof filesObj !== 'object') return [];
  const counts = new Map();
  const bump = (lib) => counts.set(lib, (counts.get(lib) || 0) + 1);
  const text = Object.values(filesObj).filter((s) => typeof s === 'string').join('\n').toLowerCase();
  // Тэблица регексов фактического использования (CDN или import).
  const usagePatterns = [
    { lib: 'tailwindcss',  re: /(cdn\.tailwindcss\.com|tailwindcss@\d|@tailwindcss)/ },
    { lib: 'react',        re: /(unpkg\.com\/react@|react@18|reactdom\.createroot|from\s+["']react["'])/ },
    { lib: 'aos',          re: /(unpkg\.com\/aos@|aos\.init|data-aos=)/ },
    { lib: 'gsap',         re: /(gsap\.|cdnjs\.cloudflare\.com\/ajax\/libs\/gsap|scrolltrigger)/ },
    { lib: 'swiper',       re: /(swiperjs|swiper\.|nolimits4web\/swiper|new\s+swiper)/ },
    { lib: 'lucide',       re: /(unpkg\.com\/lucide|lucide\.createicons|data-lucide=)/ },
    { lib: 'alpinejs',     re: /(alpinejs|x-data=|x-init=)/ },
    { lib: 'htmx',         re: /(htmx\.org|hx-get=|hx-post=)/ },
    { lib: 'threejs',      re: /(three\.js|three\.module|new\s+three\.|three@\d)/ },
    { lib: 'animate.css',  re: /(animate\.css|animate__|animate__animated)/ },
    { lib: 'particles.js', re: /particles\.js|particlesjs/ },
    { lib: 'chart.js',     re: /(chart\.js|new\s+chart\()/ },
    { lib: 'typed.js',     re: /(typed\.js|new\s+typed\()/ },
  ];
  for (const { lib, re } of usagePatterns) {
    if (re.test(text)) bump(lib);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([lib]) => lib);
}

/** Только для тестов. */
export function __resetContext7Cache() { cache.clear(); }
