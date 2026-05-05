// Парсинг документов разных типов и чанкинг текста на ~600-токенные кусочки.
import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import mammoth from 'mammoth';
import { encode } from 'gpt-tokenizer';
import { createRequire } from 'node:module';

// pdf-parse — CJS пакет, ESM-импорт верхнего уровня запускает их test-script.
// Обходим через createRequire + lazy load внутри parsePdfFile.
const require = createRequire(import.meta.url);
let _pdfParse = null;
function getPdfParse() {
  if (!_pdfParse) _pdfParse = require('pdf-parse');
  return _pdfParse;
}

// =============================================================
// Парсинг по типу
// =============================================================

export async function parseTextFile(filePath) {
  return await fs.readFile(filePath, 'utf8');
}

export async function parsePdfFile(filePath) {
  const buf = await fs.readFile(filePath);
  const r = await getPdfParse()(buf);
  return cleanWhitespace(r.text || '');
}

export async function parseDocxFile(filePath) {
  const buf = await fs.readFile(filePath);
  const r = await mammoth.extractRawText({ buffer: buf });
  return cleanWhitespace(r.value || '');
}

// =============================================================
// Главная функция: всегда комбинирует ВСЕ доступные источники
// (статический HTML + мета+JSON-LD + JS-rendered через r.jina.ai)
// и собирает максимально полный текст. Это критично для SPA, где
// в исходном HTML только <div id="root"></div>.
// =============================================================
export async function fetchAndParseUrl(url) {
  // Параллельно: качаем статический HTML и идём в Jina (рендерит JS).
  // Оба источника обычно дают разную, но дополняющую информацию:
  //   - static HTML: title, meta, JSON-LD (контакты, schema.org, цены)
  //   - jina:        реально отрендеренный markdown (продукты, тексты)
  const [htmlRes, jinaRes] = await Promise.allSettled([
    downloadHtml(url),
    fetchViaJinaReader(url),
  ]);

  let title = '';
  const parts = [];

  if (htmlRes.status === 'fulfilled' && htmlRes.value) {
    const html = htmlRes.value;
    const main = extractMainContent(html, url);
    const meta = extractMetaAndJsonLd(html);
    if (main.title)  title = main.title;
    if (!title && meta.title) title = meta.title;
    if (meta.text)        parts.push({ src: 'meta',  text: meta.text });
    if (main.content)     parts.push({ src: 'main',  text: main.content });
  }

  if (jinaRes.status === 'fulfilled' && jinaRes.value) {
    parts.push({ src: 'jina', text: jinaRes.value });
  }

  // Дедупликация: если статический парсинг дал маленький body (SPA),
  // а jina дала длинный — оставляем только jina + мета.
  // Если статический парсинг был полноценный (SSR) — оставляем его и игнорим jina.
  const combined = combineSources(parts, title);

  if (combined.content.length < 50) {
    throw new Error(
      'Не удалось извлечь текст со страницы. Возможно, доступ закрыт авторизацией ' +
      'или сайт блокирует ботов. Попробуйте загрузить файл или вставить текст вручную.',
    );
  }

  return { title: combined.title || title || url, content: combined.content };
}

function combineSources(parts, title) {
  const meta = parts.find((p) => p.src === 'meta');
  const main = parts.find((p) => p.src === 'main');
  const jina = parts.find((p) => p.src === 'jina');

  const out = [];

  // Заголовок-метка
  if (title) out.push(`# ${title}`);

  // Мета и JSON-LD идут первыми — это структурированные факты (контакты, цены, услуги).
  if (meta && meta.text && meta.text.length > 30) {
    out.push('## Структурированная информация (мета-теги, schema.org)');
    out.push(meta.text);
  }

  // Основной текст: предпочитаем больший по объёму из main/jina.
  // Если оба пустые — берём что есть. Если оба длинные — берём оба
  // (jina может содержать данные которых нет в main и наоборот).
  const mainLen = main?.text?.length || 0;
  const jinaLen = jina?.text?.length || 0;

  if (mainLen >= 800 && jinaLen >= 800) {
    out.push('## Содержимое страницы (статический HTML)');
    out.push(main.text);
    out.push('## Содержимое страницы (рендеренная версия)');
    out.push(jina.text);
  } else if (jinaLen > mainLen) {
    if (jina && jina.text) {
      out.push('## Содержимое страницы');
      out.push(jina.text);
    }
  } else if (main && main.text) {
    out.push('## Содержимое страницы');
    out.push(main.text);
  }

  return { title, content: out.join('\n\n').trim() };
}

