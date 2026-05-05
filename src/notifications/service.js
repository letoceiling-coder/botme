import { randomUUID } from 'node:crypto';
import { db, now } from '../db.js';
import { notifyRepo, emptyNotificationRow, logDelivery } from './repo.js';
import { formatLeadNotificationBody } from './format-lead-message.js';
import { getSystemSmtpTransportOptions, isSystemSmtpConfigured } from './system-smtp.js';
import { sendEmailViaTransport } from './email-provider.js';
import { sendTelegramMessage } from './telegram-provider.js';
import { sendVkUserMessage } from './vk-provider.js';

const insertLeadStmt = db.prepare(`
  INSERT INTO leads (id, assistant_id, conversation_id, name, email, phone, message, meta_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/** Создание лида + постановка уведомлений в фон (не блокирует ответ HTTP). */
export function insertAssistantLead({
  assistantId,
  conversationId,
  name,
  email,
  phone,
  message,
  meta,
  limits = 'admin',
}) {
  const id = randomUUID();
  const ts = now();
  const phoneMax = limits === 'public' ? 50 : 80;
  const msgMax = limits === 'public' ? 2000 : 4000;

  const nm = name ? String(name).slice(0, 200) : null;
  const em = email ? String(email).slice(0, 200) : null;
  const ph = phone ? String(phone).slice(0, phoneMax) : null;
  const msg = message ? String(message).slice(0, msgMax) : null;
  const metaStr = meta ? JSON.stringify(meta) : null;

  insertLeadStmt.run(id, assistantId, conversationId || null, nm, em, ph, msg, metaStr, ts);

  const lead = {
    id,
    assistant_id: assistantId,
    conversation_id: conversationId || null,
    name: nm,
    email: em,
    phone: ph,
    message: msg,
    meta_json: metaStr,
    created_at: ts,
  };

  scheduleLeadNotifications({ assistantId, lead });
  return id;
}

export function scheduleLeadNotifications({ assistantId, lead }) {
  setImmediate(() => {
    notifyLeadCreated({ assistantId, lead }).catch((e) => {
      console.error('[notify/lead]', e);
    });
  });
}

function rowToSettingsObj(row) {
  if (!row) return null;
  return {
    assistant_id: row.assistant_id,
    email_enabled: !!row.email_enabled,
    email_to: row.email_to || '',
    email_smtp_host: row.email_smtp_host || '',
    email_smtp_port: row.email_smtp_port,
    email_smtp_secure: !!row.email_smtp_secure,
    email_smtp_user: row.email_smtp_user || '',
    email_smtp_pass: row.email_smtp_pass || '',
    email_from_override: row.email_from_override || '',
    telegram_enabled: !!row.telegram_enabled,
    telegram_chat_id: row.telegram_chat_id || '',
    telegram_bot_token: row.telegram_bot_token || '',
    vk_enabled: !!row.vk_enabled,
    vk_user_id: row.vk_user_id || '',
    vk_access_token: row.vk_access_token || '',
    updated_at: row.updated_at,
  };
}

/** Публичный GET: без секретов */
export function getNotificationSettingsPublic(assistantId) {
  const row = notifyRepo.getSettings.get(assistantId);
  const base = rowToSettingsObj(row) || { ...emptyNotificationRow(assistantId), assistant_id: assistantId };
  const {
    email_smtp_pass: _p,
    telegram_bot_token: _t,
    vk_access_token: _v,
    ...safe
  } = base;
  void _p; void _t; void _v;
  return {
    ...safe,
    secrets: {
      email_smtp_pass_set: !!(row?.email_smtp_pass),
      telegram_bot_token_set: !!(row?.telegram_bot_token),
      vk_access_token_set: !!(row?.vk_access_token),
    },
    system_smtp_available: isSystemSmtpConfigured(),
  };
}

function mergeSecret(prev, incoming) {
  if (incoming === undefined) return prev;
  if (incoming === null || incoming === '') return '';
  return String(incoming);
}

/** PUT: incoming — объект из JSON; для секретов пустая строка = очистить, undefined = оставить прежнее */
export function saveNotificationSettings(assistantId, incoming) {
  const prev = notifyRepo.getSettings.get(assistantId);
  const cur = prev ? rowToSettingsObj(prev) : { ...emptyNotificationRow(assistantId), assistant_id: assistantId };

  const next = {
    assistant_id: assistantId,
    email_enabled: incoming.email_enabled !== undefined ? (incoming.email_enabled ? 1 : 0) : (cur.email_enabled ? 1 : 0),
    email_to: incoming.email_to !== undefined ? String(incoming.email_to || '').slice(0, 320) : cur.email_to,
    email_smtp_host: incoming.email_smtp_host !== undefined ? String(incoming.email_smtp_host || '').slice(0, 200) : cur.email_smtp_host,
    email_smtp_port: incoming.email_smtp_port !== undefined
      ? (incoming.email_smtp_port === null || incoming.email_smtp_port === '' ? null : Number(incoming.email_smtp_port))
      : cur.email_smtp_port,
    email_smtp_secure: incoming.email_smtp_secure !== undefined ? (incoming.email_smtp_secure ? 1 : 0) : (cur.email_smtp_secure ? 1 : 0),
    email_smtp_user: incoming.email_smtp_user !== undefined ? String(incoming.email_smtp_user || '').slice(0, 200) : cur.email_smtp_user,
    email_smtp_pass: mergeSecret(cur.email_smtp_pass, incoming.email_smtp_pass),
    email_from_override: incoming.email_from_override !== undefined ? String(incoming.email_from_override || '').slice(0, 320) : cur.email_from_override,
    telegram_enabled: incoming.telegram_enabled !== undefined ? (incoming.telegram_enabled ? 1 : 0) : (cur.telegram_enabled ? 1 : 0),
    telegram_chat_id: incoming.telegram_chat_id !== undefined ? String(incoming.telegram_chat_id || '').slice(0, 80) : cur.telegram_chat_id,
    telegram_bot_token: mergeSecret(cur.telegram_bot_token, incoming.telegram_bot_token),
    vk_enabled: incoming.vk_enabled !== undefined ? (incoming.vk_enabled ? 1 : 0) : (cur.vk_enabled ? 1 : 0),
    vk_user_id: incoming.vk_user_id !== undefined ? String(incoming.vk_user_id || '').slice(0, 40) : cur.vk_user_id,
    vk_access_token: mergeSecret(cur.vk_access_token, incoming.vk_access_token),
    updated_at: now(),
  };

  notifyRepo.upsertSettings.run(next);
  return getNotificationSettingsPublic(assistantId);
}

async function tryEmail(settings, lead, subjectPrefix) {
  const to = String(settings.email_to || '').trim();
  if (!to) throw new Error('Не указан email получателя');

  const body = formatLeadNotificationBody(lead);
  const subject = `${subjectPrefix}: новый лид`;

  const sys = getSystemSmtpTransportOptions();
  if (sys) {
    await sendEmailViaTransport({
      transportOpts: sys.transport,
      from: sys.from,
      to,
      subject,
      text: body,
    });
    return;
  }

  const host = String(settings.email_smtp_host || '').trim();
  const from = String(settings.email_from_override || '').trim();
  if (!host || !from) {
    throw new Error('SMTP сервера не заданы: укажите переменные SMTP_* на сервере или свой SMTP в настройках ассистента');
  }

  const port = Number(settings.email_smtp_port || 587);
  const secure = !!settings.email_smtp_secure;
  const user = String(settings.email_smtp_user || '').trim();
  const pass = String(settings.email_smtp_pass || '');
  const auth = user ? { user, pass } : undefined;

  await sendEmailViaTransport({
    transportOpts: { host, port, secure, auth },
    from,
    to,
    subject,
    text: body,
  });
}

async function tryTelegram(settings, lead, subjectLine) {
  if (!settings.telegram_enabled) return;
  const text = `${subjectLine}\n\n${formatLeadNotificationBody(lead)}`;
  await sendTelegramMessage({
    botToken: settings.telegram_bot_token,
    chatId: settings.telegram_chat_id,
    text,
  });
}

async function tryVk(settings, lead, subjectLine) {
  if (!settings.vk_enabled) return;
  const text = `${subjectLine}\n\n${formatLeadNotificationBody(lead)}`;
  await sendVkUserMessage({
    accessToken: settings.vk_access_token,
    userId: settings.vk_user_id,
    message: text,
  });
}

export async function notifyLeadCreated({ assistantId, lead }) {
  const row = notifyRepo.getSettings.get(assistantId);
  const settings = rowToSettingsObj(row);
  if (!settings) return;

  const subjectPrefix = 'Botme';
  const channels = [];

  if (settings.email_enabled) channels.push('email');
  if (settings.telegram_enabled) channels.push('telegram');
  if (settings.vk_enabled) channels.push('vk');

  for (const ch of channels) {
    try {
      if (ch === 'email') await tryEmail(settings, lead, subjectPrefix);
      else if (ch === 'telegram') await tryTelegram(settings, lead, 'Новый лид');
      else if (ch === 'vk') await tryVk(settings, lead, 'Новый лид');
      logDelivery({ leadId: lead.id, assistantId, channel: ch, ok: true, error: null });
    } catch (e) {
      const msg = e?.message || String(e);
      console.warn(`[notify/${ch}]`, msg);
      logDelivery({ leadId: lead.id, assistantId, channel: ch, ok: false, error: msg });
    }
  }
}

/** Тест каналов без лида (mock-тело). */
export async function sendTestNotifications(assistantId, { channels }) {
  const row = notifyRepo.getSettings.get(assistantId);
  const settings = rowToSettingsObj(row || emptyNotificationRow(assistantId));
  if (!settings) throw new Error('настройки не найдены');

  const mockLead = {
    id: 'test',
    name: 'Тест',
    phone: '+70000000000',
    email: 'test@example.com',
    message: 'Проверка уведомлений',
    meta_json: JSON.stringify({ source: 'test' }),
  };

  const want = new Set((channels && channels.length ? channels : ['email', 'telegram', 'vk']));
  const results = [];

  if (want.has('email') && settings.email_enabled) {
    try {
      await tryEmail(settings, mockLead, '[Тест] Botme');
      results.push({ channel: 'email', ok: true });
    } catch (e) {
      results.push({ channel: 'email', ok: false, error: e.message });
    }
  }

  if (want.has('telegram') && settings.telegram_enabled) {
    try {
      await tryTelegram(settings, mockLead, '[Тест] Новый лид');
      results.push({ channel: 'telegram', ok: true });
    } catch (e) {
      results.push({ channel: 'telegram', ok: false, error: e.message });
    }
  }

  if (want.has('vk') && settings.vk_enabled) {
    try {
      await tryVk(settings, mockLead, '[Тест] Новый лид');
      results.push({ channel: 'vk', ok: true });
    } catch (e) {
      results.push({ channel: 'vk', ok: false, error: e.message });
    }
  }

  return results;
}
