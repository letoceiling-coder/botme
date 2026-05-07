// Переменные окружения подхватывает server-entry.mjs (PM2 / npm start).
// Прямой запуск: node server-entry.mjs
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  extractFilesFromAssistantText as extractFiles,
  isSafeRelPath,
} from './src/agent/extract-project-from-text.js';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { getModelsMerged, callWithFallback, recordUsage, readGeneratorStats, resetGeneratorStats, getProviderStatus, buildToolsFallbackChain, resolveModelConfig } from './src/llm.js';
import { validateProjectIntegrity, describeIntegrity } from './src/project-validator.js';
import { smokeTestHtml } from './src/runtime-smoke.js';
import { buildContextBlockForPrompt, isContext7Enabled } from './src/context7.js';
import { EventBus } from './src/agent/event-bus.js';
import { runOrchestrator, detectPatchMode } from './src/agent/orchestrator.js';
import { runRealSmoke, isPlaywrightDisabled } from './src/smoke/playwright-runner.js';
import { cleanupOldCacheDirs, normalizeBundleIndexHtml } from './src/builder/esbuild-runner.js';
import { createMediaRouter, mountMediaStatic } from './src/media/routes.js';
import assistantsRouter from './src/assistants/routes.js';
import publicApiRouter from './src/public-api/routes.js';
import agentChatRouter from './src/agent-chat/routes.js';
import session from 'express-session';
import authRouter from './src/auth/routes.js';
import { appAuthGate } from './src/auth/middleware.js';
import { seedDefaultAppUser } from './src/auth/seed-users.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const PROJECTS_DIR = path.join(__dirname, 'projects');

const SESSION_SECRET = process.env.SESSION_SECRET || 'botme-dev-insecure-change-me';

await fs.mkdir(PROJECTS_DIR, { recursive: true });

