/**
 * Express-роуты раздела /media (AI Media Studio).
 *
 * Все роуты gated через appAuthGate (общий middleware), поэтому ownerId
 * берём из req.session.user.email.
 *
 * Сейчас покрыты только базовые CRUD проекта и список runs. Узлы
 * (image/video/upscale/audio) добавятся в следующих фазах.
 */

import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  listProjects, getProject, createProject, saveProjectGraph,
  renameProject, deleteProject, listRunsForProject, listAssetsForOwner,
  getRun, MEDIA_DIR,
  createUpload, getUpload, getUploadById, listUploads, deleteUpload, uploadsDir,
  getUsageStats,
} from './store.js';
import { runAssistantSync, startImageRun, startVideoRun, startUpscaleRun, startAudioRun } from './runner.js';
import { verifyMediaSig } from './sign.js';
import { getAvailableCatalog } from './catalog.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB на файл
});

const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4',
]);

function extFromMime(mime, fallback = 'bin') {
  const map = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
    'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/ogg': 'ogg', 'audio/mp4': 'm4a',
  };
  return map[mime] || fallback;
}

export function createMediaRouter() {
  const router = express.Router();

  // Все роуты JSON; auth уже проверен глобально.
  // В сессии лежат flat-поля (см. src/auth/routes.js), используем email.
  function ownerOf(req) {
    return String(req.session?.email || '').toLowerCase();
  }

  router.get('/projects', (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ error: 'unauthorized' });
    res.json({ items: listProjects(owner) });
  });

  router.post('/projects', express.json({ limit: '64kb' }), (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ error: 'unauthorized' });
    const title = String(req.body?.title || 'Untitled space').slice(0, 200);
    const p = createProject(owner, title);
    res.json(p);
  });

  router.get('/projects/:id', (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ error: 'unauthorized' });
    const p = getProject(owner, req.params.id);
    if (!p) return res.status(404).json({ error: 'not_found' });
    res.json(p);
  });

  router.put('/projects/:id', express.json({ limit: '8mb' }), (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ error: 'unauthorized' });
    const { graph, title } = req.body || {};
    if (graph && typeof graph !== 'object') return res.status(400).json({ error: 'bad_graph' });
    const p = saveProjectGraph(owner, req.params.id, graph, title);
    if (!p) return res.status(404).json({ error: 'not_found' });
    res.json(p);
  });

  router.patch('/projects/:id', express.json({ limit: '64kb' }), (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ error: 'unauthorized' });
    const { title } = req.body || {};
    if (typeof title !== 'string') return res.status(400).json({ error: 'bad_title' });
    const p = renameProject(owner, req.params.id, title);
    res.json(p);
  });

  router.delete('/projects/:id', (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ error: 'unauthorized' });
    const ok = deleteProject(owner, req.params.id);
    res.json({ ok });
  });

  // Список runs проекта (для отладки и истории; UI пока не использует).
  router.get('/projects/:id/runs', (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ error: 'unauthorized' });
    const p = getProject(owner, req.params.id);
    if (!p) return res.status(404).json({ error: 'not_found' });
    res.json({ items: listRunsForProject(req.params.id) });
  });

  // Список ассетов пользователя (для Reference Picker / Media Manager).
  // GET /api/media/assets?kind=image&limit=200
  router.get('/assets', (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ error: 'unauthorized' });
    const kind = req.query.kind ? String(req.query.kind) : null;
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    res.json({ items: listAssetsForOwner(owner, kind, limit) });
  });

  // ---------------------------------------------------------
  // Uploads — личная медиа-библиотека пользователя
  // ---------------------------------------------------------

  router.get('/uploads', (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ error: 'unauthorized' });
    const folder = typeof req.query.folder === 'string' ? req.query.folder : null;
    const items = listUploads(owner, { folder, limit: 500 });
    // Дополним удобным URL для фронта.
    res.json({
      items: items.map((u) => ({
        ...u,
        url: `/media-uploads/${u.id}`,
        kind: u.mime?.startsWith('image/') ? 'image'
          : u.mime?.startsWith('video/') ? 'video'
          : u.mime?.startsWith('audio/') ? 'audio' : 'file',
      })),
    });
  });

  router.post('/uploads', upload.array('files', 20), async (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ error: 'unauthorized' });
    const folder = String(req.body?.folder || '').slice(0, 200);
    const dir = uploadsDir(owner);
    const out = [];
    try {
      for (const f of req.files || []) {
        if (!ALLOWED_MIME.has(f.mimetype)) {
          return res.status(400).json({ error: `Неподдерживаемый тип: ${f.mimetype}` });
        }
        const id = randomUUID();
        const ext = extFromMime(f.mimetype, 'bin');
        const filename = `${id}.${ext}`;
        fs.writeFileSync(path.join(dir, filename), f.buffer);
        const row = createUpload({
          owner, id, filename,
          origName: f.originalname, mime: f.mimetype, size: f.size, folder,
        });
        out.push({
          ...row,
          url: `/media-uploads/${row.id}`,
          kind: row.mime?.startsWith('image/') ? 'image'
            : row.mime?.startsWith('video/') ? 'video'
            : row.mime?.startsWith('audio/') ? 'audio' : 'file',
        });
      }
      res.json({ ok: true, items: out });
    } catch (e) {
      console.error('[media/uploads]', e);
      res.status(500).json({ error: e?.message || 'upload_failed' });
    }
  });

  router.delete('/uploads/:id', (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ error: 'unauthorized' });
    const ok = deleteUpload(req.params.id, owner);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  });

  router.get('/runs/:id', (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ error: 'unauthorized' });
    const r = getRun(req.params.id);
    if (!r) return res.status(404).json({ error: 'not_found' });
    // Проверим, что проект принадлежит пользователю.
    const p = getProject(owner, r.projectId);
    if (!p) return res.status(403).json({ error: 'forbidden' });
    res.json(r);
  });

  // ---------------------------------------------------------
  // Запуск узлов: Assistant (sync) и Image Generator (async).
  // ---------------------------------------------------------

  router.post('/run/assistant', express.json({ limit: '512kb' }), async (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ error: 'unauthorized' });
    const { projectId, nodeId, prompt, context, model, maxTokens } = req.body || {};
    if (projectId && !getProject(owner, projectId)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      const out = await runAssistantSync({ projectId, nodeId, prompt, context, model, maxTokens });
      res.json({ ok: true, ...out });
    } catch (e) {
      console.error('[media/run/assistant]', e);
      res.status(500).json({
        error: e?.message || 'assistant_failed',
        code: e?.code,
        errors: e?.errors,
      });
    }
  });

  router.post('/run/image', express.json({ limit: '512kb' }), async (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ error: 'unauthorized' });
    const { projectId, nodeId, model, prompt, size, referenceUrl } = req.body || {};
    if (!projectId || !nodeId) {
      return res.status(400).json({ error: 'projectId and nodeId required' });
    }
    if (!getProject(owner, projectId)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      const run = await startImageRun(projectId, nodeId, { model, prompt, size, referenceUrl });
      res.json({ ok: true, runId: run.id, status: run.status });
    } catch (e) {
      console.error('[media/run/image]', e);
      res.status(500).json({
        error: e?.message || 'image_failed',
        code: e?.code,
      });
    }
  });

  router.post('/run/video', express.json({ limit: '512kb' }), async (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ error: 'unauthorized' });
    const { projectId, nodeId, model, prompt, aspect, duration, referenceUrl } = req.body || {};
    if (!projectId || !nodeId) {
      return res.status(400).json({ error: 'projectId and nodeId required' });
    }
    if (!getProject(owner, projectId)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      const run = await startVideoRun(projectId, nodeId, {
        model, prompt, aspect, duration, referenceUrl,
      });
      res.json({ ok: true, runId: run.id, status: run.status });
    } catch (e) {
      console.error('[media/run/video]', e);
      res.status(500).json({ error: e?.message || 'video_failed', code: e?.code });
    }
  });

  // ---------------------------------------------------------
  // Catalog: какие модели реально доступны (есть ключи) и их параметры
  // GET /api/media/catalog
  // ---------------------------------------------------------
  router.get('/catalog', (req, res) => {
    if (!ownerOf(req)) return res.status(401).json({ error: 'unauthorized' });
    try {
      res.json({ ok: true, ...getAvailableCatalog() });
    } catch (e) {
      console.error('[media/catalog]', e);
      res.status(500).json({ error: e?.message || 'catalog_failed' });
    }
  });

  // ---------------------------------------------------------
  // Usage / биллинг
  // GET /api/media/usage?range=7d|30d|90d|all
  // ---------------------------------------------------------
  router.get('/usage', (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ error: 'unauthorized' });
    const range = String(req.query.range || '30d');
    let fromTs = null;
    const day = 24 * 60 * 60 * 1000;
    if (range === '7d')  fromTs = Date.now() - 7 * day;
    else if (range === '30d') fromTs = Date.now() - 30 * day;
    else if (range === '90d') fromTs = Date.now() - 90 * day;
    try {
      const stats = getUsageStats(owner, { fromTs, limit: 50 });
      res.json({ ok: true, range, ...stats });
    } catch (e) {
      console.error('[media/usage]', e);
      res.status(500).json({ error: e?.message || 'usage_failed' });
    }
  });

  router.post('/run/audio', express.json({ limit: '512kb' }), async (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ error: 'unauthorized' });
    const { projectId, nodeId, model, voice, voiceId, text } = req.body || {};
    if (!projectId || !nodeId) {
      return res.status(400).json({ error: 'projectId and nodeId required' });
    }
    if (!getProject(owner, projectId)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      const run = await startAudioRun(projectId, nodeId, { model, voiceId: voiceId || voice, text });
      res.json({ ok: true, runId: run.id, status: run.status });
    } catch (e) {
      console.error('[media/run/audio]', e);
      res.status(500).json({ error: e?.message || 'audio_failed', code: e?.code });
    }
  });

  router.post('/run/upscale', express.json({ limit: '512kb' }), async (req, res) => {
    const owner = ownerOf(req);
    if (!owner) return res.status(401).json({ error: 'unauthorized' });
    const { projectId, nodeId, model, scale, creativity, referenceUrl } = req.body || {};
    if (!projectId || !nodeId) {
      return res.status(400).json({ error: 'projectId and nodeId required' });
    }
    if (!getProject(owner, projectId)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      const run = await startUpscaleRun(projectId, nodeId, {
        model, scale, creativity, referenceUrl,
      });
      res.json({ ok: true, runId: run.id, status: run.status });
    } catch (e) {
      console.error('[media/run/upscale]', e);
      res.status(500).json({ error: e?.message || 'upscale_failed', code: e?.code });
    }
  });

  return router;
}

