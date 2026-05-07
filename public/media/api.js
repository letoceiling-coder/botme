/**
 * REST-клиент для /api/media. Опирается на auth-fetch.js (cookie-сессия и
 * редирект на /login.html при 401), поэтому мы здесь просто вызываем fetch.
 */

const BASE = '/api/media';

async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (!r.ok) {
    let payload = null;
    try { payload = await r.json(); } catch {}
    const err = new Error(payload?.error || `HTTP ${r.status}`);
    err.status = r.status;
    err.payload = payload;
    throw err;
  }
  return await r.json();
}

export const api = {
  listProjects: () => req('GET', '/projects'),
  createProject: (title) => req('POST', '/projects', { title }),
  getProject: (id) => req('GET', `/projects/${id}`),
  saveProject: (id, graph, title) => req('PUT', `/projects/${id}`, { graph, title }),
  renameProject: (id, title) => req('PATCH', `/projects/${id}`, { title }),
  deleteProject: (id) => req('DELETE', `/projects/${id}`),

  // Run-узлы
  runAssistant: (body) => req('POST', '/run/assistant', body),
  runImage:     (body) => req('POST', '/run/image', body),
  runVideo:     (body) => req('POST', '/run/video', body),
  runUpscale:   (body) => req('POST', '/run/upscale', body),
  runAudio:     (body) => req('POST', '/run/audio',   body),
  getRun:       (id)   => req('GET',  `/runs/${id}`),

  // Ассеты (Reference picker / Media manager)
  listAssets:   (kind = '') => req('GET', '/assets' + (kind ? `?kind=${kind}` : '')),

  // Catalog (доступные модели с учётом ключей)
  getCatalog: () => req('GET', '/catalog'),

  // Usage / биллинг
  getUsage: (range = '30d') => req('GET', `/usage?range=${encodeURIComponent(range)}`),

  // Личные uploads
  listUploads: () => req('GET', '/uploads'),
  uploadFiles: async (files, folder = '') => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    if (folder) fd.append('folder', folder);
    const r = await fetch('/api/media/uploads', {
      method: 'POST',
      body: fd,
      credentials: 'same-origin',
    });
    if (!r.ok) {
      let payload = null; try { payload = await r.json(); } catch {}
      const err = new Error(payload?.error || `HTTP ${r.status}`);
      err.status = r.status; err.payload = payload;
      throw err;
    }
    return r.json();
  },
  deleteUpload: (id) => req('DELETE', `/uploads/${id}`),
};
