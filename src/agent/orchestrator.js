// Orchestrator: state-machine стадий генерации сайта.
//   Brief → Architect → Context7 → Coder → (Smoke внутри Coder) → Autofix? → Reviewer
//
// Принимает: { projectId, prompt, model, projectDir, existingFiles, bus, siteSystemPrompt }
// Возвращает: { brief, plan, files (в файловой системе уже), smoke, suggestions, usage, ... }
//
// EventBus получает структурированные phase.start/done и tool-events. Сервер
// транслирует их в SSE-поток клиенту, клиент рисует таймлайн.

import path from 'node:path';
import fs from 'node:fs/promises';
import { runBrief } from './stages/brief.js';
import { runArchitect } from './stages/architect.js';
import { runCoder } from './stages/coder.js';
import { runReviewer } from './stages/reviewer.js';
import { runAutofix } from './stages/autofix.js';
import {
  isContext7Enabled,
  buildContextBlockForLibraries,
  detectLibrariesInFiles,
} from '../context7.js';
import { initReactBundleTemplate } from '../builder/template-init.js';
import { buildProject as buildBundle, isBundleProject } from '../builder/esbuild-runner.js';
import {
  extractFilesFromAssistantText,
  writeExtractedMapToProject,
} from './extract-project-from-text.js';

const PATCH_HINTS_RE = /(измени|поправ|исправ|заме|удали|добав|сдела(?:й|ть)\s+(?:другой|другую|так)|перекрас|подправ|fix|update|change|tweak)/i;

async function tryRecoverFilesFromCoderAssistantText(bus, projectDir, text) {
  if (!text || !String(text).trim()) return 0;
  const indexAbs = path.join(projectDir, 'index.html');
  const hasIndex = await fs.access(indexAbs).then(() => true).catch(() => false);
  if (hasIndex) return 0;
  const map = extractFilesFromAssistantText(text);
  if (!map?.size) return 0;
  const n = await writeExtractedMapToProject(projectDir, map);
  if (n > 0) bus.warn('Модель не вызвала write_file — извлекли файлы из текста ответа (fallback).');
  return n;
}

/**
 * Эвристика: считать ли запрос «правкой» существующего проекта.
 * Если у проекта уже есть файлы И промпт короткий или содержит явные «измени/поправь» —
 * идём в patch-mode (skip Brief/Architect).
 */
export function detectPatchMode({ existingFiles, prompt }) {
  if (!existingFiles || !existingFiles.length) return false;
  if (!prompt) return false;
  const len = prompt.trim().length;
  if (len < 200) return true;
  if (PATCH_HINTS_RE.test(prompt)) return true;
  return false;
}

/**
 * Главная функция оркестрации. Отвечает за вызов стадий, сбор usage,
 * формирование финального summary, post-Context7-lookup по факту исп.
 */