/**
 * Статика для файлов media:
 *   /media-files/<projectId>/<filename>  — результаты генераций
 *   /media-uploads/<uploadId>            — загруженные пользователем файлы
 * Доступ ограничен: пользователь должен иметь доступ к проекту/uploadу.
 */
export function mountMediaStatic(app) {
  // -------- результаты генераций --------
  app.get('/media-files/:projectId/:file', (req, res) => {
    const { projectId, file } = req.params;
    if (!/^[\w-]+$/.test(projectId) || !/^[\w.\-]+$/.test(file)) {
      return res.status(400).send('bad path');
    }
    const localPath = `/media-files/${projectId}/${file}`;
    // Доступ: либо хозяин проекта по сессии, либо валидная HMAC-подпись
    // в query (для машинных клиентов вроде Replicate).
    const sigOk = verifyMediaSig(localPath, req.query.exp, req.query.sig);
    if (!sigOk) {
      const owner = String(req.session?.email || '').toLowerCase();
      if (!owner) return res.status(401).send('unauthorized');
      const p = getProject(owner, projectId);
      if (!p) return res.status(404).send('not found');
    }
    const full = path.join(MEDIA_DIR, projectId, file);
    res.sendFile(full, (err) => { if (err) res.status(404).end(); });
  });

  // -------- личные uploads пользователя --------
  app.get('/media-uploads/:id', (req, res) => {
    const { id } = req.params;
    if (!/^[\w-]+$/.test(id)) return res.status(400).send('bad id');
    const localPath = `/media-uploads/${id}`;
    const sigOk = verifyMediaSig(localPath, req.query.exp, req.query.sig);

    let upload;
    if (sigOk) {
      upload = getUploadById(id);
    } else {
      const owner = String(req.session?.email || '').toLowerCase();
      if (!owner) return res.status(401).send('unauthorized');
      upload = getUpload(id, owner);
    }
    if (!upload) return res.status(404).send('not found');
    const full = path.join(uploadsDir(upload.owner), upload.filename);
    res.type(upload.mime || 'application/octet-stream');
    res.sendFile(full, (err) => { if (err) res.status(404).end(); });
  });
}
