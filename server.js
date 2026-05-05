import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { MODELS, callWithFallback, recordUsage, readGeneratorStats, resetGeneratorStats } from './src/llm.js';
import assistantsRouter from './src/assistants/routes.js';
import publicApiRouter from './src/public-api/routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const PROJECTS_DIR = path.join(__dirname, 'projects');

await fs.mkdir(PROJECTS_DIR, { recursive: true });

// =============================================================
// Системный промпт для генерации сайтов / игр
// =============================================================
const SYSTEM_PROMPT = `Ты — senior fullstack-разработчик и продуктовый дизайнер уровня топ-студий (Apple, Stripe, Linear, Vercel). Твоя задача — собирать ПРЕМИУМ сайты, многостраничные лендинги и браузерные игры (включая React-проекты), которые выглядят как работа дорогого агентства, а не как студенческий шаблон.

============================================================
🟥 СТРОГИЙ ФОРМАТ ОТВЕТА (нарушение = провал):
============================================================

Поддерживаются ДВА формата — выбирай тот, что подходит по задаче. Никакого текста, объяснений, плана или комментариев до/после блоков. Только сами блоки.

──── ФОРМАТ A — ОДНОСТРАНИЧНЫЙ САЙТ (один файл) ────
Используй когда задача — один лендинг / одна игра / простая SPA на одну страницу.
Верни РОВНО ОДИН блок:

\`\`\`html
<!DOCTYPE html>
<html lang="ru">
...
</html>
\`\`\`

──── ФОРМАТ B — МНОГОФАЙЛОВЫЙ ПРОЕКТ ────
Используй когда: многостраничный сайт (несколько html), нужно вынести стили/скрипты в отдельные файлы, проект на React с отдельными компонентами.
Верни НЕСКОЛЬКО блоков, у каждого первая строка — \`file:путь\`:

\`\`\`file:index.html
<!DOCTYPE html>
<html>...</html>
\`\`\`

\`\`\`file:about.html
<!DOCTYPE html>
<html>...</html>
\`\`\`

\`\`\`file:assets/style.css
:root { ... }
\`\`\`

\`\`\`file:assets/app.js
console.log("hi");
\`\`\`

ЖЁСТКИЕ ПРАВИЛА для формата B:
- Главная страница ОБЯЗАТЕЛЬНО называется \`index.html\` (без неё превью не откроется).
- Пути к файлам — относительные, разделитель "/", без \`./\`, без \`../\`, без абсолютных путей и дисков.
- В html ссылки на свои файлы — относительные: \`<a href="about.html">\`, \`<link href="assets/style.css">\`, \`<script src="assets/app.js">\`.
- Запрещённые символы в путях: \`..\`, \`\\\`, \`:\`, начинающийся \`/\`. Только латиница, цифры, \`-\`, \`_\`, \`.\`, \`/\`.
- Каждый html-файл должен быть полным документом от \`<!DOCTYPE html>\` до \`</html>\` со всеми CDN-подключениями (Tailwind/AOS/lucide), потому что они ОТДЕЛЬНЫЕ страницы и каждая открывается напрямую.
- НИКАКИХ \`\`\`html, \`\`\`javascript внутри блоков — только сырой код.

============================================================
🟧 ОБЯЗАТЕЛЬНОЕ ПОДКЛЮЧЕНИЕ (точно так, без отклонений):
============================================================
В <head> ВСЕГДА:
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>     <!-- ВНИМАНИЕ: именно <script>, НЕ <link>! -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Manrope:wght@500;700;800&family=Playfair+Display:wght@600;700;800&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/animate.css/4.1.1/animate.min.css" rel="stylesheet">
  <link href="https://unpkg.com/aos@2.3.4/dist/aos.css" rel="stylesheet">
  <script src="https://unpkg.com/aos@2.3.4/dist/aos.js" defer></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js" defer></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/ScrollTrigger.min.js" defer></script>
  <script src="https://unpkg.com/lucide@latest" defer></script>

В конце <body> обязательно инициализируй: AOS.init({duration:800, once:true});  и  lucide.createIcons();

Можно дополнительно подключать (если нужно): swiperjs, three.js, p5.js, matter.js, pixi.js, phaser, anime.js, chart.js, typed.js, particles.js, splidejs — только через CDN unpkg/jsdelivr/cdnjs.

============================================================
🟨 КАРТИНКИ — ТОЛЬКО РЕАЛЬНЫЕ ФОТО (запрещены placeholder.com и via.placeholder.com):
============================================================
Используй РЕАЛЬНЫЕ фото из этих источников (тематика подбирается по контексту):

1. Unsplash (главный источник, фото высокого качества):
   https://images.unsplash.com/photo-XXXXX?w=1600&q=80&auto=format&fit=crop
   Если не знаешь конкретный photo-id, используй Unsplash Source:
   https://source.unsplash.com/1600x900/?<keywords-через-запятую>
   Например для натяжных потолков:
     https://source.unsplash.com/1600x900/?modern,interior,ceiling
     https://source.unsplash.com/1200x800/?living-room,luxury
     https://source.unsplash.com/800x800/?kitchen,modern,design

2. Picsum (если нужно нейтральное фото):
   https://picsum.photos/seed/<уникальное-слово>/1600/900

3. Аватары людей для отзывов:
   https://i.pravatar.cc/150?img=12   (img от 1 до 70)
   https://randomuser.me/api/portraits/men/32.jpg
   https://randomuser.me/api/portraits/women/44.jpg

4. Иконки — ТОЛЬКО Lucide через <i data-lucide="имя"></i> (примеры: home, phone, calendar, check, star, arrow-right, mail, map-pin, shield-check, zap, sparkles, gem). НЕ используй emoji вместо иконок.

ЗАПРЕЩЕНО: placeholder.com, via.placeholder.com, dummyimage.com, "placeholder" в alt, серые квадраты.

============================================================
🟩 ПРЕМИУМ-ДИЗАЙН (обязательный уровень качества):
============================================================
- Шрифты: основной Inter / Manrope, заголовки могут быть Playfair Display для premium-ощущения.
- Цвета: подбирай ОСМЫСЛЕННУЮ палитру под бренд, не дефолтные tailwind-цвета. Используй кастомные через tailwind.config или произвольные значения [#hex].
- Контрастные крупные заголовки (text-5xl/6xl/7xl на десктопе, font-extrabold/black, tracking-tight).
- Hero — на весь экран (min-h-screen), фоновое фото с тёмным overlay (gradient-to-br from-black/70 to-black/40), большой заголовок, кнопки с явными hover (scale-105, shadow-2xl, glow).
- Секции с большими отступами (py-24/32), max-w-7xl mx-auto px-6.
- Карточки: rounded-2xl/3xl, мягкие тени (shadow-lg → hover:shadow-2xl), тонкие бордеры (border border-white/10 на тёмной теме), backdrop-blur при необходимости (glassmorphism).
- Hover-эффекты ОБЯЗАТЕЛЬНО: transform scale-105/110, изменение цвета, появление подложки, плавные transition-all duration-300/500 ease-out.
- Анимации появления: используй data-aos="fade-up" / "zoom-in" / "fade-right" с разными data-aos-delay на карточках и заголовках.
- Микроинтеракции: glow на кнопках, плавный underline у ссылок, parallax/float на иконках, плавный smooth scroll.
- Адаптив mobile-first: проверь, что на телефоне всё читается, меню превращается в бургер, grid превращается в одну колонку.
- Тёмная тема по умолчанию (если контекст не требует обратного), но качественная: не #000, а оттенки типа #0a0a0f, #11121a, с градиентами и акцентным цветом (золотой/сиреневый/циан/изумрудный).
- Декор: размытые цветные пятна на фоне (blob), сетка/dots на фоне через SVG, градиенты в заголовках через bg-clip-text text-transparent bg-gradient-to-r.

============================================================
🟦 ДЛЯ ИГР (canvas/DOM):
============================================================
- Полноценный игровой цикл (requestAnimationFrame), плавный gameplay.
- Управление мышью + клавиатурой + тач (для мобильного).
- Счёт, рекорд (localStorage), главное меню, экран Game Over с рестартом.
- Звуки можно сгенерировать через WebAudio (AudioContext + oscillator) — без внешних mp3.
- Premium UI вокруг canvas (та же дизайн-система).

============================================================
⚛ REACT / JSX БЕЗ СБОРЩИКОВ (когда уместен):
============================================================
React можно и нужно использовать для интерактивных приложений и игр со сложным состоянием. Никаких npm/webpack/vite — всё через CDN + Babel Standalone (он компилирует JSX прямо в браузере). Используй формат A (один файл) или формат B (компоненты в отдельных файлах).

Подключение в <head>:
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>

В <body>:
  <div id="root"></div>
  <script type="text/babel" data-presets="env,react">
    const { useState, useEffect, useRef } = React;
    function App() {
      const [n, setN] = useState(0);
      return <button onClick={() => setN(n+1)} className="px-6 py-3 rounded-xl bg-violet-600 text-white">Нажато {n}</button>;
    }
    ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
  </script>

Для многофайлового React-проекта:
- Главный \`index.html\` подключает компоненты как <script type="text/babel" src="components/App.jsx"></script>.
- Файлы компонентов — расширение .jsx, без import/export (всё в глобальной области), либо складывай всё в один большой \`<script type="text/babel">\` в index.html.
- Для иконок — lucide-react не работает без сборщика, используй обычный <i data-lucide="..."> внутри JSX через ref + lucide.createIcons() в useEffect.
- Для анимаций — framer-motion НЕ работает через CDN UMD. Используй CSS-анимации, animate.css, либо react-spring через esm.sh (если очень надо). Проще — Tailwind-анимации.
- Для 3D в React-играх — three.js напрямую через ref на <canvas>, без react-three-fiber.

Когда выбирать React:
- Игра с большим состоянием (счёт, инвентарь, уровни, экраны меню/гейм/победа).
- Приложения типа калькулятора, todo, конструктора, редактора.
- НЕ нужен для простого лендинга — там React будет лишним overhead-ом, лучше чистый HTML+Tailwind.

============================================================
🟪 СТРУКТУРА И КАЧЕСТВО КОДА:
============================================================
- Все стили либо tailwind-классами, либо в одном <style> в <head>. Никаких внешних css-файлов.
- Весь JS внутри <script> в конце <body>. Без модулей, без import.
- Никаких относительных путей к локальным файлам — только https-CDN.
- Никаких TODO, "..." или "сюда вставьте" — всё реализовано до рабочего состояния.
- Если пользователь сказал "добавь/измени/убери X" — модифицируй ПРЕДЫДУЩИЙ HTML из контекста, сохраняя ВСЁ остальное. Возвращай ВЕСЬ файл целиком.
- Длинный качественный лендинг лучше короткой заготовки. Не ленись — наполняй текстом, заголовками, фактами, цифрами.

============================================================
🟥 ПРОВЕРОЧНЫЙ ЧЕКЛИСТ перед отправкой ответа:
============================================================
[ ] Tailwind подключён через <script src="https://cdn.tailwindcss.com"></script>  (не <link>!)
[ ] Подключены Google Fonts, animate.css, AOS, lucide (или React+Babel если проект на React)
[ ] AOS.init() и lucide.createIcons() вызваны
[ ] Ни одного via.placeholder.com / placeholder.com — все фото из unsplash/picsum/pravatar
[ ] Все секции имеют крупные заголовки, отступы, hover-эффекты
[ ] data-aos на карточках и блоках
[ ] Адаптив проверен (sm:/md:/lg:/xl: префиксы)
[ ] Hero на min-h-screen с фоновым фото и overlay
[ ] Если многостраничный — есть index.html и навигация ссылками между страницами; каждая страница — полный HTML5 со своими CDN
[ ] Если React — есть <div id="root">, <script type="text/babel" data-presets="env,react">, ReactDOM.createRoot().render()
[ ] Никаких локальных путей, только https-CDN; никаких ../ и абсолютных путей в file:
[ ] Ответ — либо один блок \`\`\`html, либо несколько блоков \`\`\`file:путь, без текста вокруг`;

