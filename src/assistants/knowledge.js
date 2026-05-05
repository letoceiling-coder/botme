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

export async function fetchAndParseUrl(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BotmeBot/1.0; +https://botme.neeklo.ru)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    return extractMainContent(html, url);
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

  if (!title) title = baseUrl;
  return { title, content: text };
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
