import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProjectIntegrity, normalizeLocalRef } from '../src/project-validator.js';

test('Vite scaffold (только index.html, ссылки на /src/main.tsx) — определяется как broken', () => {
  const files = new Map([
    ['index.html', `<!DOCTYPE html><html><head>
      <link rel="icon" href="/vite.svg" />
      <title>App</title></head>
      <body><div id="root"></div>
      <script type="module" src="/src/main.tsx"></script>
      </body></html>`],
  ]);
  const r = validateProjectIntegrity(files);
  assert.equal(r.ok, false);
  assert.equal(r.hasFrameworkScaffold, true);
  assert.equal(r.scaffoldKind, 'vite');
  assert.ok(r.missing.length >= 1);
});

test('Самодостаточный single-file (только https-CDN) — ок', () => {
  const files = new Map([
    ['index.html', `<!DOCTYPE html><html><head>
      <script src="https://cdn.tailwindcss.com"></script>
      </head><body><h1>Hi</h1>
      <script>console.log("ok")</script>
      </body></html>`],
  ]);
  const r = validateProjectIntegrity(files);
  assert.equal(r.ok, true);
  assert.equal(r.missing.length, 0);
  assert.equal(r.hasFrameworkScaffold, false);
});

test('Многофайловый: ссылка на assets/style.css есть в проекте → ок', () => {
  const files = new Map([
    ['index.html', `<!DOCTYPE html><html><head>
      <link rel="stylesheet" href="assets/style.css">
      </head><body>
      <a href="about.html">About</a>
      <script src="assets/app.js"></script>
      </body></html>`],
    ['about.html', `<!DOCTYPE html><html><body><a href="index.html">Home</a></body></html>`],
    ['assets/style.css', `:root{--c:#fff}`],
    ['assets/app.js', `console.log(1)`],
  ]);
  const r = validateProjectIntegrity(files);
  assert.equal(r.ok, true);
});

test('Многофайловый: ссылка на отсутствующий assets/missing.js → broken', () => {
  const files = new Map([
    ['index.html', `<!DOCTYPE html><html><body>
      <script src="assets/missing.js"></script>
      </body></html>`],
  ]);
  const r = validateProjectIntegrity(files);
  assert.equal(r.ok, false);
  assert.equal(r.hasFrameworkScaffold, false);
  assert.equal(r.missing[0].normalized, 'assets/missing.js');
});

test('normalizeLocalRef: внешние ссылки игнорируются', () => {
  assert.equal(normalizeLocalRef('https://cdn.tailwindcss.com', 'index.html'), null);
  assert.equal(normalizeLocalRef('data:image/svg+xml,...', 'index.html'), null);
  assert.equal(normalizeLocalRef('mailto:a@b.c', 'index.html'), null);
  assert.equal(normalizeLocalRef('#hero', 'index.html'), null);
});

test('normalizeLocalRef: абсолютный путь /src/main.tsx → src/main.tsx', () => {
  assert.equal(normalizeLocalRef('/src/main.tsx', 'index.html'), 'src/main.tsx');
});

test('normalizeLocalRef: относительный путь от вложенной html', () => {
  assert.equal(normalizeLocalRef('app.js', 'pages/sub.html'), 'pages/app.js');
  assert.equal(normalizeLocalRef('../assets/x.css', 'pages/sub.html'), 'assets/x.css');
});