// =============================================================
// Системный промпт для УЛУЧШЕНИЯ промпта пользователя
// =============================================================
const PROMPT_IMPROVER_SYSTEM = `Ты — senior prompt engineer и продуктовый дизайнер. Тебе дают сырую идею пользователя для генерации сайта или браузерной игры. Твоя задача — превратить её в детальный, насыщенный, продающий промпт для другой AI-модели, которая будет генерировать HTML.

ПРАВИЛА:
1. Верни ТОЛЬКО улучшенный промпт на русском языке. Без вступлений, без объяснений, без "Вот улучшенный вариант:".
2. Не оборачивай в markdown / кодовые блоки.
3. Сохрани оригинальную идею и тематику пользователя — не подменяй её.
4. Добавь конкретику, которой не хватает: целевая аудитория, тон, атмосфера, цветовая палитра, шрифты, ключевые блоки сайта (Hero / About / Features / Gallery / Pricing / CTA / Footer и т.п.), какие фото показать, какие анимации использовать.
5. Структурируй: разделы с короткими маркированными списками внутри.
6. Указывай детали дизайна: тёмная/светлая тема, акцентный цвет, типографика, hover-эффекты, AOS-анимации, glassmorphism / градиенты / blob, адаптив.
7. Для лендингов — обязательно: триггеры доверия, CTA, форма заявки, отзывы.
8. Для игр — обязательно: управление, счёт, рекорд (localStorage), Game Over, премиум-обёртка вокруг canvas.
9. Длина — от 600 до 1500 символов. Достаточно подробно, но без воды.
10. Пиши на профессиональном русском, как ТЗ для дизайн-студии.`;

