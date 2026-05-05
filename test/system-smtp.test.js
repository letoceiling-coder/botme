import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSystemSmtpConfigured, getSystemSmtpTransportOptions } from '../src/notifications/system-smtp.js';

test('system SMTP detection respects env', () => {
  const prev = { ...process.env };
  try {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_FROM;
    assert.equal(isSystemSmtpConfigured(), false);
    assert.equal(getSystemSmtpTransportOptions(), null);

    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_FROM = 'noreply@example.com';
    assert.equal(isSystemSmtpConfigured(), true);
    const o = getSystemSmtpTransportOptions();
    assert.ok(o.transport.host === 'smtp.example.com');
    assert.ok(o.from.includes('noreply'));
  } finally {
    process.env.SMTP_HOST = prev.SMTP_HOST;
    process.env.SMTP_FROM = prev.SMTP_FROM;
    if (prev.SMTP_HOST === undefined) delete process.env.SMTP_HOST;
    if (prev.SMTP_FROM === undefined) delete process.env.SMTP_FROM;
  }
});
