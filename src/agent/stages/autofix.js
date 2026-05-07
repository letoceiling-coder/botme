// Autofix stage: если smoke упал — формируем прицельный prompt с конкретными
// ошибками и запускаем Coder в patch-режиме. До 2 итераций, чтобы не зацикливаться.

import { runCoder } from './coder.js';

function buildAutofixPrompt(smoke) {
  const lines = [];
  lines.push('Smoke-тест собранного index.html нашёл проблемы:');
  if (Array.isArray(smoke.errors) && smoke.errors.length) {
    lines.push('\nОШИБКИ:');
    for (const e of smoke.errors.slice(0, 8)) {
      lines.push(`  • ${typeof e === 'string' ? e : (e.message || JSON.stringify(e))}`);
    }
  }
  if (Array.isArray(smoke.warnings) && smoke.warnings.length) {
    lines.push('\nПРЕДУПРЕЖДЕНИЯ:');
    for (const w of smoke.warnings.slice(0, 5)) {
      lines.push(`  • ${typeof w === 'string' ? w : (w.message || JSON.stringify(w))}`);
    }
  }
  if (Array.isArray(smoke.failedRequests) && smoke.failedRequests.length) {
    lines.push('\nУПАВШИЕ HTTP-ЗАПРОСЫ:');
    for (const r of smoke.failedRequests.slice(0, 5)) {
      lines.push(`  • ${typeof r === 'string' ? r : (r.url || JSON.stringify(r))}`);
    }
  }
  lines.push('');
  lines.push('Задача: исправить ИМЕННО ЭТИ ошибки через apply_patch (или write_file для полной замены, если правка в одном файле большая).');
  lines.push('После правок вызови run_smoke и убедись, что всё чисто. Затем finish_generation.');
  lines.push('Не переписывай файлы, которые не связаны с этими ошибками.');
  return lines.join('\n');
}

export async function runAutofix({
  smoke,
  brief,
  plan,
  projectDir,
  projectId,
  model,
  siteSystemPrompt,
  existingFiles,
  bus,
  smokeRunner,
  maxRounds = 2,
}) {
  bus.startPhase('autofix', 'Автопочинка');
  let currentSmoke = smoke;
  let lastResult = null;
  let attempts = 0;

  while (attempts < maxRounds && currentSmoke && !currentSmoke.ok) {
    attempts += 1;
    const prompt = buildAutofixPrompt(currentSmoke);
    try {
      lastResult = await runCoder({
        prompt,
        brief,
        plan,
        mode: 'patch',
        projectDir,
        projectId,
        model,
        siteSystemPrompt,
        existingFiles,
        bus,
        smokeRunner,
      });
      currentSmoke = lastResult.smoke;
      if (currentSmoke?.ok) break;
    } catch (e) {
      bus.warn(`Autofix round ${attempts} упал: ${e?.message || e}`);
      break;
    }
  }

  if (currentSmoke?.ok) {
    bus.donePhase('autofix', { rounds: attempts, fixed: true });
  } else {
    bus.donePhase('autofix', { rounds: attempts, fixed: false });
  }
  return {
    rounds: attempts,
    fixed: !!currentSmoke?.ok,
    smoke: currentSmoke,
    lastResult,
  };
}
