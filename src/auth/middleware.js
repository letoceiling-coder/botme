/**
 * Доступ к админ-приложению только после входа.
 * Публично: логин, статика логотипа, виджет и /api/v1 для внешних сайтов.
 */
export function appAuthGate(req, res, next) {
  if (req.method === 'OPTIONS') return next();

  const p = req.path || '';

  if (p === '/login.html') return next();
  if (p.startsWith('/brand/')) return next();
  if (p.startsWith('/api/v1')) return next();
  if (p === '/widget.js') return next();
  if (p.startsWith('/widget/')) return next();
  if (p === '/api/auth/login' && req.method === 'POST') return next();

  // Медиа-файлы AI Media Studio: их обработчики сами решают, пускать ли по
  // сессии или по подписанному URL (нужно для внешних воркеров типа Replicate).
  if (p.startsWith('/media-files/'))   return next();
  if (p.startsWith('/media-uploads/')) return next();

  // Loopback bypass: Playwright headless Chromium и наш собственный orchestrator
  // ходят с 127.0.0.1 на /preview/<id>/ для smoke-тестов. Внешний пользователь
  // через Nginx/Cloudflare всегда виден с публичного IP, не loopback —
  // безопасно пускать без сессии.
  if (p.startsWith('/preview/') && isLoopbackRequest(req)) return next();

  if (req.session?.userId) return next();

  if (p.startsWith('/api/')) {
    return res.status(401).json({ error: 'Требуется вход', code: 'auth_required' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(403).send('Forbidden');
  }

  const accept = req.headers.accept || '';
  if (accept.includes('text/html')) {
    const dest = req.originalUrl || req.url || '/';
    return res.redirect(302, `/login.html?redirect=${encodeURIComponent(dest)}`);
  }

  return res.status(403).send('Forbidden');
}

/**
 * Запрос с loopback-адреса (внутренний Playwright/curl-проба).
 * Учитываем Express trust proxy: req.ip уже учтёт X-Forwarded-For, поэтому
 * для запросов из Nginx-цепочки req.ip = реальный IP клиента, а не 127.0.0.1.
 */
function isLoopbackRequest(req) {
  const ip = (req.ip || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  // Двойная проверка через socket.remoteAddress — на случай мисконфига trust proxy
  const remote = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if ((remote === '127.0.0.1' || remote === '::1') && !req.headers['x-forwarded-for']) return true;
  return false;
}
