/**
 * Хранилище для AI Media Studio (раздел /media).
 *
 * Сущности:
 *   media_projects — холст пользователя (graph хранится JSON-ом, чтобы фронт
 *     полностью владел структурой и мог свободно эволюционировать).
 *   media_runs     — задачи на генерацию (image/video/upscale/audio/llm) на
 *     внешних провайдерах с асинхронным polling. Файл результата лежит на
 *     диске, в БД — только метаданные и относительный путь.
 *
 * Хранилище общее (botme.db). Доступ ко всему gated через appAuthGate, поэтому
 * на текущем этапе ownerId = email авторизованного пользователя.
 */

import { db, DATA_DIR } from '../db.js';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS media_uploads (
    id          TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    filename    TEXT NOT NULL,
    orig_name   TEXT,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    folder      TEXT DEFAULT '',
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_media_uploads_owner ON media_uploads(owner, created_at DESC);

  CREATE TABLE IF NOT EXISTS media_projects (
    id          TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    title       TEXT NOT NULL,
    graph_json  TEXT NOT NULL DEFAULT '{}',
    thumb       TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_media_projects_owner ON media_projects(owner, updated_at DESC);

  CREATE TABLE IF NOT EXISTS media_runs (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL,
    node_id       TEXT NOT NULL,
    kind          TEXT NOT NULL,            -- image | video | upscale | audio | llm
    provider      TEXT NOT NULL,
    model         TEXT,
    status        TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | error
    external_id   TEXT,                     -- ID на стороне провайдера (replicate prediction id и т.п.)
    input_json    TEXT,
    result_url    TEXT,                     -- относительный путь к файлу или внешний URL
    result_meta   TEXT,                     -- JSON с дополнительными полями (size, duration, mime)
    error         TEXT,
    cost_cents    INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES media_projects(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_media_runs_project ON media_runs(project_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_media_runs_status  ON media_runs(status, updated_at DESC);
`);

const now = () => Date.now();

/* =================== projects =================== */

export function listProjects(owner, limit = 50) {
  const rows = db.prepare(`
    SELECT id, title, thumb, created_at AS createdAt, updated_at AS updatedAt
    FROM media_projects WHERE owner = ? ORDER BY updated_at DESC LIMIT ?
  `).all(owner, limit);
  return rows;
}

export function getProject(owner, id) {
  const row = db.prepare(`
    SELECT id, owner, title, graph_json AS graphJson, thumb,
           created_at AS createdAt, updated_at AS updatedAt
    FROM media_projects WHERE id = ? AND owner = ?
  `).get(id, owner);
  if (!row) return null;
  let graph = {};
  try { graph = JSON.parse(row.graphJson || '{}'); } catch {}
  delete row.graphJson;
  row.graph = graph;
  return row;
}

export function createProject(owner, title = 'Untitled space') {
  const id = randomUUID();
  const t = now();
  db.prepare(`
    INSERT INTO media_projects (id, owner, title, graph_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, owner, title.slice(0, 200), '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}', t, t);
  return getProject(owner, id);
}

export function saveProjectGraph(owner, id, graph, title) {
  const exists = db.prepare(`SELECT 1 FROM media_projects WHERE id = ? AND owner = ?`).get(id, owner);
  if (!exists) return null;
  const json = JSON.stringify(graph || {});
  if (typeof title === 'string' && title.trim()) {
    db.prepare(`
      UPDATE media_projects SET graph_json = ?, title = ?, updated_at = ?
      WHERE id = ? AND owner = ?
    `).run(json, title.slice(0, 200), now(), id, owner);
  } else {
    db.prepare(`
      UPDATE media_projects SET graph_json = ?, updated_at = ?
      WHERE id = ? AND owner = ?
    `).run(json, now(), id, owner);
  }
  return getProject(owner, id);
}

export function renameProject(owner, id, title) {
  db.prepare(`UPDATE media_projects SET title = ?, updated_at = ? WHERE id = ? AND owner = ?`)
    .run(String(title || '').slice(0, 200), now(), id, owner);
  return getProject(owner, id);
}

export function deleteProject(owner, id) {
  const r = db.prepare(`DELETE FROM media_projects WHERE id = ? AND owner = ?`).run(id, owner);
  // Удалим папку проекта, если есть.
  const dir = path.join(MEDIA_DIR, id);
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  return r.changes > 0;
}

/* =================== runs =================== */

export function createRun({ projectId, nodeId, kind, provider, model, input }) {
  const id = randomUUID();
  const t = now();
  db.prepare(`
    INSERT INTO media_runs (id, project_id, node_id, kind, provider, model, status, input_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
  `).run(id, projectId, nodeId, kind, provider, model || null, JSON.stringify(input || {}), t, t);
  return getRun(id);
}

export function updateRun(id, patch) {
  const fields = [];
  const values = [];
  for (const [k, v] of Object.entries(patch || {})) {
    const col = ({
      status: 'status',
      externalId: 'external_id',
      resultUrl: 'result_url',
      resultMeta: 'result_meta',
      error: 'error',
      costCents: 'cost_cents',
    })[k];
    if (!col) continue;
    fields.push(`${col} = ?`);
    values.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
  }
  if (!fields.length) return getRun(id);
  fields.push(`updated_at = ?`);
  values.push(now());
  values.push(id);
  db.prepare(`UPDATE media_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getRun(id);
}

export function getRun(id) {
  const row = db.prepare(`
    SELECT id, project_id AS projectId, node_id AS nodeId, kind, provider, model,
           status, external_id AS externalId, input_json AS inputJson,
           result_url AS resultUrl, result_meta AS resultMeta, error,
           cost_cents AS costCents, created_at AS createdAt, updated_at AS updatedAt
    FROM media_runs WHERE id = ?
  `).get(id);
  if (!row) return null;
  try { row.input = JSON.parse(row.inputJson || '{}'); } catch { row.input = {}; }
  delete row.inputJson;
  if (row.resultMeta) {
    try { row.resultMeta = JSON.parse(row.resultMeta); } catch {}
  }
  return row;
}

export function listRunsForProject(projectId, limit = 100) {
  const rows = db.prepare(`
    SELECT id, node_id AS nodeId, kind, provider, model, status,
           result_url AS resultUrl, error,
           created_at AS createdAt, updated_at AS updatedAt
    FROM media_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(projectId, limit);
  return rows;
}

/**
 * Сводная usage-статистика по владельцу.
 * Возвращает агрегаты:
 *   - totals: { calls, costCents, tokensIn, tokensOut, durationMs }
 *   - byKind: { image: {...}, video: {...}, ... }
 *   - byModel: { 'flux-1.1-pro': {...}, 'gpt-4o': {...}, ... }
 *   - recent: последние 30 runs с краткой инфой.
 *
 * Все суммы считаются в SQL прямо по полям result_meta (JSON1 функция
 * json_extract); если поле отсутствует — учитывается как 0.
 */
export function getUsageStats(owner, { fromTs = null, limit = 30 } = {}) {
  const params = [owner];
  let where = `p.owner = ?`;
  if (fromTs) { where += ` AND r.created_at >= ?`; params.push(fromTs); }

  const aggSql = (groupCol) => `
    SELECT ${groupCol ? groupCol + ' AS k,' : ''}
           COUNT(*) AS calls,
           COALESCE(SUM(r.cost_cents), 0) AS costCents,
           COALESCE(SUM(CAST(json_extract(r.result_meta, '$.tokensIn')   AS INTEGER)), 0) AS tokensIn,
           COALESCE(SUM(CAST(json_extract(r.result_meta, '$.tokensOut')  AS INTEGER)), 0) AS tokensOut,
           COALESCE(SUM(CAST(json_extract(r.result_meta, '$.durationMs') AS INTEGER)), 0) AS durationMs,
           SUM(CASE WHEN r.status = 'error' THEN 1 ELSE 0 END) AS failed
    FROM media_runs r
    INNER JOIN media_projects p ON p.id = r.project_id
    WHERE ${where}
    ${groupCol ? 'GROUP BY ' + groupCol + ' ORDER BY costCents DESC' : ''}
  `;

  const totalsRow = db.prepare(aggSql(null)).get(...params) || {};
  const byKindRows  = db.prepare(aggSql('r.kind')).all(...params);
  const byModelRows = db.prepare(aggSql('r.model')).all(...params);

  const recent = db.prepare(`
    SELECT r.id, r.kind, r.provider, r.model, r.status, r.cost_cents AS costCents,
           r.created_at AS createdAt, r.updated_at AS updatedAt,
           json_extract(r.result_meta, '$.tokensIn')   AS tokensIn,
           json_extract(r.result_meta, '$.tokensOut')  AS tokensOut,
           json_extract(r.result_meta, '$.durationMs') AS durationMs,
           p.id AS projectId, p.title AS projectTitle
    FROM media_runs r
    INNER JOIN media_projects p ON p.id = r.project_id
    WHERE ${where}
    ORDER BY r.created_at DESC
    LIMIT ?
  `).all(...params, Math.min(Math.max(Number(limit) || 30, 1), 200));

  const cleanRow = (r) => ({
    calls: Number(r.calls) || 0,
    costCents: Number(r.costCents) || 0,
    tokensIn: Number(r.tokensIn) || 0,
    tokensOut: Number(r.tokensOut) || 0,
    durationMs: Number(r.durationMs) || 0,
    failed: Number(r.failed) || 0,
  });
  const mapByKey = (rows) => rows.reduce((acc, r) => {
    if (!r.k) return acc;
    acc[r.k] = cleanRow(r);
    return acc;
  }, {});

  return {
    owner,
    fromTs,
    totals:  cleanRow(totalsRow),
    byKind:  mapByKey(byKindRows),
    byModel: mapByKey(byModelRows),
    recent,
  };
}

/**
 * Все успешно завершённые runs владельца — для media-asset picker-а
 * (вкладка History в Reference drawer).
 */
export function listAssetsForOwner(owner, kind = null, limit = 200) {
  const args = [owner];
  let sql = `
    SELECT r.id, r.kind, r.model, r.result_url AS resultUrl,
           r.created_at AS createdAt,
           json_extract(r.input_json, '$.aspect')   AS aspect,
           json_extract(r.input_json, '$.duration') AS duration,
           json_extract(r.input_json, '$.size')     AS size,
           p.id AS projectId, p.title AS projectTitle
    FROM media_runs r
    INNER JOIN media_projects p ON p.id = r.project_id
    WHERE p.owner = ? AND r.status = 'done' AND r.result_url IS NOT NULL
  `;
  if (kind) { sql += ` AND r.kind = ?`; args.push(kind); }
  sql += ` ORDER BY r.created_at DESC LIMIT ?`;
  args.push(limit);
  return db.prepare(sql).all(...args);
}

/** Папка для файлов проекта; создаём по требованию. */
export function projectDir(projectId) {
  const dir = path.join(MEDIA_DIR, projectId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* =================== uploads =================== */

export const UPLOADS_ROOT = path.join(MEDIA_DIR, '_uploads');
fs.mkdirSync(UPLOADS_ROOT, { recursive: true });

export function uploadsDir(owner) {
  const safe = owner.replace(/[^a-z0-9._@-]+/gi, '_');
  const dir = path.join(UPLOADS_ROOT, safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function createUpload({ owner, id, filename, origName, mime, size, folder }) {
  db.prepare(`
    INSERT INTO media_uploads (id, owner, filename, orig_name, mime, size, folder, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, owner, filename, origName || null, mime, size, folder || '', now());
  return getUpload(id, owner);
}

export function getUpload(id, owner) {
  const row = db.prepare(`
    SELECT id, owner, filename, orig_name AS origName, mime, size, folder,
           created_at AS createdAt
    FROM media_uploads WHERE id = ? AND owner = ?
  `).get(id, owner);
  return row;
}

/**
 * Версия getUpload без проверки owner — для подписанных URL и внутренних
 * исполнителей (runner). Возвращает null если такого id нет.
 */
export function getUploadById(id) {
  return db.prepare(`
    SELECT id, owner, filename, orig_name AS origName, mime, size, folder,
           created_at AS createdAt
    FROM media_uploads WHERE id = ?
  `).get(id);
}

export function listUploads(owner, { folder = null, limit = 200 } = {}) {
  const args = [owner];
  let sql = `
    SELECT id, filename, orig_name AS origName, mime, size, folder, created_at AS createdAt
    FROM media_uploads WHERE owner = ?
  `;
  if (folder !== null) { sql += ` AND folder = ?`; args.push(folder); }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  args.push(limit);
  return db.prepare(sql).all(...args);
}

export function deleteUpload(id, owner) {
  const row = getUpload(id, owner);
  if (!row) return false;
  const file = path.join(uploadsDir(owner), row.filename);
  if (fs.existsSync(file)) {
    try { fs.unlinkSync(file); } catch {}
  }
  db.prepare(`DELETE FROM media_uploads WHERE id = ? AND owner = ?`).run(id, owner);
  return true;
}
