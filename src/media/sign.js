/**
 * Подписанные временные URL для медиа-файлов.
 *
 * Зачем: внешние сервисы (Replicate, и в будущем — другие провайдеры) не имеют
 * cookie-сессии и не могут скачать /media-files/... через обычный gate. Чтобы
 * не открывать приватные файлы публично, мы выдаём ссылку с
 *
 *     /media-files/<proj>/<file>?exp=<unix-ts>&sig=<hmac-sha256>
 *
 * sig = HMAC-SHA256(SESSION_SECRET, "<path>|<exp>") — первые 32 hex-символа
 * (128 бит, более чем достаточно). Ссылка валидна до момента exp; после —
 * 403 без вариантов даже если кто-то её украл.
 *
 * Обычный пользовательский браузер ходит по тем же путям, но БЕЗ
 * подписи — там работает session-check. То есть signed-URL это лишь
 * вспомогательный шлюз для машинных клиентов.
 */

import crypto from 'node:crypto';

const HMAC_LEN_HEX = 32;

function secret() {
  return process.env.SESSION_SECRET || 'botme-dev-insecure-change-me';
}

function compute(pathPart, exp) {
  const h = crypto.createHmac('sha256', secret());
  h.update(`${pathPart}|${exp}`);
  return h.digest('hex').slice(0, HMAC_LEN_HEX);
}

/**
 * Подписать локальный путь вида "/media-files/<proj>/<file>".
 * Возвращает строку с уже подклеенными ?exp=…&sig=… (или &exp=…&sig=…
 * если в исходном пути уже есть query).
 */
export function signMediaUrl(localPath, ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, Math.min(86400, ttlSec));
  const sig = compute(localPath, exp);
  const sep = localPath.includes('?') ? '&' : '?';
  return `${localPath}${sep}exp=${exp}&sig=${sig}`;
}

/**
 * Проверить, что переданные exp/sig валидны для данного пути и срок не истёк.
 */
export function verifyMediaSig(localPath, expRaw, sigRaw) {
  if (!expRaw || !sigRaw) return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return false;
  const expected = compute(localPath, exp);
  if (typeof sigRaw !== 'string' || sigRaw.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sigRaw), Buffer.from(expected));
  } catch {
    return false;
  }
}
