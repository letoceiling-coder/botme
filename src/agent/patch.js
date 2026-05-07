// Простой патч-протокол: точечная замена уникального вхождения oldStr на newStr
// в конкретном файле проекта. Используется и Coder-стадией (для самопочинки),
// и Autofix-стадией.
//
// Контракт совпадает с подходом OpenAI «edit by find-replace»:
//   - oldStr должен встречаться РОВНО ОДИН РАЗ в файле (иначе ошибка с подсказкой).
//   - oldStr должен совпадать ПОЛНОСТЬЮ, включая отступы и переносы строк.
//   - newStr может быть пустой строкой (= удаление).
//
// Поддерживается batched-режим: applyMultiplePatches([{path, oldStr, newStr}]).

import path from 'node:path';
import fs from 'node:fs/promises';

/** Безопасный относительный путь внутри проекта (без .. , без абсолютных). */
function isSafeRel(p) {
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

/** Превратить относительный путь в абсолютный, проверив принадлежность projectDir. */
function resolveSafe(projectDir, rel) {
  if (!isSafeRel(rel)) {
    const err = new Error(`Небезопасный путь: ${rel}`);
    err.code = 'unsafe_path';
    throw err;
  }
  const abs = path.resolve(projectDir, rel);
  const root = path.resolve(projectDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    const err = new Error(`Путь выходит за пределы проекта: ${rel}`);
    err.code = 'path_escape';
    throw err;
  }
  return abs;
}

/** Применить ОДИН патч. Возвращает { ok, beforeLines, afterLines, before, after }. */
export async function applyPatch(projectDir, relPath, oldStr, newStr) {
  if (typeof oldStr !== 'string') throw new Error('apply_patch: oldStr должен быть строкой');
  if (typeof newStr !== 'string') throw new Error('apply_patch: newStr должен быть строкой');

  const abs = resolveSafe(projectDir, relPath);
  let content;
  try {
    content = await fs.readFile(abs, 'utf8');
  } catch (e) {
    const err = new Error(`Не удалось прочитать ${relPath}: ${e?.message || e}`);
    err.code = 'read_failed';
    throw err;
  }

  const occurrences = countOccurrences(content, oldStr);
  if (occurrences === 0) {
    const err = new Error(
      `apply_patch: oldStr не найден в ${relPath}. ` +
      `Проверь точный отступ и переносы строк, либо расширь контекст до уникального фрагмента.`,
    );
    err.code = 'no_match';
    throw err;
  }
  if (occurrences > 1) {
    const err = new Error(
      `apply_patch: oldStr встречается в ${relPath} ${occurrences} раз. ` +
      `Расширь контекст (добавь окружающие строки) — нужен ровно один уникальный фрагмент.`,
    );
    err.code = 'ambiguous_match';
    err.occurrences = occurrences;
    throw err;
  }

  const before = content;
  const after = before.replace(oldStr, () => newStr); // function-replacer защищает от $1/$&
  await fs.writeFile(abs, after, 'utf8');

  return {
    ok: true,
    path: relPath,
    beforeLines: before.split('\n').length,
    afterLines: after.split('\n').length,
    deltaLines: after.split('\n').length - before.split('\n').length,
  };
}

/** Применить НЕСКОЛЬКО патчей (последовательно). При ошибке любого — кидаем. */
export async function applyMultiplePatches(projectDir, chunks) {
  if (!Array.isArray(chunks) || !chunks.length) {
    throw new Error('apply_patch: ожидается массив правок');
  }
  const results = [];
  for (const c of chunks) {
    const r = await applyPatch(projectDir, c.path, c.oldStr, c.newStr);
    results.push(r);
  }
  return results;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const i = haystack.indexOf(needle, idx);
    if (i === -1) break;
    count += 1;
    idx = i + needle.length;
  }
  return count;
}

export { isSafeRel, resolveSafe };