// =============================================================
// Системный промпт для генерации сайтов / игр
// =============================================================
const SYSTEM_PROMPT = `Ты — senior fullstack-разработчик и продуктовый дизайнер уровня топ-студий (Apple, Stripe, Linear, Vercel). Твоя задача — собирать ПРЕМИУМ сайты, многостраничные лендинги и браузерные игры (включая React-проекты), которые выглядят как работа дорогого агентства, а не как студенческий шаблон.

🚨 ПЕРВОЕ И ГЛАВНОЕ ПРАВИЛО (нарушение = автоматический провал):
Твой ответ должен начинаться РОВНО с тройных бэктиков (\`\`\`html или \`\`\`file:путь). Без вступительной фразы, без "I'll create…", без заголовков "# Project Structure", без описания архитектуры, без markdown-документации. Сразу — открывающий fence-блок. Точка.

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

============================================================
🟥 RUNTIME-ЧЕКЛИСТ (типовые ошибки, которые ломают сборку — ИЗБЕГАЙ):
============================================================
1. Tailwind CSS — ТОЛЬКО \`https://cdn.tailwindcss.com\` (это runtime-JIT). НИКОГДА:
   ❌ \`<link href="https://cdn.jsdelivr.net/npm/tailwindcss@3.x/dist/tailwind.min.css">\` — этот путь в Tailwind v3 не существует, отдаст 404.
   ❌ \`<link href="https://unpkg.com/tailwindcss@x/dist/...">\` — то же самое.
   ❌ Никаких \`@apply\` в обычном \`<style>\` — \`cdn.tailwindcss.com\` НЕ процессит \`@apply\` в инлайне. Используй обычные классы Tailwind в HTML или сырые CSS-свойства в \`<style>\`.

2. React/JSX через CDN — если есть \`<script type="text/babel">\`, в \`<head>\` ОБЯЗАТЕЛЬНО все три строки:
   <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
   <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
   <script src="https://unpkg.com/@babel/standalone@7.24.7/babel.min.js"></script>
   Без них React/ReactDOM в \`text/babel\` блоках = undefined → пустой экран.
   Используй \`ReactDOM.createRoot(document.getElementById('root')).render(<App/>);\` (НЕ deprecated \`ReactDOM.render(...)\`).

3. lucide — pinned-версия ОБЯЗАТЕЛЬНА. \`<script src="https://unpkg.com/lucide@latest"></script>\` или \`@0.460.0\`.
   ❌ \`https://unpkg.com/lucide/dist/lucide.min.js\` (без версии) — резолвится в legacy lucide@1.14.0 с другим API, иконок не будет.

4. Любые \`unpkg.com/<lib>\` без версии — БРАК. Всегда ставь \`@latest\` или конкретный pinned-major (например \`aos@2.3.4\`, \`gsap@3.12.5\`).

5. JSX без Babel — если в HTML есть \`<\` внутри \`<script>\` без \`type="text/babel"\`, это синтаксическая ошибка. Либо \`type="text/babel" data-presets="env,react"\`, либо переписать на чистый React.createElement.

6. Шрифты Google — ТОЛЬКО через \`fonts.googleapis.com\` (https). \`<link href="fonts.googleapis.com">\` без https — БРАК.

ПРОВЕРКА перед отправкой: мысленно открой свой HTML в браузере без сборщика. Если хоть один из шести пунктов нарушен — переделай.

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
🛑 СТРОЖАЙШИЙ ЗАПРЕТ: НИКАКИХ СБОРЩИКОВ, СКЕЛЕТОВ, NPM-ИМПОРТОВ
============================================================
Превью открывает СТАТИЧНЫЙ HTML напрямую, БЕЗ vite/webpack/next/parcel/CRA. Любой ответ, который опирается на сборщик или npm — БРАК и откроется ПУСТОЙ страницей.

❌ ЗАПРЕЩЕНО ВЫВОДИТЬ ТАКОЕ (моментальный провал):
- markdown-вступление вида «# Project / I'll create… / ## Project Structure / ## Implementation» с деревом каталогов и списком файлов \`src/components/Header.jsx\`, \`pages/HomePage.jsx\`, \`App.jsx\`, \`index.js\` — это «архитектурный отчёт», а не код. Превью так не запустится.
- блоки \`\`\`jsx, \`\`\`tsx, \`\`\`javascript, \`\`\`typescript, \`\`\`css БЕЗ префикса \`file:путь\` сразу после трёх бэктиков. Любой код-блок без префикса \`file:\` — БРАК (только формат A с одним \`\`\`html допустим как исключение).
- любые \`import ... from "react"\`, \`from "react-dom"\`, \`from "react-router-dom"\`, \`from "framer-motion"\`, \`from "lucide-react"\`, \`from "next/..."\`, \`from "@/..."\` — это npm-импорты, они НЕ работают без сборки.
- 🛑 framer-motion НИ В КАКОМ ВИДЕ. UMD-сборки framer-motion на CDN нет — \`window.FramerMotion\` всегда undefined, и Babel падает с \`Cannot destructure property 'motion' of 'window.FramerMotion' as it is undefined\`. Это самая частая причина пустого превью. Все «крутые» анимации делай на CSS transitions / keyframes / AOS / animate.css / GSAP (у GSAP есть рабочий UMD на cdnjs).
- 🛑 react-router-dom через CDN тоже НЕ работает. Маршрутизацию делай через \`window.location.hash\` и условный рендер, или просто прокручивай к \`#section\`.
- 🛑 lucide-react не использовать. Используй обычный lucide: \`<script src="https://unpkg.com/lucide@latest"></script>\` + \`lucide.createIcons()\` после рендера.
- \`module.exports = { ... }\`, \`export default ...\`, \`export const ...\` в .js/.jsx/.tsx файлах — это ESM/CommonJS модули, без сборщика они не запустятся.
- \`<script type="module" src="/src/main.tsx"></script>\`, \`/src/main.jsx\`, \`/src/index.tsx\`, \`/main.tsx\`, \`/vite.svg\`, \`<link rel="stylesheet" href="/src/index.css">\`.
- scaffold-файлы (\`vite.config.*\`, \`package.json\`, \`tsconfig\`, \`next.config\`, \`tailwind.config.js\` отдельным файлом).
- ссылки на локальные \`*.tsx\`, \`*.jsx\`, \`*.ts\`, \`*.module.css\`, которых нет в твоём ответе как полноценных \`\`\`file: блоков.

✅ ВМЕСТО ЭТОГО:
- По умолчанию — формат A: ОДИН \`index.html\` со всем содержимым, Tailwind/AOS/lucide через CDN.
- Если нужен React — встрой ВСЁ в один \`<script type="text/babel" data-presets="env,react">\` ВНУТРИ \`index.html\`. Хук \`React.useState\`, \`React.useEffect\`. Никаких \`import\`. Анимации — CSS / AOS / animate.css / Tailwind transitions; маршрутизация — обычные \`<a href="#hash">\` или условный рендер по \`window.location.pathname\`. \`framer-motion\`, \`react-router-dom\`, \`lucide-react\` в формате CDN+Babel НЕ работают — НЕ используй их.
- Иконки — \`<i data-lucide="..."></i>\` через CDN \`https://unpkg.com/lucide@latest\` + \`lucide.createIcons()\`. БЕЗ \`lucide-react\`.
- Tailwind-конфиг (если нужен) — INLINE в \`<head>\` через \`tailwind.config = { ... }\` ПОСЛЕ \`<script src="https://cdn.tailwindcss.com"></script>\`. Никакого отдельного \`tailwind.config.js\` файла.
- favicon — либо вообще опусти, либо data-URL: \`<link rel="icon" href="data:image/svg+xml;utf8,..."/>\`.

ПРОВЕРЬ свой ответ перед отправкой:
1) Первый символ ответа — \`\`\`. Не «I», не «#», не пустая строка.
2) Открой мысленно \`index.html\` в браузере КАК ЕСТЬ, без \`npm install\`, без сборки. Должен быть полностью рабочий сайт.
3) Если есть хоть один \`import\` из \`react\`/\`framer-motion\`/\`react-router-dom\`/любых npm-пакетов — БРАК. Перепиши с CDN+Babel.
4) Если есть хоть одна ссылка \`src=\` / \`href=\` на локальный файл, которого ты НЕ положил \`\`\`file: блоком — БРАК. Перепиши.

============================================================
🟪 СТРУКТУРА И КАЧЕСТВО КОДА:
============================================================
- Все стили либо tailwind-классами, либо в одном <style> в <head>. Никаких внешних css-файлов.
- Весь JS внутри <script> в конце <body>. Без модулей, без import.
- Никаких относительных путей к локальным файлам — только https-CDN.
- Никаких TODO, "..." или "сюда вставьте" — всё реализовано до рабочего состояния.
- Если пользователь сказал "добавь/измени/убери X" — модифицируй ПРЕДЫДУЩИЙ HTML из контекста, сохраняя ВСЁ остальное. Возвращай ВЕСЬ файл целиком.
- Длинный качественный лендинг лучше короткой заготовки. Не ленись — наполняй текстом, заголовками, фактами, цифрами.

⏱ КОНТРОЛЬ ОБЪЁМА (важно!):
- Лимит на ответ — около 32k токенов (≈110-130 КБ HTML). Если чувствуешь, что приближаешься к лимиту — упрости остаток (меньше декоративного JS, более компактные секции), но ОБЯЗАТЕЛЬНО доведи код до закрывающего </html>.
- Лучше отдать чуть менее наполненный, но ПОЛНЫЙ index.html, чем огромный обрезанный. Обрезанный HTML — БРАК, превью не запустится.
- Не дублируй большие куски HTML/CSS — выноси повторяющиеся стили в один <style>, повторяющиеся карточки в массив + map.

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

/**
 * Из ответа модели на continuation вытащить «чистое» продолжение.
 * Модели любят: (а) обернуть продолжение в ```html ... ```, (б) повторить хвост
 * предыдущего HTML (overlap), (в) начать снова с <!doctype html>.
 *
 * lastChars — последние ~1500 символов уже накопленного HTML; используем для
 * детекции overlap'а, чтобы не задвоить.
 */
function extractContinuation(text, lastChars) {
  if (!text) return '';
  let s = String(text);
  // Срежем единственный fence ```html ... ``` если он есть.
  const fenceMatch = s.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenceMatch) s = fenceMatch[1];
  s = s.replace(/^[\s\u00a0]+/, '');
  // Если модель начала заново — берём только хвост после нашего lastChars.
  if (lastChars) {
    const tail = lastChars.slice(-200);
    const idx = s.indexOf(tail);
    if (idx !== -1) s = s.slice(idx + tail.length);
    else {
      // Попытаемся срезать максимально длинный общий префикс с lastChars (overlap).
      const overlap = longestSuffixPrefixOverlap(lastChars, s);
      if (overlap > 50) s = s.slice(overlap);
    }
  }
  // Если модель повторно начала с <!doctype — это плохо: пометим как "не продолжение"
  if (/^\s*<!doctype/i.test(s)) return '';
  return s;
}

function longestSuffixPrefixOverlap(a, b) {
  const max = Math.min(a.length, b.length, 1500);
  for (let n = max; n > 50; n--) {
    if (a.slice(-n) === b.slice(0, n)) return n;
  }
  return 0;
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

  let prevMeta = {};
  try {
    prevMeta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
  } catch { /* первый сохранённый проект */ }
  const meta = {
    ...(typeof prevMeta.kind === 'string' ? { kind: prevMeta.kind } : {}),
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
app.set('trust proxy', 1);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '20mb' }));

app.use(session({
  name: 'botme.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  },
}));

seedDefaultAppUser();

app.use('/api/auth', authRouter);

app.use(appAuthGate);

app.use(express.static(path.join(__dirname, 'public')));

// Человекочитаемый алиас: /projects/:id/... → 302 на /preview/:id/...
// (иначе браузер даёт Cannot GET — превью historically живёт только под /preview)
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const raw = req.originalUrl.split('?')[0];
  const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  if (!raw.startsWith('/projects/')) return next();
  const sub = raw.slice('/projects/'.length).replace(/^\/+/, '');
  const segments = sub.split('/').filter(Boolean);
  const id = segments[0];
  if (!id || !/^[\w-]+$/.test(id)) return next();
  const tail = segments.length > 1 ? `/${segments.slice(1).join('/')}` : '/';
  res.redirect(302, `/preview/${id}${tail}${q}`);
});

// Превью сгенерированного сайта (главный index.html + любые подфайлы)
app.use('/preview/:id', async (req, res, next) => {
  const id = req.params.id;
  if (!/^[\w-]+$/.test(id)) return res.status(400).send('bad id');
  const dir = path.resolve(PROJECTS_DIR, id);
  if (!dir.startsWith(path.resolve(PROJECTS_DIR) + path.sep)) {
    return res.status(400).send('bad id');
  }

  // Если проект — react-bundle (есть meta.kind="react-bundle" и собранный dist/),
  // превью отдаётся из dist/. Иначе — из корня проекта.
  let serveDir = dir;
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
    if (meta?.kind === 'react-bundle') {
      const distDir = path.join(dir, 'dist');
      try {
        await fs.access(path.join(distDir, 'index.html'));
        serveDir = distDir;
      } catch {
        // dist ещё не собран — отдадим понятный месседж
        return res.status(503).send(
          '<html><body style="font:14px system-ui;padding:32px;color:#444">' +
          '<h2>react-bundle ещё не собран</h2>' +
          '<p>Запусти rebuild_bundle (или подожди завершения генерации).</p>' +
          '</body></html>',
        );
      }
    }
  } catch { /* нет meta.json — обычный static-проект */ }

  // meta.kind мог потеряться из-за старой логики writeProject — восстанавливаем корень отдачи
  if (serveDir === dir) {
    const distHtmlPath = path.join(dir, 'dist', 'index.html');
    const distJsPath = path.join(dir, 'dist', 'bundle.js');
    const mainTsx = path.join(dir, 'src', 'main.tsx');
    try {
      await fs.access(mainTsx);
      await fs.access(distJsPath);
      const dh = await fs.readFile(distHtmlPath, 'utf8');
      if (/type\s*=\s*(["'])module\1/i.test(dh) && /\bbundle\.js\b/.test(dh)) {
        serveDir = path.join(dir, 'dist');
      }
    } catch { /* не react-bundle сборка */ }
  }

  try {
    await fs.access(path.join(serveDir, 'index.html'));
  } catch {
    return res.status(404).send('Проект не найден');
  }

  // Нормализуем суффикс URL после `/preview/:id`
  const qp = req.originalUrl.split('?')[0];
  const pref = `/preview/${id}`;
  if (!qp.startsWith(pref)) {
    return res.status(404).send('Not found');
  }
  let suffix = qp.slice(pref.length);
  if (suffix === '' || suffix === '/') suffix = '/index.html';
  const reqPathRel = suffix.replace(/^\//, '');

  if (RESERVED_FILES.has(reqPathRel) || reqPathRel.startsWith('_')) {
    return res.status(404).send('Not found');
  }

  // Любой index.html превью: исправляем типичную ошибку LLM (/dist/bundle.* от корена
  // домена). Нужно и для корня проекта без meta.kind — если bundle лежит рядом с index.
  const shouldNormalizeIndexHtml =
    (req.method === 'GET' || req.method === 'HEAD') && reqPathRel === 'index.html';

  if (shouldNormalizeIndexHtml) {
    try {
      const raw = await fs.readFile(path.join(serveDir, 'index.html'), 'utf8');
      const html = normalizeBundleIndexHtml(raw);
      if (req.method === 'HEAD') return res.status(200).type('html').end();
      res.setHeader('Cache-Control', 'no-store'); // патч каждый запрос — лёгкий файл
      return res.status(200).type('html').send(html);
    } catch (e) {
      return next(e);
    }
  }

  // Сборщик кладёт bundle.* в dist/, а index.html иногда оказывается в корне проекта
  // при static-режиме или после ручных правок LLM — тогда ./bundle.js резолвился бы
  // только в корень и давал 404. Пробуем несколько путей перед express.static.
  if ((req.method === 'GET' || req.method === 'HEAD')
    && (reqPathRel === 'bundle.js' || reqPathRel === 'bundle.css')) {
    const distDir = path.join(dir, 'dist');
    const uniqAbs = [...new Set([
      path.resolve(serveDir, reqPathRel),
      path.resolve(distDir, reqPathRel),
      path.resolve(dir, reqPathRel),
    ])];
    for (const abs of uniqAbs) {
      try {
        await fs.access(abs);
        res.setHeader('Cache-Control', 'no-store');
        const mime = reqPathRel.endsWith('.css')
          ? 'text/css; charset=UTF-8'
          : 'text/javascript; charset=UTF-8';
        if (req.method === 'HEAD') {
          const st = await fs.stat(abs);
          res.setHeader('Content-Type', mime);
          res.setHeader('Content-Length', String(st.size));
          return res.status(200).end();
        }
        await new Promise((resolve, reject) => {
          res.sendFile(abs, (err) => (err ? reject(err) : resolve()));
        });
        return;
      } catch { /* next candidate */ }
    }
  }

  express.static(serveDir, { index: 'index.html' })(req, res, next);
});

// =============================================================
// /media — AI Media Studio (canvas с узлами image/video/upscale/audio).
// CRUD проектов и доступ к файлам результатов. Сами тяжёлые узлы
// (image/video/upscale) подключаются в следующих фазах.
// =============================================================
app.use('/api/media', createMediaRouter());
mountMediaStatic(app);

// Live-статус провайдеров (для UI-баннера). Возвращает только провайдеров,
// у которых последний запрос упал с retryable/auth/quota — UI показывает
// ненавязчивое предупреждение «Anthropic квота: ...».
app.get('/api/provider-status', async (req, res) => {
  // ?probe=1 — форсирует свежую пробу через ping ключей; без флага возвращаем
  // кэш + пассивный _providerStatus (накопленный из реальных вызовов).
  const wantProbe = req.query.probe === '1' || req.query.probe === 'true';
  const force = req.query.force === '1' || req.query.force === 'true';
  let probe = null;
  if (wantProbe) {
    try {
      const { probeAllProviders } = await import('./src/llm-prober.js');
      probe = await probeAllProviders({ force });
    } catch (e) {
      probe = { ts: Date.now(), error: e?.message || String(e) };
    }
  } else {
    try {
      const { getCachedProbe } = await import('./src/llm-prober.js');
      probe = getCachedProbe();
    } catch {}
  }
  res.json({
    providers: getProviderStatus(),    // пассивные ошибки за последние 6ч
    probe,                             // активная диагностика (ping-results)
  });
});

app.get('/api/models', async (_req, res) => {
  try {
    const list = await getModelsMerged();
    const orKey = !!(process.env.OPENROUTER_API_KEY || '').trim();
    res.json(list.map((m) => ({
      id: m.id,
      label: m.label,
      provider: m.provider,
      ...(m.openrouterFree ? { free: true } : {}),
      ...(m.provider === 'openrouter' && !orKey ? { needsOpenRouterKey: true } : {}),
    })));
  } catch (e) {
    console.error('[api/models]', e);
    res.status(500).json({ error: e?.message || String(e) });
  }
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

// =============================================================
// /api/generate/stream — SSE-эндпоинт нового агента-оркестратора.
// Возвращает в реальном времени фазы (brief/architect/context7/coder/smoke/reviewer),
// tool-calls, smoke issues и итоговый payload (тот же формат, что у /api/generate).
//
// Почему отдельный endpoint: старый /api/generate сохраняется для совместимости
// (и для фоллбека, если SSE не поддерживается клиентом / прокси).
// =============================================================
app.post('/api/generate/stream', async (req, res) => {
  const { projectId, prompt, model } = req.body || {};
  if (!prompt || !model) {
    return res.status(400).json({ error: 'prompt и model обязательны' });
  }

  // Готовим SSE-канал
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // отключаем nginx-буферизацию
  res.flushHeaders?.();

  const send = (type, payload = {}) => {
    try {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (e) {
      console.warn('[sse write]', e?.message || e);
    }
  };

  // Heartbeat — раз в 15 сек, чтобы Nginx/прокси не закрывали соединение.
  const hb = setInterval(() => {
    try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch {}
  }, 15000);

  // Если клиент закрыл соединение — прекратим работу
  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
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

    // Гарантируем, что папка проекта существует — coder будет писать в неё файлы напрямую.
    const projectDir = path.join(PROJECTS_DIR, project.id);
    await fs.mkdir(projectDir, { recursive: true });

    const existingFiles = await listProjectFiles(projectDir);
    const isPatchMode = detectPatchMode({ existingFiles, prompt });
    send('start', {
      id: project.id,
      mode: isPatchMode ? 'patch' : 'fresh',
      existingFilesCount: existingFiles.length,
    });

    const bus = new EventBus();
    bus.on('*', (ev) => { if (!aborted) send(ev.type, ev); });

    // smokeRunner: функция (projectDir, indexHtml) → результат Playwright.
    // Открывает реальное превью внутреннего сервера. Если Playwright недоступен,
    // возвращает null/throws → orchestrator делает fallback на jsdom.
    const internalBase = process.env.INTERNAL_PREVIEW_BASE_URL || `http://127.0.0.1:${PORT}`;
    const smokeRunner = isPlaywrightDisabled()
      ? null
      : async (projDir, _indexHtml) => {
          const id = path.basename(projDir);
          const previewUrl = `${internalBase.replace(/\/+$/, '')}/preview/${id}/`;
          try {
            return await runRealSmoke(projDir, { previewUrl, timeoutMs: 15_000 });
          } catch (e) {
            // Кидаем — orchestrator увидит и сделает fallback на jsdom-smokeTestHtml
            throw e;
          }
        };

    const orch = await runOrchestrator({
      projectId: project.id,
      prompt,
      model,
      projectDir,
      existingFiles,
      bus,
      siteSystemPrompt: SYSTEM_PROMPT,
      smokeRunner,
    });

    // Если Coder работал в classic-режиме (без tools) — допарсим extractFiles из текста.
    if (orch.classicText) {
      const filesMap = extractFiles(orch.classicText);
      if (filesMap && filesMap.size > 0) {
        // Запишем все файлы на диск (как при старом /api/generate)
        for (const [rel, content] of filesMap) {
          if (!isSafeRelPath(rel)) continue;
          const abs = path.resolve(projectDir, rel);
          if (!abs.startsWith(path.resolve(projectDir) + path.sep)) continue;
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, String(content ?? ''), 'utf8');
        }
      }
    }

    // Перечитываем итоговый набор файлов с диска
    const finalFileList = await listProjectFiles(projectDir);
    project.fileList = finalFileList;
    project.files = {};
    for (const rel of finalFileList) {
      try { project.files[rel] = await fs.readFile(path.join(projectDir, rel), 'utf8'); } catch {}
    }

    // Учитываем общий usage в проекте
    const u = orch.usage || { input: 0, output: 0, total: 0, calls: 0 };
    project.usage.calls += (u.calls || 1);
    project.usage.input += u.input || 0;
    project.usage.output += u.output || 0;
    project.usage.total += u.total || 0;

    const integrity = validateProjectIntegrity(new Map(Object.entries(project.files)));

    const indexOk = !!project.files['index.html'] || !!project.files['dist/index.html'];
    const smokeOk = !!orch.smoke?.ok;
    const isBroken = !indexOk || !smokeOk || !integrity.ok;

    const usageNote = `📊 Токенов: ${u.total.toLocaleString('ru-RU')} (in: ${u.input}, out: ${u.output})`;
    const modelLine = orch.modelUsed ? `🤖 ${orch.modelUsed}` : '';
    const fbLine = orch.modelUsed && orch.modelUsed !== model ? `(fallback с ${model})` : '';
    const smokeLine = orch.smoke
      ? (orch.smoke.ok
          ? '✅ Smoke-тест: страница загружается без ошибок'
          : `⚠ Smoke нашёл проблемы:\n${(orch.smoke.errors || []).slice(0, 3).map((e) => `  • ${typeof e === 'string' ? e : (e.message || JSON.stringify(e))}`).join('\n')}`)
      : '';
    const sugLine = orch.suggestions?.length
      ? `\n\n💡 Предложения улучшений:\n${orch.suggestions.map((s) => `  ${s.index}. ${s.title} — ${s.why}`).join('\n')}`
      : '';
    const finishLine = orch.finishedMessage ? `\n\n${orch.finishedMessage}` : '';
    const ctx7Line = orch.context7Used?.length
      ? `\n\n📚 Context7: ${orch.context7Used.map((u) => u.name).join(', ')}`
      : '';

    const integrityLine = !integrity.ok
      ? `\n\n⚠ Целостность: ${describeIntegrity(integrity)}`
      : '';

    const filesNote = finalFileList.length === 1
      ? `Готово. Один файл: index.html (${(project.files['index.html'] || '').length.toLocaleString('ru-RU')} символов).`
      : `Готово. ${finalFileList.length} файлов проекта:\n${finalFileList.map((f) => `  • ${f} (${(project.files[f] || '').length.toLocaleString('ru-RU')} симв.)`).join('\n')}`;

    const assistantText = `${filesNote}\n\n${usageNote} ${modelLine} ${fbLine}${ctx7Line}\n\n${smokeLine}${integrityLine}${finishLine}${sugLine}`.trim();

    project.messages.push({
      role: 'assistant',
      content: assistantText,
      ts: Date.now(),
      usage: u,
      modelUsed: orch.modelUsed,
    });
    await writeProject({ ...project, files: project.files });

    const finalPayload = {
      id: project.id,
      title: project.title,
      model: project.model,
      modelUsed: orch.modelUsed,
      mode: orch.mode,
      assistant: assistantText,
      hasHtml: indexOk,
      previewUrl: `/preview/${project.id}/`,
      files: finalFileList,
      usage: u,
      projectUsage: project.usage,
      brokenProject: isBroken,
      noFiles: !finalFileList.length,
      missingFiles: integrity.missing?.map((m) => m.normalized || m.ref) || [],
      scaffoldKind: integrity.hasFrameworkScaffold ? integrity.scaffoldKind : null,
      smoke: orch.smoke ? { ok: orch.smoke.ok, errors: orch.smoke.errors, warnings: orch.smoke.warnings, runner: orch.smoke.runner } : null,
      integrity: { ok: integrity.ok, reactBundlePlaceholder: integrity.reactBundlePlaceholder, missing: integrity.missing },
      brief: orch.brief,
      plan: orch.plan,
      suggestions: orch.suggestions,
      reviewerRating: orch.reviewerRating,
      autofix: orch.autofix ? { rounds: orch.autofix.rounds, fixed: orch.autofix.fixed } : null,
      context7: orch.context7Used,
      iterations: orch.iterations,
      toolCallLog: orch.toolCallLog,
    };

    send('done', finalPayload);
  } catch (e) {
    console.error('[generate/stream]', e);
    // Прокидываем структурированные данные для UI:
    //  - errors[]   — список попыток моделей с причинами,
    //  - suggestedAlternatives[] — что предложить юзеру нажатием.
    const altsFromErr = Array.isArray(e?.suggestedAlternatives) ? e.suggestedAlternatives : null;
    let suggested = altsFromErr;
    if (!suggested || !suggested.length) {
      try {
        const chain = buildToolsFallbackChain(model);
        const failedModels = new Set((e?.errors || []).filter((r) => r?.kind === 'auth' || r?.kind === 'quota').map((r) => r.model));
        suggested = chain
          .filter((id) => !failedModels.has(id) && id !== model)
          .slice(0, 3)
          .map((id) => ({ id, label: resolveModelConfig(id)?.label || id }));
      } catch {}
    }
    send('error', {
      message: e?.userMessage || e?.message || String(e),
      code: e?.code || 'unknown',
      errors: Array.isArray(e?.errors) ? e.errors.slice(-6) : [],
      suggestedAlternatives: suggested || [],
      modelRequested: model,
    });
  } finally {
    clearInterval(hb);
    try { res.end(); } catch {}
  }
});

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

    // ВАЖНО: SYSTEM_PROMPT обязан быть в каждом вызове генератора. Без него
    // модели игнорируют CDN/React/Tailwind правила и валят сборку.
    const chatMessages = [{ role: 'system', content: SYSTEM_PROMPT }];
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

    // Подмешиваем актуальные доки Context7 СРАЗУ ПОСЛЕ system-сообщения, как
    // первый user/assistant обмен. Так модель видит свежие API до того как
    // увидит пользовательский запрос. Безопасно фейлится при отсутствии ключа.
    let context7Used = null;
    if (isContext7Enabled()) {
      try {
        const ctx7 = await buildContextBlockForPrompt(prompt, {
          max: 3, perLibChars: 1800, totalCharsBudget: 4500,
        });
        if (ctx7?.block) {
          // chatMessages[0] — это system. Доки вставляем сразу после него.
          chatMessages.splice(1, 0,
            { role: 'user', content: ctx7.block },
            { role: 'assistant', content: 'Принял. Использую именно эти актуальные API и примеры в коде.' },
          );
          context7Used = ctx7.used;
          console.log('[context7] подмешано', ctx7.used.length, 'библиотек,', ctx7.totalChars, 'симв.');
        }
      } catch (e) {
        console.warn('[context7]', e?.message || e);
      }
    }

    // 1-я попытка — даём модели много токенов на output, чтобы не резать HTML.
    let result = await callWithFallback({
      modelId: model,
      messages: chatMessages,
      task: 'generate',
      projectId: project.id,
      maxTokens: 32000,
    });
    let rawText = result.text || '';
    let files = extractFiles(rawText);
    let report = files && files.size > 0 ? validateProjectIntegrity(files) : null;

    // Учитываем токены 1-й попытки сразу — они уже потрачены в любом случае.
    const accUsage = { ...result.usage };
    project.usage.calls += 1;
    project.usage.input += result.usage.input;
    project.usage.output += result.usage.output;
    project.usage.total += result.usage.total;

    // АВТО-CONTINUATION: если index.html оборвался по лимиту output (нет </html>),
    // просим модель «продолжить ровно с того места» и склеиваем ответы. До 3 итераций.
    const continuationLog = [];
    if (files && files.has('index.html')) {
      let html = files.get('index.html');
      let cont = 0;
      while (cont < 3 && /<!doctype/i.test(html) && !/<\/html\s*>/i.test(html)) {
        cont += 1;
        const lastChars = html.slice(-1500);
        const contMessages = [
          ...chatMessages,
          { role: 'assistant', content: rawText },
          {
            role: 'user',
            content: [
              'Твой предыдущий ответ ОБОРВАЛСЯ по лимиту токенов: index.html не закрыт </html>.',
              'Продолжи ровно С ТОГО МЕСТА, где остановился. НЕ повторяй уже написанное. НЕ начинай заново.',
              'Просто продолжи код и доведи до </html>.',
              '',
              'Формат ответа: ровно один блок ```html без вступлений и пояснений, в нём — ТОЛЬКО продолжение (то, что должно идти после последних 1500 символов ниже).',
              '',
              'Последние 1500 символов уже написанного index.html:',
              '<<<',
              lastChars,
              '>>>',
            ].join('\n'),
          },
        ];
        try {
          const rc = await callWithFallback({
            modelId: result.modelUsed || model,
            messages: contMessages,
            task: 'generate',
            projectId: project.id,
            maxTokens: 32000,
          });
          accUsage.input += rc.usage.input;
          accUsage.output += rc.usage.output;
          accUsage.total += rc.usage.total;
          project.usage.calls += 1;
          project.usage.input += rc.usage.input;
          project.usage.output += rc.usage.output;
          project.usage.total += rc.usage.total;

          const piece = extractContinuation(rc.text || '', lastChars);
          if (!piece) {
            continuationLog.push({ iter: cont, ok: false, reason: 'не удалось выделить продолжение' });
            break;
          }
          html = html + piece;
          files.set('index.html', html);
          rawText = rawText + piece;
          continuationLog.push({ iter: cont, ok: true, addedChars: piece.length, model: rc.modelUsed });
        } catch (e) {
          continuationLog.push({ iter: cont, ok: false, reason: e?.message || String(e) });
          console.warn('[generate continuation]', e?.message || e);
          break;
        }
      }
      report = validateProjectIntegrity(files);
    }

    // АВТО-РЕТРАЙ: либо модель не выдала ни одного валидного файла (сплошной markdown-
    // обзор архитектуры с ```jsx-блоками без префикса file:), либо вернула scaffold/
    // битые ссылки. В обоих случаях даём корректирующее указание и просим переписать.
    let retried = false;
    let retryReason = null;
    const noFilesExtracted = !files || files.size === 0;
    // Предварительный smoke-тест — нужен для решения о ретрае (даже если report.ok).
    let preSmoke = null;
    if (files && files.has('index.html')) {
      try {
        preSmoke = await smokeTestHtml(files.get('index.html'));
      } catch {}
    }
    const smokeFailed = preSmoke && !preSmoke.ok;
    const needsRetry = noFilesExtracted
      || (files && files.size > 0 && report && !report.ok)
      || smokeFailed;

    if (needsRetry) {
      retried = true;
      const reasons = [];
      if (noFilesExtracted) reasons.push('модель вернула markdown-описание/архитектуру вместо кода в требуемом формате');
      if (report && !report.ok) reasons.push(describeIntegrity(report));
      if (smokeFailed) reasons.push('runtime smoke-тест провалился: ' + (preSmoke?.errors?.slice(0, 2).join('; ') || ''));
      retryReason = reasons.filter(Boolean).join(' / ');

      const correctionContent = noFilesExtracted
        ? [
            'ВАЖНО: предыдущий ответ — БРАК. Ты вернул markdown-описание проекта (заголовки, дерево каталогов, "## Project Structure", блоки ```jsx без префикса file:) вместо рабочего кода в нужном формате.',
            '',
            'Препроверка нашла ноль валидных файлов (нужны блоки ```html ИЛИ ```file:путь, которых не было).',
            '',
            'Перепиши задачу с НУЛЯ в виде ОДНОГО самодостаточного index.html (формат A):',
            '  • первый символ ответа — ```html (без вступительных слов).',
            '  • внутри — `<!doctype html>` ... `</html>`.',
            '  • Tailwind через CDN (`https://cdn.tailwindcss.com`), AOS/lucide/animate.css по необходимости тоже через CDN.',
            '  • если хочешь React — `<script type="text/babel" data-presets="env,react">...</script>` ВНУТРИ этого index.html, БЕЗ `import` из npm, БЕЗ `framer-motion`, `react-router-dom`, `lucide-react` (используй CSS-анимации, AOS, hash-маршрутизацию, lucide через CDN+createIcons).',
            '  • никаких отдельных `*.jsx`, `*.tsx`, `App.jsx`, `index.js`, `tailwind.config.js`, `package.json`.',
            '  • наполни сайт реальным премиальным контентом по исходному ТЗ — все секции, тексты, цифры.',
            '',
            'Никаких объяснений до или после блока ```html. Только сам блок целиком.',
          ].join('\n')
        : [
            'ВАЖНО: предыдущий ответ — БРАК.',
            retryReason,
            '',
            'Перепиши проект так, чтобы он работал САМОСТОЯТЕЛЬНО без сборщиков (vite/next/cra/webpack).',
            'Запрещены любые ссылки на локальные файлы, которых нет в твоём ответе как полноценных ```file: блоков.',
            'Запрещены /src/main.tsx, /src/index.tsx, /vite.svg, /_next/* и подобные.',
            '',
            '🚫 ОСОБО ЗАПРЕЩЕНО (это и провалило прошлый ответ):',
            '  • framer-motion ЛЮБЫМ способом — UMD-сборки framer-motion на CDN НЕТ, `window.FramerMotion` всегда undefined и Babel сразу падает с TypeError. Используй CSS transitions/animations, animate.css, AOS, GSAP (у GSAP UMD есть).',
            '  • react-router-dom через CDN — UMD тоже не работает. Делай маршрутизацию через `window.location.hash` и условный рендер.',
            '  • lucide-react — нельзя. Используй обычный lucide через `https://unpkg.com/lucide@latest` + `lucide.createIcons()`.',
            '  • любые `import ... from "react|react-dom|framer-motion|react-router-dom|lucide-react|next/..."` — без сборщика они не работают.',
            '',
            'Если нужен React — встрой ВСЁ в один <script type="text/babel" data-presets="env,react"> прямо внутри index.html. Внутри: `const { useState, useEffect } = React;` (или `React.useState`), JSX без ESM-импортов.',
            'Иконку либо убери, либо встрой как data:image/svg+xml,...',
            'Верни ответ СТРОГО в принятом формате (формат A — один ```html блок, либо формат B — несколько ```file: блоков). Никакого текста до/после.',
          ].join('\n');

      const correctionMessages = [
        ...chatMessages,
        { role: 'assistant', content: result.text },
        { role: 'user', content: correctionContent },
      ];

      try {
        const r2 = await callWithFallback({
          modelId: result.modelUsed || model,
          messages: correctionMessages,
          task: 'generate',
          projectId: project.id,
          maxTokens: 32000,
        });
        const files2 = extractFiles(r2.text);
        const report2 = files2 && files2.size > 0 ? validateProjectIntegrity(files2) : null;
        let smoke2 = null;
        if (files2 && files2.has('index.html')) {
          try { smoke2 = await smokeTestHtml(files2.get('index.html')); } catch {}
        }
        // Берём вторую попытку, если она строго лучше:
        // - до этого вообще не было файлов, а теперь есть;
        // - либо предыдущий smoke падал, а теперь зелёный;
        // - либо отчёт стал лучше (меньше missing, нет scaffold).
        const had = files && files.size > 0;
        const got = files2 && files2.size > 0;
        const prevBad = !report || !report.ok || smokeFailed;
        const newGood = report2 && report2.ok && smoke2 && smoke2.ok;
        const better = got && (
          !had
          || newGood
          || (prevBad && report2 && !report2.hasFrameworkScaffold && smoke2 && smoke2.ok)
          || (report2 && !report2.hasFrameworkScaffold && (!report || (report2.missing.length < (report?.missing?.length ?? 0))))
        );
        if (better) {
          result = r2;
          rawText = r2.text || '';
          files = files2;
          report = report2;
          accUsage.input += r2.usage.input;
          accUsage.output += r2.usage.output;
          accUsage.total += r2.usage.total;
          project.usage.calls += 1;
          project.usage.input += r2.usage.input;
          project.usage.output += r2.usage.output;
          project.usage.total += r2.usage.total;
        }
      } catch (e) {
        console.warn('[generate retry]', e?.message || e);
      }
    }

    // ============================================================
    // RUNTIME SMOKE: лёгкий jsdom-тест собранного index.html.
    // Ловит: HTML без </html>, window.FramerMotion без CDN, ESM-импорты npm,
    // битые inline-скрипты, пустой <body>.
    // ============================================================
    let smoke = null;
    if (files && files.has('index.html')) {
      try {
        smoke = await smokeTestHtml(files.get('index.html'), { requireBodyContent: true });
      } catch (e) {
        console.warn('[smoke]', e?.message || e);
        smoke = { ok: false, errors: ['smoke crashed: ' + (e?.message || e)], warnings: [] };
      }
    }

    let assistantText;
    if (files && files.size > 0) {
      project.files = Object.fromEntries(files);
      project.fileList = [...files.keys()].sort();
      const indexHtml = project.files['index.html'] || '';
      const truncated = indexHtml && !/<\/html\s*>/i.test(indexHtml);
      const fb = result.fallbackFrom
        ? `\n\nℹ Модель ${result.fallbackFrom} недоступна, использовали ${result.modelUsed}.`
        : '';
      const usageNote = `\n\n📊 Токенов: ${accUsage.total.toLocaleString('ru-RU')} (in: ${accUsage.input}, out: ${accUsage.output})`;
      const listNote = files.size === 1
        ? `Готово. Один файл: index.html (${indexHtml.length.toLocaleString('ru-RU')} символов).`
        : `Готово. ${files.size} файлов проекта:\n${[...files.keys()].sort().map((f) => `  • ${f} (${(project.files[f] || '').length.toLocaleString('ru-RU')} симв.)`).join('\n')}`;
      const integrityNote = report && !report.ok
        ? `\n\n⚠ ${describeIntegrity(report)} Превью может быть пустым. Нажми «Повторить» или выбери другую модель.`
        : '';
      const smokeNote = smoke && !smoke.ok
        ? `\n\n⚠ Smoke-тест превью нашёл проблемы:\n${smoke.errors.slice(0, 3).map((x) => `  • ${x}`).join('\n')}`
        : '';
      const continuationNote = continuationLog.length
        ? `\n\nℹ Модель оборвала ответ по лимиту, дозапросил продолжение ${continuationLog.length}× (${continuationLog.filter((c) => c.ok).length} удачных).`
        : '';
      const ctx7Note = context7Used && context7Used.length
        ? `\n\n📚 Context7: ${context7Used.map((u) => `${u.name} (${u.chars} симв.)`).join(', ')}`
        : '';
      assistantText = listNote + usageNote + fb + ctx7Note + continuationNote +
        (truncated
          ? '\n\n⚠ index.html всё равно обрезан (нет </html>) после auto-continuation. Попроси «закончи код» или упрости объём.'
          : '') + integrityNote + smokeNote;
    } else {
      const fb = result.fallbackFrom
        ? `\n\nℹ Модель ${result.fallbackFrom} недоступна, использовали ${result.modelUsed}.`
        : '';
      const usageNote = `\n\n📊 Токенов: ${accUsage.total.toLocaleString('ru-RU')} (in: ${accUsage.input}, out: ${accUsage.output})`;
      assistantText =
        '⚠ Модель не вернула рабочие файлы (ответила markdown-описанием архитектуры вместо кода в нужном формате). Авто-ретрай тоже не помог.' +
        '\n\nЧто делать:\n  • нажми «Сгенерировать ещё раз» — попробую снова с тем же промптом;\n  • или выбери другую модель (Claude Haiku/Sonnet, GPT-4o, Gemini Flash) и повтори.' +
        usageNote + fb;
    }

    const noFiles = !(files && files.size > 0);
    const isBroken = noFiles || !!(report && !report.ok) || !!(smoke && !smoke.ok);

    project.messages.push({
      role: 'assistant',
      content: assistantText,
      ts: Date.now(),
      usage: accUsage,
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
      usage: accUsage,
      projectUsage: project.usage,
      brokenProject: isBroken,
      noFiles,
      missingFiles: report ? report.missing.map((m) => m.normalized || m.ref) : [],
      scaffoldKind: report?.scaffoldKind || (noFiles ? 'no-files' : null),
      retried,
      retryReason: retried ? retryReason : null,
      smoke: smoke ? { ok: smoke.ok, errors: smoke.errors, warnings: smoke.warnings } : null,
      continuation: continuationLog.length ? continuationLog : null,
      context7: context7Used,
    });
  } catch (e) {
    console.error('[generate]', e);
    res.status(502).json({
      error: e?.userMessage || e?.message || String(e),
      code: e?.code || 'unknown',
      errors: Array.isArray(e?.errors) ? e.errors.slice(-5) : undefined,
      suggestedAlternatives: e?.suggestedAlternatives,
    });
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
    res.status(502).json({
      error: e?.userMessage || e?.message || String(e),
      code: e?.code || 'unknown',
      errors: Array.isArray(e?.errors) ? e.errors.slice(-5) : undefined,
      suggestedAlternatives: e?.suggestedAlternatives,
    });
  }
});

