/**
 * Точка входа для PM2 / npm start.
 * Загружает .env из каталога проекта ДО импорта server.js, чтобы src/llm.js
 * увидел OPENROUTER_API_KEY и др. (import dotenv/config берёт cwd — на VPS он может быть неверным).
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
loadEnv({
  path: path.join(rootDir, '.env'),
  override: true, // PM2/dump может пробросить пустые ключи — перезаписываем из файла
});

await import('./server.js');
