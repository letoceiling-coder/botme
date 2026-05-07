import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProjectIntegrity, normalizeLocalRef, isReactBundleAppPlaceholder } from '../src/project-validator.js';

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

test('badRuntime: window.FramerMotion без CDN — broken', () => {
  const files = new Map([
    ['index.html', `<!DOCTYPE html><html><head>
      <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
      </head><body><div id="root"></div>
      <script type="text/babel">
        const { motion } = window.FramerMotion;
        const App = () => <motion.div>x</motion.div>;
      </script></body></html>`],
  ]);
  const r = validateProjectIntegrity(files);
  assert.equal(r.ok, false);
  assert.equal(r.badRuntime[0].kind, 'framer-motion');
});

test('badRuntime: ESM-импорт react из npm — broken', () => {
  const files = new Map([
    ['index.html', `<!DOCTYPE html><html><body>
      <script type="module">
        import React from 'react';
        import { motion } from 'framer-motion';
        console.log(React, motion);
      </script></body></html>`],
  ]);
  const r = validateProjectIntegrity(files);
  assert.equal(r.ok, false);
  assert.equal(r.badRuntime.find((b) => b.kind === 'npm-import') != null, true);
});

test('isReactBundleAppPlaceholder: только заголовок шаблона', () => {
  assert.equal(isReactBundleAppPlaceholder('<h1 class="x">Шаблон react-bundle</h1>'), true);
});

test('isReactBundleAppPlaceholder: бейдж + «Здесь стартует» (как в template)', () => {
  const t = 'React + Tailwind, собрано через esbuild\nЗдесь стартует ваше React-приложение.';
  assert.equal(isReactBundleAppPlaceholder(t), true);
});

test('isReactBundleAppPlaceholder: реальная игра без маркеров', () => {
  assert.equal(isReactBundleAppPlaceholder(`export default function RusLoto(){return <main>Билеты</main>}`), false);
});

test('react-bundle: незаменённый шаблон в src/App.tsx — broken', () => {
  const files = new Map([
    ['src/App.tsx', `export default function App() {
      return <>
      <h1>Шаблон react-bundle</h1>
      <p>Здесь стартует ваше React-приложение. Замените.</p>
      </>`],
  ]);
  const r = validateProjectIntegrity(files);
  assert.equal(r.ok, false);
  assert.equal(r.reactBundlePlaceholder, true);
});

test('react-bundle шаблон: import в src/App.tsx + корневой index → bundle в dist/ — ок', () => {
  const files = new Map([
    ['src/App.tsx', `import React from 'react';\nimport { motion } from 'framer-motion';\nexport default () => <div />`],
    ['index.html', `<!DOCTYPE html><html><link rel="stylesheet" href="bundle.css"><script type="module" src="bundle.js"></script></html>`],
    ['dist/bundle.js', '/* x */'],
    ['dist/bundle.css', '/* x */'],
    ['dist/index.html', '<!DOCTYPE html><html></html>'],
  ]);
  const r = validateProjectIntegrity(files);
  assert.equal(r.ok, true);
  assert.equal(r.missing.length, 0);
  assert.equal(r.badRuntime.length, 0);
});

test('truncatedHtml: index.html без </html> — broken', () => {
  const files = new Map([
    ['index.html', `<!DOCTYPE html><html><body><h1>Hi</h1>`],
  ]);
  const r = validateProjectIntegrity(files);
  assert.equal(r.ok, false);
  assert.deepEqual(r.truncatedHtml, ['index.html']);
});
