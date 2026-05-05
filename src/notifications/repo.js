import { db, now } from '../db.js';
import { randomUUID } from 'node:crypto';

export const notifyRepo = {
  getSettings: db.prepare(`SELECT * FROM assistant_notification_settings WHERE assistant_id = ?`),
  upsertSettings: db.prepare(`
    INSERT INTO assistant_notification_settings (
      assistant_id, email_enabled, email_to,
      email_smtp_host, email_smtp_port, email_smtp_secure, email_smtp_user, email_smtp_pass, email_from_override,
      telegram_enabled, telegram_chat_id, telegram_bot_token,
      vk_enabled, vk_user_id, vk_access_token,
      updated_at
    ) VALUES (
      @assistant_id, @email_enabled, @email_to,
      @email_smtp_host, @email_smtp_port, @email_smtp_secure, @email_smtp_user, @email_smtp_pass, @email_from_override,
      @telegram_enabled, @telegram_chat_id, @telegram_bot_token,
      @vk_enabled, @vk_user_id, @vk_access_token,
      @updated_at
    )
    ON CONFLICT(assistant_id) DO UPDATE SET
      email_enabled       = excluded.email_enabled,
      email_to            = excluded.email_to,
      email_smtp_host     = excluded.email_smtp_host,
      email_smtp_port     = excluded.email_smtp_port,
      email_smtp_secure   = excluded.email_smtp_secure,
      email_smtp_user     = excluded.email_smtp_user,
      email_smtp_pass     = excluded.email_smtp_pass,
      email_from_override = excluded.email_from_override,
      telegram_enabled    = excluded.telegram_enabled,
      telegram_chat_id    = excluded.telegram_chat_id,
      telegram_bot_token  = excluded.telegram_bot_token,
      vk_enabled          = excluded.vk_enabled,
      vk_user_id          = excluded.vk_user_id,
      vk_access_token     = excluded.vk_access_token,
      updated_at          = excluded.updated_at
  `),
  insertDelivery: db.prepare(`
    INSERT INTO notification_deliveries (id, lead_id, assistant_id, channel, ok, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
};

export function emptyNotificationRow(assistantId) {
  return {
    assistant_id: assistantId,
    email_enabled: 0,
    email_to: '',
    email_smtp_host: '',
    email_smtp_port: null,
    email_smtp_secure: 0,
    email_smtp_user: '',
    email_smtp_pass: '',
    email_from_override: '',
    telegram_enabled: 0,
    telegram_chat_id: '',
    telegram_bot_token: '',
    vk_enabled: 0,
    vk_user_id: '',
    vk_access_token: '',
    updated_at: now(),
  };
}

export function logDelivery({ leadId, assistantId, channel, ok, error }) {
  try {
    notifyRepo.insertDelivery.run(
      randomUUID(),
      leadId,
      assistantId,
      channel,
      ok ? 1 : 0,
      error ? String(error).slice(0, 2000) : null,
      now(),
    );
  } catch (e) {
    console.warn('[notify/log]', e.message);
  }
}
