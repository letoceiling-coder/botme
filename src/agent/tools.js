// Tool-калог агента генерации сайтов.
//
// Каждый tool описан в едином формате (name, description, parameters в JSON-Schema)
// + impl(args, ctx) — реальная реализация на сервере. Ctx содержит EventBus,
// projectDir, возможно дополнительные ресурсы (Context7-клиент и т.д.).
//
// Декларации компилируются в формат провайдера (OpenAI, Anthropic) в src/llm.js,
// чтобы Coder-стадия могла вызывать их из function-calling-цикла.
//
// Базовые tools:
//   - read_file(path)
//   - write_file(path, content)
//   - apply_patch(path, oldStr, newStr)
//   - context7_lookup(libraries[])
//   - run_smoke()
//   - finish_generation(message?) — модель сообщает, что код готов

import path from 'node:path';
import fs from 'node:fs/promises';
import { applyPatch, isSafeRel, resolveSafe } from './patch.js';
import { smokeTestHtml } from '../runtime-smoke.js';
import {
  isContext7Enabled,
  buildContextBlockForLibraries,
  buildContextBlockForPrompt,
} from '../context7.js';
import { buildProject as buildBundle, isBundleProject } from '../builder/esbuild-runner.js';
import { isReactBundleAppPlaceholder } from '../project-validator.js';

const MAX_FILE_BYTES = 1_000_000;        // защита от огромных read_file
const MAX_WRITE_BYTES = 2_000_000;       // защита от огромных write_file

// =============================================================
// Декларации (в нашем «нейтральном» формате; конвертация — в src/llm.js)
// =============================================================
export const TOOL_DECLARATIONS = [
  {
    name: 'read_file',
    description:
      'Прочитать существующий файл проекта. Возвращает текстовое содержимое. ' +
      'Используй ПЕРЕД apply_patch, если не помнишь точный фрагмент.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Относительный путь от корня проекта (например index.html, assets/style.css).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Записать ПОЛНОСТЬЮ новый файл проекта или перезаписать существующий целиком. ' +
      'Используй для создания новых файлов или когда нужна полная перезапись (правки лучше через apply_patch).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Относительный путь от корня проекта.' },
        content: { type: 'string', description: 'Полный текст файла.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'apply_patch',
    description:
      'Точечно изменить файл: заменить уникальное вхождение oldStr на newStr. ' +
      'oldStr должен встречаться в файле РОВНО ОДИН РАЗ (иначе расширь контекст). ' +
      'Совпадение — точное по символам, включая отступы и переносы строк.',
    parameters: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Относительный путь файла.' },
        oldStr:  { type: 'string', description: 'Точный фрагмент, который надо заменить (включая контекст для уникальности).' },
        newStr:  { type: 'string', description: 'Новый фрагмент. Может быть пустой строкой.' },
      },
      required: ['path', 'oldStr', 'newStr'],
    },
  },
  {
    name: 'context7_lookup',
    description:
      'Получить актуальные docs по списку библиотек из Context7 (tailwindcss, react, gsap, swiper, three, lucide и т.д.). ' +
      'Полезно перед использованием новой/нестандартной CDN-либы, чтобы не выдумать API. ' +
      'Возвращает выжимку с примерами и ссылками.',
    parameters: {
      type: 'object',
      properties: {
        libraries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Имена библиотек, как их называет npm/CDN (например ["tailwindcss", "lucide", "framer-motion"]).',
        },
      },
      required: ['libraries'],
    },
  },
  {
    name: 'run_smoke',
    description:
      'Прогнать smoke-сборку: для react-bundle читается dist/index.html после rebuild_bundle ' +
      '(корневой index — копия шаблона, не использовать для самопроверки). Playwright загружает живое превью; ' +
      'fallback на jsdom по тексту этого HTML. Перед finish_generation.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'rebuild_bundle',
    description:
      'Пересобрать react-bundle проект через esbuild + Tailwind. ' +
      'Используй ТОЛЬКО для проектов c kind="react-bundle" (meta.json) после write_file/apply_patch в src/. ' +
      'Возвращает список ошибок сборки. Перед run_smoke этот шаг ОБЯЗАТЕЛЕН для bundle-проектов.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'finish_generation',
    description:
      'Сообщить, что код готов. Завершает Coder-стадии только если ok=true. ' +
      'Для react-bundle сервер отклонит вызов, пока src/App.tsx — стартовая заглушка «Шаблон react-bundle»: ' +
      'нужно реализовать запрос пользователя в коде, rebuild_bundle → run_smoke → снова finish_generation. ' +
      'Иначе — после run_smoke с ok=true.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Короткое описание, что было сделано (1-2 предложения для пользователя).',
        },
      },
      required: [],
    },
  },
];