// =============================================================
// Статистика (генератор сайтов)
// =============================================================
app.get('/api/stats', async (_req, res) => {
  const stats = await readGeneratorStats();
  let list = [];
  try {
    list = await getModelsMerged();
  } catch {
    list = [];
  }
  const labels = Object.fromEntries(list.map((m) => [m.id, m.label]));
  res.json({ ...stats, modelLabels: labels });
});

app.delete('/api/stats', async (_req, res) => {
  await resetGeneratorStats();
  res.json({ ok: true });
});

// =============================================================
// Простой чат-агент (выбор модели, без RAG и без генерации сайтов)
// POST /api/agent/chat { model, messages[], temperature?, systemPrompt? }
// =============================================================
app.use('/api/agent', agentChatRouter);

// =============================================================
// Модуль AI-ассистентов (RAG, база знаний, чат, статистика, токены)
// =============================================================
app.use('/api/assistants', assistantsRouter);

// =============================================================
// Публичный API под bearer-токенами (для виджета и сторонних клиентов)
// =============================================================
app.use('/api/v1', publicApiRouter);

// Раз в сутки чистим shared node_cache от папок старше 30 дней.
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
setInterval(async () => {
  try {
    const r = await cleanupOldCacheDirs();
    if (r.removed > 0) console.log(`[cleanup] node_cache: удалено ${r.removed}, осталось ${r.remaining}`);
  } catch (e) {
    console.warn('[cleanup] node_cache:', e?.message || e);
  }
}, CLEANUP_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`\n🚀 AI Site Builder запущен:  http://localhost:${PORT}`);
  console.log(`💬 Простой чат-агент:          http://localhost:${PORT}/agent/`);
  console.log(`🤖 Ассистенты:                http://localhost:${PORT}/assistant/`);
  console.log(`🔑 Публичный API:             http://localhost:${PORT}/api/v1/`);
  console.log(`📁 Проекты сохраняются в:    ${PROJECTS_DIR}\n`);
});
