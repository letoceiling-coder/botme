import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLeadNotificationBody, formatLeadSource } from '../src/notifications/format-lead-message.js';

test('formatLeadSource maps meta', () => {
  assert.equal(formatLeadSource(null), '—');
  assert.equal(formatLeadSource(JSON.stringify({ source: 'api' })), 'виджет / API');
  assert.equal(formatLeadSource(JSON.stringify({ source: 'admin' })), 'админ-чат');
});

test('formatLeadNotificationBody lines', () => {
  const text = formatLeadNotificationBody({
    name: 'Иван',
    phone: '+79990001122',
    email: 'a@b.ru',
    message: 'Заявка',
    meta_json: JSON.stringify({ source: 'api' }),
  });
  assert.ok(text.includes('Иван'));
  assert.ok(text.includes('+79990001122'));
  assert.ok(text.includes('виджет'));
});
