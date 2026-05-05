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
