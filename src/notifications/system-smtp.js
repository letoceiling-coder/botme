// Общий SMTP для всего инстанса (например botme.neeklo.ru в .env на сервере).

export function isSystemSmtpConfigured() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const from = String(process.env.SMTP_FROM || '').trim();
  return !!(host && from);
}

/** Опции транспорта nodemailer + адрес From для системной отправки */
export function getSystemSmtpTransportOptions() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = /^(1|true|yes)$/i.test(String(process.env.SMTP_SECURE || ''));
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '');
  const from = String(process.env.SMTP_FROM || '').trim();
  if (!host || !from) return null;
  const auth = user ? { user, pass } : undefined;
  const tls = process.env.SMTP_TLS_REJECT_UNAUTHORIZED === '0'
    ? { rejectUnauthorized: false }
    : undefined;
  return {
    transport: { host, port, secure, auth, ...(tls ? { tls } : {}) },
    from,
  };
}
