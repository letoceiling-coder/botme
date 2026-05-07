import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smokeTestHtml } from '../src/runtime-smoke.js';

test('пустой html — не ok', async () => {
  const r = await smokeTestHtml('');
  assert.equal(r.ok, false);
});

test('обрезанный html (нет </html>) — не ok', async () => {
  const r = await smokeTestHtml(`<!DOCTYPE html><html><body><h1>x</h1>`);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /<\/html>|обрыв/i.test(e)));
});

test('window.FramerMotion без CDN framer-motion — не ok', async () => {
  const html = `<!DOCTYPE html><html><body>
    <div id="root"></div>
    <script>
      try { var x = window.FramerMotion.motion; } catch(e) {}
    </script></body></html>`;
  const r = await smokeTestHtml(html);
  assert.equal(r.ok, false);
});

test('минимальный валидный html — ok', async () => {
  const html = `<!DOCTYPE html><html lang="ru"><head>
    <meta charset="utf-8"><title>x</title>
    <script src="https://cdn.tailwindcss.com"></script>
    </head><body class="p-8">
    <h1 class="text-3xl">Hello world</h1>
    <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor.</p>
    <script>
      window.greet = function () { return 'hi'; };
      window.greet();
    </script>
    </body></html>`;
  const r = await smokeTestHtml(html, { requireBodyContent: true });
  assert.equal(r.ok, true);
});

test('ESM import из react внутри type="module" — не ok', async () => {
  const html = `<!DOCTYPE html><html><body>
    <script type="module">
      import React from 'react';
      console.log(React);
    </script></body></html>`;
  const r = await smokeTestHtml(html);
  assert.equal(r.ok, false);
});

test('ReferenceError из inline-script — не ok', async () => {
  const html = `<!DOCTYPE html><html><body>
    <script>
      doesNotExist.callMe();
    </script>
    </body></html>`;
  const r = await smokeTestHtml(html);
  assert.equal(r.ok, false);
});

test('AOS/lucide undefined в jsdom — не считается ошибкой', async () => {
  const html = `<!DOCTYPE html><html><body>
    <h1>title</h1>
    <p>some content here that is long enough to look like a real page block</p>
    <script>
      try { AOS.init(); } catch(e) { /* ok in node */ throw e; }
    </script></body></html>`;
  const r = await smokeTestHtml(html);
  assert.equal(r.ok, true);
});
