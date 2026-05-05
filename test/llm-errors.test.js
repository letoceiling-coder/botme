import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLlmError } from '../src/llm-errors.js';

test('classifyLlmError: 401 → auth, skipProvider', () => {
  const info = classifyLlmError({ status: 401, message: 'invalid api key' });
  assert.equal(info.kind, 'auth');
  assert.equal(info.skipProvider, true);
  assert.equal(info.retryable, false);
});

test('classifyLlmError: 402/insufficient_quota → quota, skipProvider', () => {
  const info = classifyLlmError({ status: 402, message: 'You have insufficient quota' });
  assert.equal(info.kind, 'quota');
  assert.equal(info.skipProvider, true);
});

test('classifyLlmError: 429 → rate_limit, retryable', () => {
  const info = classifyLlmError({ status: 429, message: 'Rate limit exceeded' });
  assert.equal(info.kind, 'rate_limit');
  assert.equal(info.retryable, true);
});

test('classifyLlmError: 529/overloaded (Anthropic) → overloaded', () => {
  const info = classifyLlmError({ status: 529, error: { type: 'overloaded_error', message: 'Overloaded' } });
  assert.equal(info.kind, 'overloaded');
  assert.equal(info.retryable, true);
});

test('classifyLlmError: 503 → overloaded', () => {
  const info = classifyLlmError({ status: 503, message: 'Service Unavailable' });
  assert.equal(info.kind, 'overloaded');
});

test('classifyLlmError: 404 → not_found', () => {
  const info = classifyLlmError({ status: 404, message: 'model not found' });
  assert.equal(info.kind, 'not_found');
  assert.equal(info.retryable, false);
});

test('classifyLlmError: 400 + context → context_overflow', () => {
  const info = classifyLlmError({ status: 400, message: 'context length exceeded maximum context' });
  assert.equal(info.kind, 'context_overflow');
});

test('classifyLlmError: ECONNRESET → network, retryable', () => {
  const info = classifyLlmError({ code: 'ECONNRESET', message: 'socket hang up' });
  assert.equal(info.kind, 'network');
  assert.equal(info.retryable, true);
});

test('classifyLlmError: AbortError + _botmeTimeout → timeout', () => {
  const e = new Error('Превышен таймаут ожидания модели');
  e.name = 'AbortError';
  e._botmeTimeout = true;
  const info = classifyLlmError(e);
  assert.equal(info.kind, 'timeout');
  assert.equal(info.retryable, true);
});

test('classifyLlmError: AbortError без таймаута → aborted', () => {
  const e = new Error('Request aborted');
  e.name = 'AbortError';
  const info = classifyLlmError(e);
  assert.equal(info.kind, 'aborted');
  assert.equal(info.retryable, false);
});
