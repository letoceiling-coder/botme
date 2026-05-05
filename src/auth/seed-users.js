import { randomUUID } from 'node:crypto';
import { db, now } from '../db.js';
import { hashPassword } from './password.js';

/** Стартовый пользователь (без регистрации в UI). */
const SEED_EMAIL = 'dsc-23@yandex.ru';
const SEED_PASSWORD = '123123123';
const SEED_NAME = 'Джон Уик';

const existsStmt = db.prepare(`SELECT id FROM app_users WHERE email = ? COLLATE NOCASE`);
const insertStmt = db.prepare(`
  INSERT INTO app_users (id, email, password_hash, display_name, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

export function seedDefaultAppUser() {
  try {
    const email = SEED_EMAIL.toLowerCase();
    if (existsStmt.get(email)) return;
    insertStmt.run(
      randomUUID(),
      email,
      hashPassword(SEED_PASSWORD),
      SEED_NAME,
      now(),
    );
    console.log('[auth] создан пользователь по умолчанию:', email);
  } catch (e) {
    console.warn('[auth] seed user:', e.message);
  }
}
