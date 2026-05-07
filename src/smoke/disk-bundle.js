/**
 * Загрузчик превью смотрит bundle.* в нескольких местах; jsdom/playwright может
 * «пропустить» отсутствие файлов. Проверяем наличие на диске для локальных путей.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export async function smokeDiskBundles(projectDir, indexAbs, indexHtml) {
  const refs = [];
  const reQuoted = /\b(?:href|src)\s*=\s*(["'])([^"']+)\1/gi;
  let m;
  while ((m = reQuoted.exec(indexHtml || ''))) {
    refs.push(m[2].trim());
  }
  const reBare = /\b(?:href|src)\s*=\s*([^\s"'=<>`]+)/gi;
  while ((m = reBare.exec(indexHtml || ''))) {
    refs.push(m[1].trim());
  }
  const local = [...new Set(refs)].filter(
    (raw) =>
      /bundle\.(?:js|css)(\?|#|$)/i.test(raw)
      && !/^(https?:|\/\/|data:)/i.test(raw),
  );
  if (!local.length) return { ok: true, errors: [] };

  const errors = [];
  const idxDir = path.dirname(path.resolve(indexAbs));

  for (const raw of local) {
    const clean = raw.split('?')[0].split('#')[0];
    const fname = path.basename(clean);
    if (fname !== 'bundle.js' && fname !== 'bundle.css') continue;

    const relNoDot = clean.replace(/^\.\//, '');
    const candidates = [
      path.resolve(idxDir, relNoDot),
      path.join(projectDir, 'dist', fname),
      path.join(projectDir, fname),
    ];
    const uniq = [...new Set(candidates.map((p) => path.resolve(p)))];
    let hit = false;
    for (const p of uniq) {
      try {
        await fs.access(p);
        hit = true;
        break;
      } catch { /* next */ }
    }
    if (!hit) {
      errors.push(
        `${fname}: нет на диске (ожидались: рядом с index, в dist/ или в корне проекта)`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}
