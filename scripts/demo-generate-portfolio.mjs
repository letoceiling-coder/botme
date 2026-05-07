/**
 * Однократный прогон оркестратора (как /api/generate/stream), без HTTP.
 * Требует ключи в окружении (.env через dotenv если установлен).
 *
 *   node scripts/demo-generate-portfolio.mjs
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { EventBus } from '../src/agent/event-bus.js';
import { runOrchestrator } from '../src/agent/orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function extractSystemPrompt(serverText) {
  const startMark = 'const SYSTEM_PROMPT = `';
  const bodyStart = serverText.indexOf(startMark);
  if (bodyStart === -1) throw new Error('SYSTEM_PROMPT start not found');
  const from = bodyStart + startMark.length;
  const endMark =
    '`;\n\n// =============================================================\n// Системный промпт для УЛУЧШЕНИЯ промпта пользователя';
  const to = serverText.indexOf(endMark, from);
  if (to === -1) throw new Error('SYSTEM_PROMPT end not found');
  return serverText.slice(from, to);
}

const PROMPT = `Создай одностраничный сайт-портфолио для Никиты Клочко.

Стиль:
премиальный cold editorial / tech fashion / portfolio board.
Визуально вдохновиться референсом: холодные сине-серые оттенки, крупная типографика, карточная сетка, ощущение коллекции/каталога, минимализм, high-end digital studio.
Фон: глубокий сине-серый или графитовый.
Акценты: ледяной голубой, белый, серый.
Много воздуха, тонкие линии, аккуратная сетка, крупные заголовки.
Сайт должен выглядеть как персональная презентация AI/digital специалиста, а не обычное резюме.

Сделай mobile-first, но красиво и на desktop.

Главная идея:
Никита Клочко — AI / Digital Systems Operator.
Он помогает бизнесу соединять AI, digital, контент, сайты, Telegram Mini Apps, автоматизацию и продажи в понятные работающие системы.

Структура сайта:

1. HERO
Крупный заголовок:
NIKITA KLOCHKO
AI / DIGITAL SYSTEMS OPERATOR

Подзаголовок:
Соединяю бизнес, AI, digital-продукты и контент в работающие системы: от идеи и упаковки до запуска, продаж и автоматизации.

Кнопки:
Связаться в Telegram
Посмотреть кейсы

2. ABOUT
Коротко:
Я не просто "делаю сайты". Я помогаю бизнесу понять, где теряются заявки, как упаковать продукт, какие AI-инструменты внедрить и как собрать digital-инфраструктуру под рост.

3. WHAT I DO
Карточки в сетке:
AI-ассистенты
Сайты и digital-продукты
Telegram Mini Apps
AI-видео и контент
Автоматизация процессов
Упаковка офферов и продаж

4. CASES / PROJECTS
Сделай карточки проектов:
BatNorton — e-commerce, кастомная админ-панель, мультиязычность, мультивалютность
ПОВУЗАМ — digital-платформа для вузов, сайт, админ-панель, SEO-структура
Telegram Mini Apps — боты и мини-приложения для бизнеса
AI Media — генерация видео, изображений и визуалов для рекламы
Football Academy — сайт и система записи для спортивной школы
Vet AI Booking — концепт AI-записи для ветеринарных клиник

5. SKILLS
Сделай как теги:
Product Thinking
AI Workflows
Prompt Engineering
UX/UI
Sales Systems
Digital Strategy
Content Production
Telegram Bots
Automation
CRM Logic
Team Coordination

6. WORK MODEL
3 шага:
1. Разбираю бизнес и нахожу точки потери денег
2. Собираю digital / AI-решение под задачу
3. Запускаю, тестирую, упаковываю в кейс и систему продаж

7. FINAL CTA
Заголовок:
Если у бизнеса есть хаос в digital — я помогаю собрать систему.

Кнопка:
Написать мне в Telegram

Контакты:
Telegram: @neeklo
Email: klochkonikita@mail.ru

Дизайн-детали:
- карточки как fashion collection board
- крупные секции
- тонкие подписи маленьким uppercase
- легкие blur/glass элементы
- плавные hover-анимации
- мягкое появление блоков при скролле
- не использовать яркие кислотные цвета
- сделать ощущение дорого, спокойно, технологично
- текст на русском
- не перегружать
- сайт должен выглядеть как личный бренд современного AI/digital специалиста`;

const MODEL = 'openrouter:google/gemini-3-flash-preview';

const serverText = await fs.readFile(path.join(root, 'server.js'), 'utf8');
const siteSystemPrompt = extractSystemPrompt(serverText);

const id = randomUUID();
const PROJECTS_DIR = path.join(root, 'projects');
const projectDir = path.join(PROJECTS_DIR, id);
await fs.mkdir(projectDir, { recursive: true });

console.log('=== demo-generate-portfolio ===');
console.log('projectId:', id);
console.log('model:', MODEL);
console.log('projectDir:', projectDir);

const bus = new EventBus();
bus.on('*', (ev) => {
  if (ev.type === 'warn') {
    console.log(`[warn] ${ev.message || ''}`);
    return;
  }
  const line = `[${ev.type}] ${ev.phase || ''} ${(ev.detail && JSON.stringify(ev.detail).slice(0, 200)) || ''}`.trim();
  console.log(line);
});

try {
  const orch = await runOrchestrator({
    projectId: id,
    prompt: PROMPT,
    model: MODEL,
    projectDir,
    existingFiles: [],
    bus,
    siteSystemPrompt,
    smokeRunner: null,
  });

  console.log('\n=== orchestrator finished ===');
  console.log(JSON.stringify({
    requestedModel: MODEL,
    fallbackFrom: orch.fallbackFrom ?? null,
    mode: orch.mode,
    modelUsed: orch.modelUsed,
    iterations: orch.iterations,
    finishedMessage: orch.finishedMessage,
    smoke: orch.smoke ? { ok: orch.smoke.ok, runner: orch.smoke.runner, errors: orch.smoke.errors?.slice?.(0, 5) } : null,
    planKind: orch.plan?.kind,
    toolCallLog: orch.toolCallLog,
  }, null, 2));

  const walk = [];
  async function listRel(sub = '') {
    const abs = path.join(projectDir, sub);
    let entries = [];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) await listRel(rel);
      else walk.push(rel);
    }
  }
  await listRel('');
  walk.sort();
  console.log('\nfiles:', walk.length);
  console.log(walk.join('\n'));

  const idx = path.join(projectDir, 'index.html');
  const distIdx = path.join(projectDir, 'dist', 'index.html');
  for (const p of [idx, distIdx]) {
    try {
      const t = await fs.readFile(p, 'utf8');
      const hits = ['NIKITA', 'KLOCHKO', '@neeklo', 'BatNorton', 'Никита'].filter((k) => t.includes(k));
      if (hits.length) console.log(`\n${path.relative(projectDir, p)} contains:`, hits.join(', '));
    } catch {}
  }

  console.log('\npreview (local):', `http://127.0.0.1:${process.env.PORT || 3001}/preview/${id}/`);
} catch (e) {
  console.error('\nFAILED:', e?.message || e);
  if (e?.errors) console.error(JSON.stringify(e.errors, null, 2));
  process.exitCode = 1;
}