// =============================================================
// Sitemap crawler: даёт корневой URL — обходим до N страниц
// =============================================================

/**
 * Поиск URL'ов сайта через sitemap.xml и/или fallback-обход домашней страницы.
 *
 * @param {string} startUrl  любой URL сайта (например https://example.com/)
 * @param {object} opts
 * @param {number} opts.maxPages   жёсткий лимит, по умолчанию 30
 * @param {boolean} opts.sameOriginOnly  только тот же хост, по умолчанию true
 * @returns {Promise<string[]>}  массив абсолютных URL, начиная с самого startUrl
 */
export async function discoverSiteUrls(startUrl, { maxPages = 30, sameOriginOnly = true } = {}) {
  const base = new URL(startUrl);
  const origin = base.origin;
  const found = new Set();
  found.add(stripHash(startUrl));

  // 1) пробуем sitemap.xml (включая sitemap index с детьми)
  const sitemapCandidates = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap-index.xml`,
  ];
  for (const sm of sitemapCandidates) {
    if (found.size >= maxPages) break;
    try {
      const urls = await fetchSitemapUrls(sm, maxPages - found.size + 5);
      for (const u of urls) {
        if (!sameOriginOnly || new URL(u).origin === origin) {
          found.add(stripHash(u));
          if (found.size >= maxPages) break;
        }
      }
    } catch { /* sitemap может отсутствовать или быть битым */ }
  }

  // 2) если sitemap не дал результатов — парсим HTML главной и собираем <a href>
  if (found.size < 2) {
    try {
      const html = await downloadHtml(startUrl);
      const $ = cheerio.load(html);
      $('a[href]').each((_, el) => {
        if (found.size >= maxPages) return false;
        const href = $(el).attr('href');
        if (!href) return;
        try {
          const u = new URL(href, startUrl);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
          if (sameOriginOnly && u.origin !== origin) return;
          found.add(stripHash(u.toString()));
        } catch { /* invalid href */ }
      });
    } catch { /* ignore */ }
  }

  // 3) если всё ещё мало (SPA с пустым HTML) — рендерим главную через Jina
  // и вытаскиваем ссылки из markdown.
  if (found.size < 2) {
    try {
      const md = await fetchViaJinaReader(startUrl);
      const linkRe = /\((https?:\/\/[^\s)]+)\)/g;
      let m;
      while ((m = linkRe.exec(md)) !== null) {
        if (found.size >= maxPages) break;
        try {
          const u = new URL(m[1]);
          if (sameOriginOnly && u.origin !== origin) continue;
          // отсеять картинки
          if (/\.(png|jpe?g|gif|webp|svg|ico|css|js|woff2?|ttf)(\?|$)/i.test(u.pathname)) continue;
          found.add(stripHash(u.toString()));
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return Array.from(found).slice(0, maxPages);
}

async function fetchSitemapUrls(sitemapUrl, limit) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const resp = await fetch(sitemapUrl, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BotmeBot/1.0)' },
    });
    if (!resp.ok) return [];
    const xml = await resp.text();
    const $ = cheerio.load(xml, { xmlMode: true });

    // Sitemap-index: <sitemapindex><sitemap><loc>...</loc></sitemap></sitemapindex>
    const childSitemaps = [];
    $('sitemapindex sitemap > loc').each((_, el) => {
      childSitemaps.push($(el).text().trim());
    });
    if (childSitemaps.length) {
      const all = [];
      for (const child of childSitemaps.slice(0, 5)) {
        if (all.length >= limit) break;
        try {
          const sub = await fetchSitemapUrls(child, limit - all.length);
          all.push(...sub);
        } catch { /* skip */ }
      }
      return all;
    }

    // Обычный urlset: <urlset><url><loc>...</loc></url></urlset>
    const urls = [];
    $('urlset url > loc').each((_, el) => {
      if (urls.length >= limit) return false;
      const u = $(el).text().trim();
      if (u) urls.push(u);
    });
    return urls;
  } finally {
    clearTimeout(t);
  }
}

function stripHash(u) { return u.replace(/#.*$/, ''); }

async function downloadHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BotmeBot/1.0; +https://botme.neeklo.ru)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru,en;q=0.9',
      },
      redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(t);
  }
}

// Сначала пытаемся через Readability (Mozilla), если не вышло — через cheerio.
function extractMainContent(html, baseUrl) {
  let title = '';
  let text  = '';
  try {
    const dom = new JSDOM(html, { url: baseUrl });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (article && article.textContent && article.textContent.trim().length > 200) {
      title = (article.title || '').trim();
      text  = cleanWhitespace(article.textContent);
    }
  } catch { /* fall through */ }

  if (!text) {
    const $ = cheerio.load(html);
    $('script, style, noscript, nav, header, footer, aside, iframe, .nav, .header, .footer').remove();
    title = ($('title').first().text() || '').trim();
    text  = cleanWhitespace($('body').text() || '');
  }

  return { title, content: text };
}

// Извлекаем то, что доступно даже на SPA: title, description, keywords,
// open graph, twitter, JSON-LD (schema.org), все h1-h3 из исходного HTML.
function extractMetaAndJsonLd(html) {
  const $ = cheerio.load(html);
  const lines = [];
  const title = ($('title').first().text() || '').trim();

  const desc = ($('meta[name="description"]').attr('content') || '').trim();
  const keywords = ($('meta[name="keywords"]').attr('content') || '').trim();
  const ogTitle = ($('meta[property="og:title"]').attr('content') || '').trim();
  const ogDesc  = ($('meta[property="og:description"]').attr('content') || '').trim();
  const ogSite  = ($('meta[property="og:site_name"]').attr('content') || '').trim();
  const twTitle = ($('meta[name="twitter:title"]').attr('content') || '').trim();
  const twDesc  = ($('meta[name="twitter:description"]').attr('content') || '').trim();

  if (title) lines.push(`Заголовок: ${title}`);
  if (ogTitle && ogTitle !== title) lines.push(`OG Title: ${ogTitle}`);
  if (ogSite) lines.push(`Сайт: ${ogSite}`);
  if (desc) lines.push(`Описание: ${desc}`);
  if (ogDesc && ogDesc !== desc) lines.push(`OG Описание: ${ogDesc}`);
  if (twDesc && twDesc !== desc && twDesc !== ogDesc) lines.push(`Twitter: ${twDesc}`);
  if (keywords) lines.push(`Ключевые слова: ${keywords}`);

  // h1..h3 (на SPA редко есть, но если в SSR-prerender — будут)
  const heads = [];
  $('h1, h2, h3').each((_, el) => {
    const t = $(el).text().trim();
    if (t && t.length < 200) heads.push(t);
  });
  if (heads.length) lines.push('Заголовки страницы: ' + heads.slice(0, 20).join(' • '));

  // JSON-LD schema.org
  const jsonLdBlocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).contents().text();
      const data = JSON.parse(raw);
      jsonLdBlocks.push(...flattenJsonLd(data));
    } catch { /* пропускаем битый JSON */ }
  });
  for (const ld of jsonLdBlocks) {
    const block = jsonLdToText(ld);
    if (block) lines.push(block);
  }

  return { title, text: lines.join('\n\n').trim() };
}

function flattenJsonLd(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data.flatMap(flattenJsonLd);
  if (data['@graph'] && Array.isArray(data['@graph'])) return data['@graph'].flatMap(flattenJsonLd);
  return [data];
}

function jsonLdToText(o) {
  if (!o || typeof o !== 'object') return '';
  const lines = [];
  const t = o['@type'] || 'Item';
  lines.push(`[${Array.isArray(t) ? t.join('/') : t}]`);
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith('@')) continue;
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number') {
      lines.push(`${humanKey(k)}: ${v}`);
    } else if (Array.isArray(v)) {
      const flat = v.filter((x) => typeof x === 'string' || typeof x === 'number');
      if (flat.length) lines.push(`${humanKey(k)}: ${flat.join(', ')}`);
    } else if (typeof v === 'object' && (v.name || v['@id'])) {
      lines.push(`${humanKey(k)}: ${v.name || v['@id']}`);
    }
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

function humanKey(k) {
  return k
    .replace(/^@/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

// Публичный read-mode прокси с JS-рендерингом. Бесплатно, без ключа.
// Возвращает чистый markdown отрендеренной страницы. Опционально
// можно задать JINA_API_KEY в .env для увеличенных лимитов.
async function fetchViaJinaReader(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 35_000);
  try {
    const proxied = `https://r.jina.ai/${url}`;
    const headers = {
      'Accept': 'text/plain',
      'User-Agent': 'Mozilla/5.0 (compatible; BotmeBot/1.0)',
      // Просим Jina вернуть ссылки и изображения как элементы,
      // чтобы потом RAG мог их использовать
      'X-Return-Format': 'markdown',
    };
    if (process.env.JINA_API_KEY) {
      headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
    }
    const resp = await fetch(proxied, {
      signal: ctrl.signal,
      headers,
      redirect: 'follow',
    });
    if (!resp.ok) return '';
    const txt = await resp.text();
    return cleanWhitespace(txt);
  } catch {
    return '';
  } finally {
    clearTimeout(t);
  }
}

