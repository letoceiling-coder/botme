import { normalizeBundleIndexHtml } from '../src/builder/esbuild-runner.js';

const cases = [
  ['full url', `<link href="https://botme.neeklo.ru/dist/bundle.css">`, 'bundle.css'],
  ['/dist root', `<link href="/dist/bundle.css">`, './bundle.css'],
  ['/dist js', `<script src="/dist/bundle.js">`, './bundle.js'],
  ['./dist', `<link href="./dist/bundle.css">`, './bundle.css'],
];
for (const [name, input, needle] of cases) {
  const out = normalizeBundleIndexHtml(input);
  const ok = out.includes(needle) && !out.includes('/dist/bundle');
  console.log(ok ? 'OK  ' : 'FAIL', name, '→', out);
}