export async function runOrchestrator(params) {
  const {
    projectId,
    prompt,
    model,
    projectDir,
    existingFiles = [],
    bus,
    siteSystemPrompt,
    smokeRunner,    // (projectDir, indexHtml) => Playwright-result; null = jsdom
  } = params;

  if (!bus) throw new Error('runOrchestrator: bus обязателен');
  if (!projectDir) throw new Error('runOrchestrator: projectDir обязателен');

  const totalUsage = { input: 0, output: 0, total: 0, calls: 0 };
  const addUsage = (u) => {
    if (!u) return;
    totalUsage.input += u.input || 0;
    totalUsage.output += u.output || 0;
    totalUsage.total += u.total || (u.input || 0) + (u.output || 0);
    totalUsage.calls += 1;
  };

  bus.emit('meta', { projectId, mode: detectPatchMode({ existingFiles, prompt }) ? 'patch' : 'fresh' });

  const isPatch = detectPatchMode({ existingFiles, prompt });

  // -------------------- Brief + Architect (только в fresh-mode) --------------------
  let brief = null;
  let plan = null;
  if (!isPatch) {
    const briefResult = await runBrief({ prompt, model, projectId, bus });
    brief = briefResult.brief;
    addUsage(briefResult.usage);

    const archResult = await runArchitect({ brief, model, projectId, bus, rawPrompt: prompt });
    plan = archResult.plan;
    addUsage(archResult.usage);
  } else {
    bus.skipPhase('brief', 'patch-mode');
    bus.skipPhase('architect', 'patch-mode');
  }

  // -------------------- React-bundle init (если выбран) --------------------
  // Если архитектор решил kind=react-bundle и проект пуст (fresh), разворачиваем
  // шаблон + пишем meta.json. Coder потом редактирует только src/*. После Coder
  // мы автоматически вызовем rebuild_bundle.
  let isBundle = false;
  if (!isPatch && plan?.kind === 'react-bundle') {
    bus.startPhase('bundle.init', 'Инициализация react-bundle');
    try {
      await initReactBundleTemplate(projectDir, { override: false });
      // meta.json — отдельно пишем kind, остальные поля заполнит writeProject
      const metaPath = path.join(projectDir, 'meta.json');
      let metaCur = {};
      try { metaCur = JSON.parse(await fs.readFile(metaPath, 'utf8')); } catch {}
      metaCur.kind = 'react-bundle';
      await fs.writeFile(metaPath, JSON.stringify(metaCur, null, 2), 'utf8');
      isBundle = true;
      bus.donePhase('bundle.init', { kind: 'react-bundle' });
    } catch (e) {
      bus.warn(`Не удалось развернуть react-bundle template: ${e?.message || e}. Понижаю до static.`);
      plan.kind = 'static';
    }
  } else if (isPatch) {
    // В patch-mode проверяем по существующему meta.json
    isBundle = await isBundleProject(projectDir);
  }

  // -------------------- Context7 (по плану) --------------------
  let contextDocs = '';
  let context7Used = [];
  bus.startPhase('context7', 'Контекст библиотек');
  try {
    if (isContext7Enabled()) {
      const libs = !isPatch && plan?.needsContext7?.length
        ? plan.needsContext7
        : (await detectLibsFromExisting(projectDir, existingFiles));
      if (libs && libs.length) {
        const ctx = await buildContextBlockForLibraries(libs, {
          perLibChars: 1500, totalCharsBudget: 4500,
        });
        if (ctx?.block) {
          contextDocs = ctx.block;
          context7Used = ctx.used;
          bus.donePhase('context7', { libraries: ctx.used.map((u) => u.name), chars: ctx.totalChars });
        } else {
          bus.donePhase('context7', { libraries: [], chars: 0 });
        }
      } else {
        bus.skipPhase('context7', 'нет подходящих библиотек');
      }
    } else {
      bus.skipPhase('context7', 'CONTEXT7_API_KEY не настроен');
    }
  } catch (e) {
    bus.warn(`Context7 упал: ${e?.message || e}`);
    bus.donePhase('context7', { libraries: [], chars: 0, error: e?.message });
  }

  // -------------------- Coder --------------------
  // Coder может упасть после частичной работы (network drop / TPM limit).
  // Не теряем уже записанные на диск файлы — продолжаем со smoke/autofix
  // на том, что есть. Юзер увидит результат + чёткое сообщение что произошло.
  let coderResult;
  let coderInterruptedError = null;
  try {
    coderResult = await runCoder({
      prompt,
      brief,
      plan,
      mode: isPatch ? 'patch' : 'fresh',
      projectDir,
      projectId,
      model,
      siteSystemPrompt,
      existingFiles,
      bus,
      smokeRunner,
      contextDocs,
    });
  } catch (e) {
    if (e?.streamPartial) {
      coderInterruptedError = e;
      bus.warn(`Coder прервал работу (${e.code || 'unknown'}): ${e.message}. Проверяю что успело написаться.`);
      // Пробуем продолжить со smoke на том, что есть на диске
      coderResult = {
        ok: false,
        finished: false,
        classicText: '',
        modelUsed: e.modelUsed || model,
        usage: { input: 0, output: 0, total: 0 },
        iterations: 0,
        toolCallLog: [],
        smoke: null,
        message: `Прервано: ${e.message}`,
        interrupted: true,
        interruptError: { code: e.code, message: e.message, errors: e.errors || [] },
      };
    } else {
      throw e; // не-частичная ошибка — бросаем дальше
    }
  }
  addUsage(coderResult.usage);

  const recoverBlob = coderResult.classicText || coderResult.residualAssistantText || '';
  await tryRecoverFilesFromCoderAssistantText(bus, projectDir, recoverBlob);

  // Если модель работала в classic-режиме (без tools) — нам надо снаружи разобрать
  // её ответ через extractFiles. Здесь возвращаем сырой текст; обработка снаружи
  // (в server.js — там же существующая логика валидации).
  if (coderResult.classicText) {
    return {
      ok: true,
      mode: isPatch ? 'patch' : 'fresh',
      classicText: coderResult.classicText,
      brief,
      plan,
      modelUsed: coderResult.modelUsed,
      fallbackFrom: null,
      usage: totalUsage,
      context7Used,
      smoke: null,
      suggestions: [],
      autofix: null,
      toolCallLog: [],
    };
  }

  // -------------------- Auto-rebuild для react-bundle --------------------
  // Если это react-bundle и Coder не вызывал rebuild_bundle сам — делаем форсированно.
  // Smoke без rebuild смотрит на старый dist (или его отсутствие) → битый превью.
  if (isBundle) {
    const calledRebuild = (coderResult.toolCallLog || []).some((t) => t.name === 'rebuild_bundle');
    if (!calledRebuild) {
      bus.startPhase('bundle.rebuild', 'Сборка react-bundle');
      try {
        const buildResult = await buildBundle(projectDir);
        bus.donePhase('bundle.rebuild', {
          ok: buildResult.ok,
          durationMs: buildResult.durationMs,
          errors: (buildResult.errors || []).slice(0, 3),
        });
        if (!buildResult.ok) {
          // Если сборка упала — отмечаем как смок-ошибку
          coderResult.smoke = {
            ok: false,
            errors: ['Bundle build failed:', ...(buildResult.errors || [])],
            warnings: buildResult.warnings || [],
            runner: 'esbuild',
          };
        }
      } catch (e) {
        bus.errorPhase('bundle.rebuild', e?.message || String(e));
      }
    }
  }

  // -------------------- Smoke + Autofix --------------------
  let smoke = coderResult.smoke;
  let autofixResult = null;

  // Если Coder не сделал run_smoke сам — делаем форсированно (через те же tools)
  if (!smoke) {
    // Для react-bundle smoke смотрит на dist/index.html, для static — на корневой.
    const indexAbs = isBundle
      ? path.join(projectDir, 'dist', 'index.html')
      : path.join(projectDir, 'index.html');
    const indexExists = await fs.access(indexAbs).then(() => true).catch(() => false);
    if (indexExists) {
      bus.startPhase('smoke', 'Smoke-тест');
      try {
        const indexHtml = await fs.readFile(indexAbs, 'utf8');
        const { smokeDiskBundles } = await import('../smoke/disk-bundle.js');
        const disk = await smokeDiskBundles(projectDir, indexAbs, indexHtml);
        if (!disk.ok) {
          smoke = {
            ok: false,
            errors: disk.errors,
            warnings: [],
            runner: 'disk',
          };
        } else if (typeof smokeRunner === 'function') {
          try { smoke = await smokeRunner(projectDir, indexHtml); } catch (e) { bus.warn('Playwright fail: ' + (e?.message || e)); }
        }
        if (!smoke) {
          const { smokeTestHtml } = await import('../runtime-smoke.js');
          smoke = await smokeTestHtml(indexHtml, { requireBodyContent: true });
          smoke.runner = 'jsdom';
        } else {
          smoke.runner = smoke.runner || 'playwright';
        }
        bus.donePhase('smoke', { ok: smoke.ok, runner: smoke.runner, errors: (smoke.errors || []).slice(0, 3) });
      } catch (e) {
        bus.errorPhase('smoke', e?.message || String(e));
        smoke = { ok: false, errors: ['smoke crashed: ' + (e?.message || e)], warnings: [] };
      }
    } else {
      bus.skipPhase('smoke', 'нет index.html');
    }
  }

  if (smoke && !smoke.ok) {
    autofixResult = await runAutofix({
      smoke,
      brief,
      plan,
      projectDir,
      projectId,
      model,
      siteSystemPrompt,
      existingFiles: await listProjectFilesRecursive(projectDir),
      bus,
      smokeRunner,
    });
    if (autofixResult.lastResult) addUsage(autofixResult.lastResult.usage);
    if (autofixResult.smoke) smoke = autofixResult.smoke;
  }

  // -------------------- Post-Context7 (по фактически использованным libs) --------------------
  // Если Coder в коде использовал библиотеки, которых не было в needsContext7,
  // и есть смысл их подсветить — мы это делаем как warning (не повторный круг).
  try {
    const allFiles = await readProjectFiles(projectDir);
    const usedLibs = detectLibrariesInFiles(allFiles);
    const newLibs = usedLibs.filter((l) => !context7Used.find((u) => u.name === l));
    if (newLibs.length) {
      bus.warn(`Coder использовал дополнительно: ${newLibs.join(', ')} (без явного Context7-lookup).`);
    }
  } catch {}

  // -------------------- Reviewer (если smoke ok) --------------------
  let suggestions = [];
  let reviewerRating = null;
  try {
    const indexAbs = path.join(projectDir, 'index.html');
    const indexHtml = await fs.readFile(indexAbs, 'utf8').catch(() => '');
    if (indexHtml && smoke?.ok) {
      const r = await runReviewer({ prompt, indexHtml, model, projectId, bus });
      addUsage(r.usage);
      suggestions = r.suggestions;
      reviewerRating = r.rating;
    } else {
      bus.skipPhase('reviewer', smoke?.ok ? 'нет index.html' : 'smoke не ok');
    }
  } catch (e) {
    bus.warn(`Reviewer упал: ${e?.message || e}`);
  }

  return {
    ok: !!smoke?.ok && !coderInterruptedError,
    mode: isPatch ? 'patch' : 'fresh',
    brief,
    plan,
    smoke,
    autofix: autofixResult,
    suggestions,
    reviewerRating,
    modelUsed: coderResult.modelUsed,
    fallbackFrom: coderResult.fallbackFrom ?? null,
    usage: totalUsage,
    context7Used,
    finishedMessage: coderResult.message || '',
    toolCallLog: coderResult.toolCallLog || [],
    iterations: coderResult.iterations,
    interrupted: coderResult.interrupted || false,
    interruptError: coderResult.interruptError || null,
  };
}

// =============================================================
// Хелперы
// =============================================================

async function listProjectFilesRecursive(dir) {
  const out = [];
  async function walk(rel) {
    const abs = path.join(dir, rel);
    let entries;
    try { entries = await fs.readdir(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'meta.json') continue;
      const sub = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(sub);
      else out.push(sub);
    }
  }
  await walk('');
  return out.sort();
}

async function readProjectFiles(dir) {
  const list = await listProjectFilesRecursive(dir);
  const out = {};
  for (const rel of list) {
    try { out[rel] = await fs.readFile(path.join(dir, rel), 'utf8'); } catch {}
  }
  return out;
}

async function detectLibsFromExisting(projectDir, existingFiles) {
  if (!existingFiles?.length) return [];
  try {
    const files = await readProjectFiles(projectDir);
    return detectLibrariesInFiles(files).slice(0, 3);
  } catch {
    return [];
  }
}