function cleanWhitespace(s) {
  return String(s)
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// =============================================================
// Чанкинг
// =============================================================

const TARGET_TOKENS = 600;
const OVERLAP_TOKENS = 80;
const MAX_CHUNK_TOKENS = 900;     // если параграф больше — режем по предложениям

function tokenLen(s) {
  try { return encode(String(s || '')).length; } catch { return Math.ceil((s || '').length / 4); }
}

// Разбиваем текст на чанки по target/overlap. Подход:
//  1) split на параграфы (\n\n)
//  2) очень длинные параграфы режем по предложениям
//  3) merge подряд идущих кусков пока не накопим target токенов
//  4) затем добавляем overlap из конца предыдущего чанка
export function chunkText(text, { target = TARGET_TOKENS, overlap = OVERLAP_TOKENS } = {}) {
  if (!text || !text.trim()) return [];
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  // Шаг 1: режем длинные параграфы по предложениям, чтобы каждый кусок был <= MAX_CHUNK_TOKENS
  const pieces = [];
  for (const p of paragraphs) {
    if (tokenLen(p) <= MAX_CHUNK_TOKENS) {
      pieces.push(p);
    } else {
      const sentences = p.split(/(?<=[.!?…])\s+(?=[A-ZА-ЯЁ"«])/);
      let buf = '';
      for (const s of sentences) {
        const next = buf ? buf + ' ' + s : s;
        if (tokenLen(next) > MAX_CHUNK_TOKENS && buf) {
          pieces.push(buf);
          buf = s;
        } else {
          buf = next;
        }
      }
      if (buf) pieces.push(buf);
    }
  }

  // Шаг 2: merge до target токенов
  const chunks = [];
  let cur = '';
  let curT = 0;
  for (const p of pieces) {
    const pt = tokenLen(p);
    if (cur && curT + pt > target) {
      chunks.push({ text: cur, tokens: curT });
      cur = p; curT = pt;
    } else {
      cur = cur ? cur + '\n\n' + p : p;
      curT = curT + (cur === p ? 0 : pt);
      if (cur === p) curT = pt;
    }
  }
  if (cur) chunks.push({ text: cur, tokens: curT });

  // Шаг 3: overlap (берём последние overlap токенов предыдущего чанка как префикс)
  if (overlap > 0 && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1].text;
      const tail = takeTailByTokens(prev, overlap);
      if (tail) {
        chunks[i].text = tail + '\n\n' + chunks[i].text;
        chunks[i].tokens = tokenLen(chunks[i].text);
      }
    }
  }

  return chunks.map((c, idx) => ({ idx, text: c.text, tokens: c.tokens }));
}

function takeTailByTokens(text, n) {
  // быстрая аппроксимация: берём последние ~ n*4 символов и обрезаем по слову
  const approx = Math.min(text.length, n * 5);
  let tail = text.slice(-approx);
  const sp = tail.indexOf(' ');
  if (sp > 0) tail = tail.slice(sp + 1);
  return tail.trim();
}
