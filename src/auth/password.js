import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Хеш пароля для хранения в БД: salt:hash (hex). */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const i = stored.indexOf(':');
  if (i <= 0) return false;
  try {
    const salt = Buffer.from(stored.slice(0, i), 'hex');
    const hashOld = Buffer.from(stored.slice(i + 1), 'hex');
    const hashNew = scryptSync(String(password), salt, 64);
    if (hashOld.length !== hashNew.length) return false;
    return timingSafeEqual(hashOld, hashNew);
  } catch {
    return false;
  }
}