function emptyAgg() { return { calls: 0, input: 0, output: 0, total: 0 }; }

// =============================================================
// Извлечь файлы проекта из ответа модели.
// Поддерживает 2 формата:
//   A) один файл — один блок ```html ... ``` или просто <!DOCTYPE html>...
//   B) много файлов — блоки ```file:путь\n...\n```
// Возвращает Map<relativePath, content>.
// =============================================================

// Безопасный относительный путь: только латиница/цифры/-_/. , без .. и абсолютных путей
function isSafeRelPath(p) {
  if (!p || typeof p !== 'string') return false;
  if (p.length > 200) return false;
  if (/^[\\/]/.test(p)) return false;          // абсолютные пути
  if (/^[a-zA-Z]:/.test(p)) return false;      // диски Windows
  if (/\\/.test(p)) return false;              // только прямые слэши
  if (/(^|\/)\.\.(\/|$)/.test(p)) return false; // никаких ..
  if (/[<>:"|?*\x00-\x1f]/.test(p)) return false;
  if (!/^[\w./\-]+$/i.test(p)) return false;
  return true;
}

function extractFiles(text) {
  if (!text) return null;
  const s = String(text);
  const files = new Map();

  // 1) Многофайловый формат: ```file:path  ...  ```
  const fileFenceRe = /```file:([^\n`]+)\n([\s\S]*?)```/g;
  let m;
  while ((m = fileFenceRe.exec(s)) !== null) {
    const rawPath = m[1].trim();
    let content = m[2];
    // Уберём первые/последние пустые строки
    content = content.replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (!isSafeRelPath(rawPath)) continue;
    files.set(rawPath.replace(/\\/g, '/'), content);
  }

  if (files.size > 0) {
    if (!files.has('index.html')) {
      // Если модель забыла index.html, но есть какой-то html — назначим его главным
      const firstHtml = [...files.keys()].find((k) => k.endsWith('.html'));
      if (firstHtml) {
        files.set('index.html', files.get(firstHtml));
      } else {
        return null;
      }
    }
    return files;
  }

  // 2) Однофайловый формат: ищем <!DOCTYPE html> ... </html>
  const html = extractSingleHtml(s);
  if (html) {
    files.set('index.html', html);
    return files;
  }
  return null;
}

function extractSingleHtml(s) {
  const docStart = s.search(/<!doctype\s+html/i);
  if (docStart !== -1) {
    const tail = s.slice(docStart);
    const endMatch = tail.match(/<\/html\s*>/i);
    if (endMatch) return tail.slice(0, endMatch.index + endMatch[0].length).trim();
    return tail.trim();
  }
  const htmlStart = s.search(/<html[\s>]/i);
  if (htmlStart !== -1) {
    const tail = s.slice(htmlStart);
    const endMatch = tail.match(/<\/html\s*>/i);
    if (endMatch) {
      return ('<!DOCTYPE html>\n' + tail.slice(0, endMatch.index + endMatch[0].length)).trim();
    }
  }
  const fence = s.match(/```html\s*([\s\S]*?)```/i);
  if (fence) {
    const inner = fence[1].trim();
    if (/<!doctype|<html|<body|<div/i.test(inner)) return inner;
  }
  return null;
}

// =============================================================
// Работа с проектами на диске.
// Структура проекта:
//   projects/<id>/meta.json        — метаданные, история чата, usage
//   projects/<id>/index.html       — главная страница
//   projects/<id>/about.html       — другие страницы (опционально)
//   projects/<id>/assets/...       — стили, скрипты, компоненты, ассеты
// =============================================================

const RESERVED_FILES = new Set(['meta.json']);

async function listProjectFiles(dir) {
  // Рекурсивный обход всех файлов проекта (кроме meta.json)
  const result = [];
  async function walk(sub) {
    const abs = path.join(dir, sub);
    let entries;
    try { entries = await fs.readdir(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (RESERVED_FILES.has(rel)) continue;
      if (e.isDirectory()) await walk(rel);
      else result.push(rel);
    }
  }
  await walk('');
  return result.sort();
}

async function readProject(id, { includeFileContents = true } = {}) {
  const dir = path.join(PROJECTS_DIR, id);
  let meta;
  try {
    meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
  const fileList = await listProjectFiles(dir);
  const files = {};
  if (includeFileContents) {
    for (const rel of fileList) {
      try {
        files[rel] = await fs.readFile(path.join(dir, rel), 'utf8');
      } catch { /* бинарники пропускаем */ }
    }
  }
  return {
    ...meta,
    files,                    // { 'index.html': '...', 'about.html': '...', ... }
    fileList,                 // ['about.html', 'assets/style.css', 'index.html', ...]
    hasIndex: fileList.includes('index.html'),
    // Обратная совместимость для UI/чата (используется поле .html)
    html: files['index.html'] || '',
  };
}

async function writeProject(project) {
  const dir = path.join(PROJECTS_DIR, project.id);
  await fs.mkdir(dir, { recursive: true });

  // Если указан project.files — это полный набор файлов нового состояния.
  // Безопасно удаляем все старые файлы (кроме meta.json) и пишем новые.
  if (project.files && typeof project.files === 'object') {
    const oldFiles = await listProjectFiles(dir);
    for (const rel of oldFiles) {
      // Дополнительная защита от выхода за пределы dir
      const abs = path.resolve(dir, rel);
      if (!abs.startsWith(path.resolve(dir) + path.sep)) continue;
      await fs.rm(abs, { force: true });
    }
    // Удалим пустые подпапки
    await pruneEmptyDirs(dir);

    for (const [rel, content] of Object.entries(project.files)) {
      if (!isSafeRelPath(rel)) continue;
      const abs = path.resolve(dir, rel);
      if (!abs.startsWith(path.resolve(dir) + path.sep)) continue;
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, String(content ?? ''), 'utf8');
    }
  }

  const meta = {
    id: project.id,
    title: project.title,
    createdAt: project.createdAt,
    updatedAt: new Date().toISOString(),
    model: project.model,
    messages: project.messages,
    usage: project.usage || emptyAgg(),
  };
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

async function pruneEmptyDirs(root) {
  async function walk(abs) {
    let entries;
    try { entries = await fs.readdir(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = path.join(abs, e.name);
      await walk(sub);
      try {
        const left = await fs.readdir(sub);
        if (!left.length) await fs.rmdir(sub);
      } catch {}
    }
  }
  await walk(root);
}

async function listProjects() {
  const dirs = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const result = [];
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    const p = await readProject(d.name, { includeFileContents: false });
    if (p) result.push({
      id: p.id, title: p.title, updatedAt: p.updatedAt, model: p.model,
      usage: p.usage || emptyAgg(),
      fileCount: p.fileList.length,
    });
  }
  result.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return result;
}

// =============================================================
// HTTP сервер
// =============================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Превью сгенерированного сайта (главный index.html + любые подфайлы)
app.use('/preview/:id', async (req, res, next) => {
  const id = req.params.id;
  if (!/^[\w-]+$/.test(id)) return res.status(400).send('bad id');
  const dir = path.resolve(PROJECTS_DIR, id);
  if (!dir.startsWith(path.resolve(PROJECTS_DIR) + path.sep)) {
    return res.status(400).send('bad id');
  }
  try {
    await fs.access(path.join(dir, 'index.html'));
  } catch {
    return res.status(404).send('Проект не найден');
  }
  // Блокируем доступ к служебным файлам (meta.json и т.п.)
  const reqPath = decodeURIComponent(req.path || '/').replace(/^\/+/, '');
  if (RESERVED_FILES.has(reqPath) || reqPath.startsWith('_')) {
    return res.status(404).send('Not found');
  }
  express.static(dir, { index: 'index.html' })(req, res, next);
});

app.get('/api/models', (_req, res) => {
  res.json(MODELS.map((m) => ({ id: m.id, label: m.label, provider: m.provider })));
});

app.get('/api/projects', async (_req, res) => {
  res.json(await listProjects());
});

app.get('/api/projects/:id', async (req, res) => {
  const p = await readProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  // Не отдаём огромный files наружу в общем виде, только сводку. Контент — в превью.
  res.json({
    id: p.id, title: p.title, createdAt: p.createdAt, updatedAt: p.updatedAt,
    model: p.model, messages: p.messages, usage: p.usage,
    files: p.fileList,
    hasHtml: p.hasIndex,
  });
});

app.delete('/api/projects/:id', async (req, res) => {
  const dir = path.join(PROJECTS_DIR, req.params.id);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Сериализует все файлы проекта в текстовый блок для контекста модели.
// Если суммарно больше лимита — оставляем только index.html и список остальных.
function projectToContextBlock(project, maxChars = 90_000) {
  const entries = Object.entries(project.files || {});
  if (!entries.length) return '';
  const total = entries.reduce((s, [, c]) => s + (c?.length || 0), 0);
  let parts = ['Текущее состояние проекта (его нужно модифицировать по новым инструкциям, не ломая работающий функционал). Возвращай ВЕСЬ обновлённый набор файлов целиком:\n'];
  if (total <= maxChars) {
    for (const [rel, content] of entries) {
      parts.push('```file:' + rel + '\n' + (content || '') + '\n```');
    }
  } else {
    // Слишком много контента — отдаём только index.html + список остальных
    const idx = project.files['index.html'] || '';
    parts.push('```file:index.html\n' + idx + '\n```');
    parts.push('Другие файлы проекта (контент опущен из-за объёма, но они существуют — учитывай):');
    for (const [rel] of entries) {
      if (rel !== 'index.html') parts.push('• ' + rel);
    }
  }
  return parts.join('\n');
}

app.post('/api/generate', async (req, res) => {
  try {
    const { projectId, prompt, model } = req.body || {};
    if (!prompt || !model) {
      return res.status(400).json({ error: 'prompt и model обязательны' });
    }

    let project = projectId ? await readProject(projectId) : null;
    if (!project) {
      project = {
        id: randomUUID(),
        title: prompt.slice(0, 60),
        createdAt: new Date().toISOString(),
        model,
        messages: [],
        files: {},
        fileList: [],
        usage: emptyAgg(),
      };
    }
    project.usage ||= emptyAgg();
    project.files ||= {};

    project.messages.push({ role: 'user', content: prompt, ts: Date.now() });
    project.model = model;

    const chatMessages = [];
    const ctx = projectToContextBlock(project);
    if (ctx) {
      chatMessages.push({ role: 'user', content: ctx });
      chatMessages.push({
        role: 'assistant',
        content: 'Понял, буду модифицировать проект и возвращать ВЕСЬ обновлённый набор файлов целиком в нужном формате.',
      });
    }
    const tail = project.messages.slice(-10);
    for (const m of tail) {
      chatMessages.push({ role: m.role, content: m.content });
    }

    const result = await callWithFallback({
      modelId: model,
      messages: chatMessages,
      task: 'generate',
      projectId: project.id,
    });
    const raw = result.text;
    const files = extractFiles(raw);

    project.usage.calls += 1;
    project.usage.input += result.usage.input;
    project.usage.output += result.usage.output;
    project.usage.total += result.usage.total;

    let assistantText;
    if (files && files.size > 0) {
      project.files = Object.fromEntries(files);
      project.fileList = [...files.keys()].sort();
      const indexHtml = project.files['index.html'] || '';
      const truncated = indexHtml && !/<\/html\s*>/i.test(indexHtml);
      const fb = result.fallbackFrom
        ? `\n\nℹ Модель ${result.fallbackFrom} недоступна, использовали ${result.modelUsed}.`
        : '';
      const usageNote = `\n\n📊 Токенов: ${result.usage.total.toLocaleString('ru-RU')} (in: ${result.usage.input}, out: ${result.usage.output})`;
      const listNote = files.size === 1
        ? `Готово. Один файл: index.html (${indexHtml.length.toLocaleString('ru-RU')} символов).`
        : `Готово. ${files.size} файлов проекта:\n${[...files.keys()].sort().map((f) => `  • ${f} (${(project.files[f] || '').length.toLocaleString('ru-RU')} симв.)`).join('\n')}`;
      assistantText = listNote + usageNote + fb +
        (truncated
          ? '\n\n⚠ index.html обрезался по лимиту токенов (нет </html>). Попроси «закончи код» или сократи объём.'
          : '');
    } else {
      assistantText = raw || 'Модель не вернула файлы. Попробуй переформулировать запрос или сменить модель.';
    }

    project.messages.push({
      role: 'assistant',
      content: assistantText,
      ts: Date.now(),
      usage: result.usage,
      modelUsed: result.modelUsed,
    });
    await writeProject(project);

    res.json({
      id: project.id,
      title: project.title,
      model: project.model,
      modelUsed: result.modelUsed,
      fallbackFrom: result.fallbackFrom,
      assistant: assistantText,
      hasHtml: !!(project.files && project.files['index.html']),
      previewUrl: `/preview/${project.id}/`,
      files: project.fileList || [],
      usage: result.usage,
      projectUsage: project.usage,
    });
  } catch (e) {
    console.error('[generate]', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// =============================================================
// Улучшение промпта пользователя через быструю модель
// =============================================================
app.post('/api/improve-prompt', async (req, res) => {
  try {
    const { prompt, model } = req.body || {};
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt обязателен' });
    }
    // По умолчанию для улучшения — Claude Haiku 4.5 (быстро/дёшево/умно).
    // С фоллбеком на остальные.
    const primary = model || 'claude:claude-haiku-4-5-20251001';
    const result = await callWithFallback({
      modelId: primary,
      messages: [
        { role: 'system', content: PROMPT_IMPROVER_SYSTEM },
        { role: 'user', content: `Сырая идея пользователя:\n\n${prompt}\n\nПерепиши её в развёрнутый детальный промпт.` },
      ],
      task: 'improve_prompt',
      projectId: null,
      maxTokens: 4096,
    });
    res.json({
      improvedPrompt: result.text.trim(),
      modelUsed: result.modelUsed,
      fallbackFrom: result.fallbackFrom,
      usage: result.usage,
    });
  } catch (e) {
    console.error('[improve-prompt]', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// =============================================================
// Статистика (генератор сайтов)
// =============================================================
app.get('/api/stats', async (_req, res) => {
  const stats = await readGeneratorStats();
  const labels = Object.fromEntries(MODELS.map((m) => [m.id, m.label]));
  res.json({ ...stats, modelLabels: labels });
});

app.delete('/api/stats', async (_req, res) => {
  await resetGeneratorStats();
  res.json({ ok: true });
});

// =============================================================
// Модуль AI-ассистентов (RAG, база знаний, чат, статистика, токены)
// =============================================================
app.use('/api/assistants', assistantsRouter);

// =============================================================
// Публичный API под bearer-токенами (для виджета и сторонних клиентов)
// =============================================================
app.use('/api/v1', publicApiRouter);

app.listen(PORT, () => {
  console.log(`\n🚀 AI Site Builder запущен:  http://localhost:${PORT}`);
  console.log(`🤖 Ассистенты:                http://localhost:${PORT}/assistant/`);
  console.log(`🔑 Публичный API:             http://localhost:${PORT}/api/v1/`);
  console.log(`📁 Проекты сохраняются в:    ${PROJECTS_DIR}\n`);
});
