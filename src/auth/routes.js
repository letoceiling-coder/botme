import express from 'express';
import { db } from '../db.js';
import { verifyPassword } from './password.js';

const router = express.Router();

const getUser = db.prepare(`
  SELECT id, email, password_hash, display_name FROM app_users WHERE email = ? COLLATE NOCASE
`);

router.post('/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password ?? '';
  if (!email || !password) {
    return res.status(400).json({ error: 'Укажите email и пароль' });
  }
  const row = getUser.get(email);
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }
  req.session.userId = row.id;
  req.session.email = row.email;
  req.session.displayName = row.display_name;
  res.json({
    ok: true,
    user: { email: row.email, displayName: row.display_name },
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('[auth/logout]', err);
    res.clearCookie('botme.sid', { path: '/' });
    res.json({ ok: true });
  });
});

router.get('/me', (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Не авторизован', code: 'auth_required' });
  }
  res.json({
    email: req.session.email,
    displayName: req.session.displayName,
  });
});

export default router;