// =============================================================
// Имплементации
// ctx = { projectDir, bus, smokeRunner?: async (projectDir, indexHtml) => smoke }
// =============================================================
export async function execute(name, rawArgs, ctx) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  const { projectDir, bus } = ctx;
  if (!projectDir) throw new Error('execute: projectDir обязателен');

  switch (name) {
    case 'read_file': {
      const abs = resolveSafe(projectDir, String(args.path || ''));
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat || !stat.isFile()) {
        return { ok: false, error: `Файл не найден: ${args.path}` };
      }
      if (stat.size > MAX_FILE_BYTES) {
        return { ok: false, error: `Файл слишком большой (${stat.size} байт > ${MAX_FILE_BYTES})` };
      }
      const content = await fs.readFile(abs, 'utf8');
      return { ok: true, path: args.path, size: stat.size, content };
    }

    case 'write_file': {
      const rel = String(args.path || '');
      if (!isSafeRel(rel)) return { ok: false, error: `Небезопасный путь: ${rel}` };
      const content = String(args.content ?? '');
      if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
        return { ok: false, error: `Слишком много контента в одном write_file (>${MAX_WRITE_BYTES} байт). Разбей на части.` };
      }
      const abs = resolveSafe(projectDir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      return { ok: true, path: rel, bytes: Buffer.byteLength(content, 'utf8') };
    }

    case 'apply_patch': {
      try {
        const r = await applyPatch(
          projectDir,
          String(args.path || ''),
          String(args.oldStr ?? ''),
          String(args.newStr ?? ''),
        );
        return { ok: true, ...r };
      } catch (e) {
        return { ok: false, error: e?.message || String(e), code: e?.code };
      }
    }

    case 'context7_lookup': {
      if (!isContext7Enabled()) {
        return { ok: false, error: 'Context7 не настроен (CONTEXT7_API_KEY)' };
      }
      const libs = Array.isArray(args.libraries)
        ? args.libraries.filter((s) => typeof s === 'string').slice(0, 5)
        : [];
      if (!libs.length) return { ok: false, error: 'Передай хотя бы одну библиотеку' };
      try {
        // Если в context7 есть прямой lookup по libraries — используем его;
        // иначе fallback через buildContextBlockForPrompt с искусственным запросом.
        let result;
        if (typeof buildContextBlockForLibraries === 'function') {
          result = await buildContextBlockForLibraries(libs, {
            perLibChars: 1500, totalCharsBudget: 4500,
          });
        } else {
          result = await buildContextBlockForPrompt(libs.join(' '), {
            max: libs.length, perLibChars: 1500, totalCharsBudget: 4500,
          });
        }
        return {
          ok: true,
          libraries: result?.used || [],
          docs: result?.block || '',
          totalChars: result?.totalChars || 0,
        };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    }

    case 'run_smoke': {
      // Для react-bundle превью и реальные бандлы — в dist/index.html; корневой index — копия шаблона.
      try {
        const rootIndex = path.join(projectDir, 'index.html');
        const distIndex = path.join(projectDir, 'dist', 'index.html');
        let indexAbs = rootIndex;

        const distOk = await fs.access(distIndex).then(() => true).catch(() => false);
        let preferDist = false;
        try {
          const meta = JSON.parse(await fs.readFile(path.join(projectDir, 'meta.json'), 'utf8'));
          preferDist = meta?.kind === 'react-bundle' && distOk;
        } catch {
          const mainTsx = path.join(projectDir, 'src', 'main.tsx');
          preferDist = distOk && await fs.access(mainTsx).then(() => true).catch(() => false);
        }
        if (preferDist) indexAbs = distIndex;

        const indexExists = await fs.access(indexAbs).then(() => true).catch(() => false);
        if (!indexExists) {
          return {
            ok: false,
            error: preferDist
              ? 'dist/index.html отсутствует — сначала rebuild_bundle для react-bundle'
              : 'index.html отсутствует',
          };
        }
        const indexHtml = await fs.readFile(indexAbs, 'utf8');

        if (typeof ctx.smokeRunner === 'function') {
          try {
            const real = await ctx.smokeRunner(projectDir, indexHtml);
            if (real) return { ok: !!real.ok, ...real, runner: 'playwright' };
          } catch (e) {
            bus?.warn(`Playwright smoke fail, fallback на jsdom: ${e?.message || e}`);
          }
        }
        const r = await smokeTestHtml(indexHtml, { requireBodyContent: true });
        return { ok: !!r.ok, ...r, runner: 'jsdom' };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    }

    case 'rebuild_bundle': {
      try {
        const isBundle = await isBundleProject(projectDir);
        if (!isBundle) {
          return { ok: false, error: 'Это не react-bundle проект (meta.json.kind != "react-bundle")' };
        }
        const r = await buildBundle(projectDir);
        return { ok: r.ok, errors: r.errors, warnings: r.warnings, durationMs: r.durationMs, outDir: r.outDir };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    }

    case 'finish_generation': {
      try {
        const bundle = await isBundleProject(projectDir).catch(() => false);
        if (bundle) {
          const appPath = path.join(projectDir, 'src', 'App.tsx');
          let appText = '';
          try {
            appText = await fs.readFile(appPath, 'utf8');
          } catch { /* нет файла */ }
          if (appText && isReactBundleAppPlaceholder(appText)) {
            return {
              ok: false,
              finished: false,
              error:
                'Отклонено: в src/App.tsx всё ещё стартовый шаблон («Шаблон react-bundle»). ' +
                'Реализуй запрос пользователя в коде (src/App.tsx и при нужде другие файлы под src/), ' +
                'удали заглушку, затем rebuild_bundle → run_smoke → finish_generation.',
            };
          }
        }
      } catch { /* не блокируем при сбое проверки */ }
      return { ok: true, finished: true, message: String(args.message || '') };
    }

    default:
      return { ok: false, error: `Неизвестный tool: ${name}` };
  }
}

// =============================================================
// Конвертация деклараций в формат конкретного провайдера
// =============================================================
export function toolsForOpenAI(decls = TOOL_DECLARATIONS) {
  return decls.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parameters,
    },
  }));
}

export function toolsForAnthropic(decls = TOOL_DECLARATIONS) {
  return decls.map((d) => ({
    name: d.name,
    description: d.description,
    input_schema: d.parameters,
  }));
}
