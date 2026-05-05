// Bearer-токены для публичного API.
// Формат токена: ast_<32 hex>. Plain показываем 1 раз, в БД — SHA-256.
import crypto from 'node:crypto';
import { db, now } from '../db.js';

// =============================================================
// Подготовленные SQL
// =============================================================
const sql = {
  insert: db.prepare(`
    INSERT INTO api_tokens (id, assistant_id, name, token_hash, token_prefix, rate_limit_rpm, allowed_origins, created_at, last_used_at, revoked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
  `),
  list:   db.prepare(`SELECT id, assistant_id, name, token_prefix, rate_limit_rpm, allowed_origins, created_at, last_used_at, revoked FROM api_tokens WHERE assistant_id = ? ORDER BY created_at DESC`),
  byHash: db.prepare(`SELECT * FROM api_tokens WHERE token_hash = ? AND revoked = 0`),
  byId:   db.prepare(`SELECT * FROM api_tokens WHERE id = ?`),
  revoke: db.prepare(`UPDATE api_tokens SET revoked = 1 WHERE id = ? AND assistant_id = ?`),
  remove: db.prepare(`DELETE FROM api_tokens WHERE id = ? AND assistant_id = ?`),
  touchUsed: db.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`),
};

// =============================================================
// Создание токена
// =============================================================
export function generateApiToken(assistantId, { name, rateLimitRpm = 60, allowedOrigins = ['*'] } = {}) {
  const id     = crypto.randomUUID();
  const random = crypto.randomBytes(16).toString('hex');     // 32 hex
  const plain  = `ast_${random}`;
  const hash   = sha256(plain);
  const prefix = plain.slice(0, 12);                          // ast_xxxxxxxx — для UI

  sql.insert.run(
    id, assistantId,
    (name || 'API token').slice(0, 80),
    hash, prefix,
    Number.isFinite(rateLimitRpm) ? rateLimitRpm : 60,
    JSON.stringify(Array.isArray(allowedOrigins) && allowedOrigins.length ? allowedOrigins : ['*']),
    now(),
  );

  return {
    id,
    plainToken: plain,                                        // ПОКАЗЫВАЕТСЯ ОДИН РАЗ
    prefix,
    name,
    rateLimitRpm,
    allowedOrigins,
  };
}

// =============================================================
// Список и операции
// =============================================================
export function listAssistantTokens(assistantId) {
  return sql.list.all(assistantId).map((r) => ({
    id: r.id,
    assistant_id: r.assistant_id,
    name: r.name,
    prefix: r.token_prefix,
    rate_limit_rpm: r.rate_limit_rpm,
    allowed_origins: safeJson(r.allowed_origins, ['*']),
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    revoked: !!r.revoked,
  }));
}

export function revokeToken(tokenId, assistantId) {
  return sql.revoke.run(tokenId, assistantId).changes > 0;
}

export function deleteToken(tokenId, assistantId) {
  return sql.remove.run(tokenId, assistantId).changes > 0;
}

// =============================================================
// Проверка Bearer-токена + origin
// =============================================================
export function findTokenByPlain(plain) {
  if (!plain || typeof plain !== 'string') return null;
  const hash = sha256(plain);
  const row = sql.byHash.get(hash);
  if (!row) return null;
  return {
    id: row.id,
    assistantId: row.assistant_id,
    name: row.name,
    rateLimitRpm: row.rate_limit_rpm,
    allowedOrigins: safeJson(row.allowed_origins, ['*']),
    revoked: !!row.revoked,
  };
}

export function isOriginAllowed(allowedOrigins, originHeader) {
  if (!allowedOrigins || !allowedOrigins.length || allowedOrigins.includes('*')) return true;
  if (!originHeader) return false; // requirement: если ограничено — origin обязателен
  let host;
  try { host = new URL(originHeader).origin; } catch { return false; }
  return allowedOrigins.some((o) => {
    if (o === '*') return true;
    try {
      // Сравниваем по хосту/origin'у независимо от хвостового слэша
      const want = new URL(o).origin;
      return want === host;
    } catch {
      // Если origin указан как 'example.com' — попробуем сматчить как hostname
      return host.endsWith(o);
    }
  });
}

// =============================================================
// Rate-limit (in-memory, скользящее окно 60 сек)
// =============================================================
const rateBuckets = new Map(); // tokenId -> { windowStart: ts, count: number }

export function checkRateLimit(tokenId, rpm) {
  const limit = Math.max(1, rpm || 60);
  const nowTs = Date.now();
  const bucket = rateBuckets.get(tokenId);
  if (!bucket || nowTs - bucket.windowStart >= 60_000) {
    rateBuckets.set(tokenId, { windowStart: nowTs, count: 1 });
    return { ok: true, remaining: limit - 1, resetIn: 60 };
  }
  if (bucket.count >= limit) {
    const resetIn = Math.ceil((60_000 - (nowTs - bucket.windowStart)) / 1000);
    return { ok: false, remaining: 0, resetIn };
  }
  bucket.count += 1;
  return { ok: true, remaining: limit - bucket.count, resetIn: Math.ceil((60_000 - (nowTs - bucket.windowStart)) / 1000) };
}

export function touchTokenUsage(tokenId) {
  try { sql.touchUsed.run(now(), tokenId); } catch {}
}

// =============================================================
// Express middleware: проверка Bearer + rate-limit + origin
// =============================================================
export function requireApiToken() {
  return (req, res, next) => {
    const auth = req.headers.authorization || '';
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (!m) return res.status(401).json({ error: 'unauthorized', message: 'Authorization: Bearer ast_… header required' });

    const token = findTokenByPlain(m[1]);
    if (!token) return res.status(401).json({ error: 'invalid_token', message: 'Token не найден или отозван' });
    if (token.revoked) return res.status(401).json({ error: 'token_revoked' });

    // Проверка origin (если ограничен)
    const origin = req.headers.origin || req.headers.referer || '';
    if (!isOriginAllowed(token.allowedOrigins, origin)) {
      return res.status(403).json({ error: 'origin_not_allowed', allowed: token.allowedOrigins });
    }

    // Rate-limit
    const rl = checkRateLimit(token.id, token.rateLimitRpm);
    res.setHeader('X-RateLimit-Limit', String(token.rateLimitRpm));
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
    res.setHeader('X-RateLimit-Reset', String(rl.resetIn));
    if (!rl.ok) {
      return res.status(429).json({ error: 'rate_limited', retry_after_seconds: rl.resetIn });
    }

    touchTokenUsage(token.id);
    req.apiToken = token;
    next();
  };
}

// =============================================================
// Утилиты
// =============================================================
function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function safeJson(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }
