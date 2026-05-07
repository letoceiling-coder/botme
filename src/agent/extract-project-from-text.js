// Извлечение файлов проекта из «классического» ответа модели (без tool-calling).
// Дублирует контракт server.js: ```file:path``` и одиночный HTML / ```html```.

import fs from 'node:fs/promises';
import path from 'node:path';

/** Безопасный относительный путь: только латиница/цифры/-_/. , без .. и абсолютных путей */
export function isSafeRelPath(p) {
  if (!p || typeof p !== 'string') return false;
  if (p.length > 200) return false;
  if (/^[\\/]/.test(p)) return false;
  if (/^[a-zA-Z]:/.test(p)) return false;
  if (/\\/.test(p)) return false;
  if (/(^|\/)\.\.(\/|$)/.test(p)) return false;
  if (/[<>:"|?*\x00-\x1f]/.test(p)) return false;
  if (!/^[\w./\-]+$/i.test(p)) return false;
  return true;
}

function extractSingleHtml(s) {
  const docStart = s.search(/<!doctype\s+html/i);
  if (docStart !== -1) {
    const tail = s.slice(docStart);
    const endMatch = tail.match(/<\/html\s*>/i);
    if (endMatch) return tail.slice(0, endMatch.index + endMatch[0].length).trim();
    return tail.trim();
  }
  const htmlStart = s.search(/<html[\s>]/i);
  if (htmlStart !== -1) {
    const tail = s.slice(htmlStart);
    const endMatch = tail.match(/<\/html\s*>/i);
    if (endMatch) {
      return (`<!DOCTYPE html>\n${tail.slice(0, endMatch.index + endMatch[0].length)}`).trim();
    }
  }
  const fence = s.match(/```html\s*([\s\S]*?)```/i);
  if (fence) {
    const inner = fence[1].trim();
    if (/<!doctype|<html|<body|<div/i.test(inner)) return inner;
  }
  return null;
}

/** @returns {Map<string, string>|null} */
export function extractFilesFromAssistantText(text) {
  if (!text) return null;
  const s = String(text);
  const files = new Map();

  const fileFenceRe = /```file:([^\n`]+)\n([\s\S]*?)```/g;
  let m;
  while ((m = fileFenceRe.exec(s)) !== null) {
    const rawPath = m[1].trim();
    let content = m[2];
    content = content.replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (!isSafeRelPath(rawPath)) continue;
    files.set(rawPath.replace(/\\/g, '/'), content);
  }

  if (files.size > 0) {
    if (!files.has('index.html')) {
      const firstHtml = [...files.keys()].find((k) => k.endsWith('.html'));
      if (firstHtml) {
        files.set('index.html', files.get(firstHtml));
      } else {
        return null;
      }
    }
    return files;
  }

  const html = extractSingleHtml(s);
  if (html) {
    files.set('index.html', html);
    return files;
  }
  return null;
}

/** Запись Map на диск внутри projectDir (защита от выхода за корень). */
export async function writeExtractedMapToProject(projectDir, filesMap) {
  if (!filesMap || filesMap.size === 0) return 0;
  const root = path.resolve(projectDir);
  let n = 0;
  for (const [rel, content] of filesMap) {
    if (!isSafeRelPath(rel)) continue;
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep) && abs !== root) continue;
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, String(content ?? ''), 'utf8');
    n += 1;
  }
  return n;
}
