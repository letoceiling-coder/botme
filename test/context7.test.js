import { test } from 'node:test';
import assert from 'node:assert/strict';

// Эти тесты мокаются на глобальный fetch — без реальных сетевых вызовов.

const realFetch = globalThis.fetch;

function mockFetch(routes) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [pattern, handler] of routes) {
      if (pattern instanceof RegExp ? pattern.test(u) : u.includes(pattern)) {
        const res = await handler(u);
        return new Response(res.body, {
          status: res.status || 200,
          headers: res.headers || { 'content-type': 'text/plain' },
        });
      }
    }
    return new Response('not mocked: ' + u, { status: 599 });
  };
}

function restoreFetch() { globalThis.fetch = realFetch; }

test('isContext7Enabled = false без ключа', async () => {
  delete process.env.CONTEXT7_API_KEY;
  const m = await import('../src/context7.js?v=1');
  m.__resetContext7Cache();
  assert.equal(m.isContext7Enabled(), false);
  const r = await m.buildContextBlockForPrompt('сайт с tailwind и aos');
  assert.equal(r.block, '');
});

test('detectLibrariesFromPrompt по словарю', async () => {
  process.env.CONTEXT7_API_KEY = 'ctx7sk-test';
  const m = await import('../src/context7.js?v=2');
  const found = m.detectLibrariesFromPrompt('сделай лендинг на TailwindCSS, добавь AOS и lucide иконки');
  const names = found.map((x) => x.name).sort();
  assert.deepEqual(names, ['aos', 'lucide', 'tailwindcss']);
});

test('buildContextBlockForPrompt: подмешивает блок с реальными ID', async () => {
  process.env.CONTEXT7_API_KEY = 'ctx7sk-test';
  mockFetch([
    [/\/v2\/context\?libraryId=%2Ftailwindlabs%2Ftailwindcss\.com/, () => ({
      status: 200, body: 'TAILWIND DOC SAMPLE: use cdn.tailwindcss.com',
    })],
    [/\/v2\/context\?libraryId=%2Fmichalsnik%2Faos/, () => ({
      status: 200, body: 'AOS DOC SAMPLE: data-aos="fade-up" + AOS.init()',
    })],
  ]);
  const m = await import('../src/context7.js?v=3');
  m.__resetContext7Cache();
  const r = await m.buildContextBlockForPrompt('сделай лендинг с TailwindCSS и AOS');
  restoreFetch();
  assert.ok(r.block.includes('TAILWIND DOC SAMPLE'));
  assert.ok(r.block.includes('AOS DOC SAMPLE'));
  assert.equal(r.used.length, 2);
});

test('getContextDocs: 301 → следует по redirectUrl', async () => {
  process.env.CONTEXT7_API_KEY = 'ctx7sk-test';
  let calls = 0;
  mockFetch([
    [/\/v2\/context\?libraryId=%2Fold%2Flib/, () => {
      calls++;
      return {
        status: 301,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'library_redirected', redirectUrl: '/new/lib' }),
      };
    }],
    [/\/v2\/context\?libraryId=%2Fnew%2Flib/, () => {
      calls++;
      return { status: 200, body: 'NEW LIB DOC' };
    }],
  ]);
  const m = await import('../src/context7.js?v=4');
  m.__resetContext7Cache();
  const txt = await m.getContextDocs('/old/lib', 'q');
  restoreFetch();
  assert.ok(txt.includes('NEW LIB DOC'));
  assert.equal(calls, 2);
});

test('кэш работает: повторный вызов не дёргает fetch', async () => {
  process.env.CONTEXT7_API_KEY = 'ctx7sk-test';
  let calls = 0;
  mockFetch([
    [/\/v2\/context/, () => {
      calls++;
      return { status: 200, body: 'CACHED' };
    }],
  ]);
  const m = await import('../src/context7.js?v=5');
  m.__resetContext7Cache();
  const a = await m.getContextDocs('/foo/bar', 'baz');
  const b = await m.getContextDocs('/foo/bar', 'baz');
  restoreFetch();
  assert.equal(a, b);
  assert.equal(calls, 1);
});

test('CONTEXT7_DISABLED=1 отключает фичу', async () => {
  process.env.CONTEXT7_API_KEY = 'ctx7sk-test';
  process.env.CONTEXT7_DISABLED = '1';
  const m = await import('../src/context7.js?v=6');
  assert.equal(m.isContext7Enabled(), false);
  delete process.env.CONTEXT7_DISABLED;
});
