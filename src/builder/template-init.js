// Развернуть базовый шаблон react-bundle в новый projectDir.
// Копируем все файлы из src/builder/template/, не перезаписывая существующие.

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const TEMPLATE_DIR = path.join(__dirname, 'template');

export async function initReactBundleTemplate(projectDir, { override = false } = {}) {
  await copyDir(TEMPLATE_DIR, projectDir, override);
}

async function copyDir(src, dst, override) {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      await copyDir(s, d, override);
    } else {
      let exists = false;
      try { await fs.access(d); exists = true; } catch {}
      if (exists && !override) continue;
      await fs.copyFile(s, d);
    }
  }
}
