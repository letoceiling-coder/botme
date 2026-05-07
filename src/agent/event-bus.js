// Event-bus агента генерации сайтов.
//
// Минималистичный pub/sub: одна шина на одну сессию (один HTTP-запрос
// /api/generate/stream). Сервер транслирует все события в SSE-поток клиенту,
// клиент на основе них рисует таймлайн фаз.
//
// Стандартизованный набор event-типов (используется в orchestrator/stages
// и в SSE-эндпоинте; новые добавляем сюда же, не переизобретаем):
//
//   phase.start      { phase, label }
//   phase.done       { phase, ms, summary? }
//   phase.error      { phase, message, code? }
//   phase.skip       { phase, reason }
//   tool.call        { name, args, callId }
//   tool.result      { name, callId, ok, summary?, error? }
//   coder.token      { delta }                  // стриминг текста модели
//   coder.message    { text }                   // финальный текст шага
//   smoke.issue      { kind, severity, message } // pageerror/requestfailed/etc
//   smoke.screenshot { path }
//   reviewer.suggestion { index, title, why, how }
//   meta             { projectId, kind, ... }   // прочие контекстные поля
//   warn             { message }
//   done             { result }                 // финальный payload
//   error            { message, code? }         // фатальная ошибка
//
// Принципы:
//   - Все handler'ы синхронные. Если нужен I/O — используйте setImmediate сами.
//   - Ошибки в подписчике не должны валить эмиттер — ловим try/catch.
//   - off() вызывают редко, поэтому массив подписчиков, не Set.

export class EventBus {
  constructor() {
    this._subs = []; // [{ type, fn }] — type === '*' значит слушать всё
    this._closed = false;
  }

  on(type, fn) {
    this._subs.push({ type, fn });
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this._subs = this._subs.filter((s) => !(s.type === type && s.fn === fn));
  }

  emit(type, payload = {}) {
    if (this._closed) return;
    const ev = { type, ts: Date.now(), ...payload };
    for (const sub of this._subs) {
      if (sub.type !== type && sub.type !== '*') continue;
      try {
        sub.fn(ev);
      } catch (e) {
        // Никогда не даём подписчику завалить шину
        // eslint-disable-next-line no-console
        console.warn('[event-bus] subscriber error:', e?.message || e);
      }
    }
  }

  // Хелперы для частых событий — короче и читаемее в коде стадий.
  startPhase(phase, label) {
    this._phaseTimers ||= new Map();
    this._phaseTimers.set(phase, Date.now());
    this.emit('phase.start', { phase, label: label || phase });
  }

  donePhase(phase, summary) {
    const t0 = this._phaseTimers?.get(phase);
    const ms = t0 ? Date.now() - t0 : 0;
    this._phaseTimers?.delete(phase);
    this.emit('phase.done', { phase, ms, summary });
  }

  errorPhase(phase, message, code) {
    const t0 = this._phaseTimers?.get(phase);
    const ms = t0 ? Date.now() - t0 : 0;
    this._phaseTimers?.delete(phase);
    this.emit('phase.error', { phase, ms, message: String(message || ''), code });
  }

  skipPhase(phase, reason) {
    this.emit('phase.skip', { phase, reason });
  }

  toolCall(name, args, callId) {
    this.emit('tool.call', { name, args, callId });
  }

  toolResult(name, callId, ok, summary, error) {
    this.emit('tool.result', { name, callId, ok, summary, error });
  }

  warn(message) {
    this.emit('warn', { message: String(message || '') });
  }

  done(result) {
    this.emit('done', { result });
    this._closed = true;
  }

  fail(message, code) {
    this.emit('error', { message: String(message || ''), code });
    this._closed = true;
  }
}
