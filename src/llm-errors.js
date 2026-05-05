/**
 * Классификация ошибок провайдеров LLM (OpenAI / Anthropic / Gemini / Ollama / OpenRouter).
 *
 * На вход — что бросил SDK или fetch. На выход — нормализованная структура:
 *   {
 *     kind:        'auth' | 'quota' | 'rate_limit' | 'overloaded' | 'bad_request'
 *                | 'not_found' | 'context_overflow' | 'content_filter'
 *                | 'network' | 'timeout' | 'aborted' | 'unknown',
 *     status:      number | null,
 *     retryable:   bool,   // имеет смысл повторить ту же модель
 *     skipProvider:bool,   // нет смысла пробовать другие модели этого провайдера
 *     userMessage: string, // короткое объяснение для UI
 *     raw:         string, // оригинальное сообщение
 *   }
 */

const KIND_LABELS = {
  auth: 'Ключ API не настроен или отклонён',
  quota: 'Закончился баланс/квота у провайдера',
  rate_limit: 'Превышен лимит запросов в минуту',
  overloaded: 'Сервис провайдера перегружен',
  bad_request: 'Провайдер отклонил запрос',
  not_found: 'Модель не найдена у провайдера',
  context_overflow: 'Превышен размер контекста',
  content_filter: 'Запрос отклонён фильтром безопасности',
  network: 'Сбой сети до провайдера',
  timeout: 'Истекло время ожидания ответа модели',
  aborted: 'Запрос отменён',
  unknown: 'Неизвестная ошибка модели',
};

export function userMessageForKind(kind) {
  return KIND_LABELS[kind] || KIND_LABELS.unknown;
}

function pickStatus(e) {
  if (typeof e?.status === 'number') return e.status;
  if (typeof e?.statusCode === 'number') return e.statusCode;
  if (typeof e?.response?.status === 'number') return e.response.status;
  if (typeof e?.code === 'number') return e.code;
  return null;
}

function pickMessage(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  return (
    e.error?.message
    || e.error?.error?.message
    || e.response?.data?.error?.message
    || e.message
    || String(e)
  );
}

function pickErrorType(e) {
  return (
    e?.error?.type
    || e?.error?.error?.type
    || e?.code
    || e?.name
    || ''
  ).toString().toLowerCase();
}

/**
 * @param {unknown} e
 * @returns {{
 *   kind: string,
 *   status: number|null,
 *   retryable: boolean,
 *   skipProvider: boolean,
 *   userMessage: string,
 *   raw: string,
 * }}
 */
export function classifyLlmError(e) {
  const status = pickStatus(e);
  const raw = pickMessage(e);
  const lc = raw.toLowerCase();
  const errType = pickErrorType(e);
  const errCode = (e?.code || '').toString().toLowerCase();

  // Явная отмена / таймаут (наш AbortController)
  if (errType === 'aborterror' || errCode === 'abort_err' || lc.includes('aborted')) {
    if (e?._botmeTimeout === true || lc.includes('timeout')) {
      return mk('timeout', status, raw, { retryable: true, skipProvider: false });
    }
    return mk('aborted', status, raw, { retryable: false, skipProvider: false });
  }

  // Сетевые ошибки уровня node
  if (
    ['enotfound', 'eai_again', 'econnreset', 'econnrefused', 'etimedout', 'eai_fail', 'epipe', 'esockettimedout'].includes(errCode)
    || lc.includes('fetch failed')
    || lc.includes('socket hang up')
  ) {
    return mk('network', status, raw, { retryable: true, skipProvider: false });
  }

  // Status-based классификация
  if (status === 401 || status === 403) {
    return mk('auth', status, raw, { retryable: false, skipProvider: true });
  }
  if (status === 402 || /insufficient[_ ]?(funds|quota|credit)/i.test(raw) || lc.includes('billing') || lc.includes('balance')) {
    return mk('quota', status, raw, { retryable: false, skipProvider: true });
  }
  if (status === 429) {
    return mk('rate_limit', status, raw, { retryable: true, skipProvider: false });
  }
  if (status === 408) {
    return mk('timeout', status, raw, { retryable: true, skipProvider: false });
  }
  if (status === 404) {
    return mk('not_found', status, raw, { retryable: false, skipProvider: false });
  }
  if (status === 529 || /overload|temporarily unavailable|service unavailable/i.test(raw)) {
    return mk('overloaded', status, raw, { retryable: true, skipProvider: false });
  }
  if (status && status >= 500 && status < 600) {
    return mk('overloaded', status, raw, { retryable: true, skipProvider: false });
  }
  if (status === 400) {
    if (/context|too long|maximum context|max_tokens|token limit/i.test(raw)) {
      return mk('context_overflow', status, raw, { retryable: false, skipProvider: false });
    }
    if (/safety|content[_ ]?filter|blocked/i.test(raw)) {
      return mk('content_filter', status, raw, { retryable: false, skipProvider: false });
    }
    return mk('bad_request', status, raw, { retryable: false, skipProvider: false });
  }

  // Текстовые маркеры от Anthropic / OpenAI / Gemini
  if (/api key|unauthorized|invalid_api_key|authentication/i.test(raw)) {
    return mk('auth', status, raw, { retryable: false, skipProvider: true });
  }
  if (/rate.?limit|too many requests/i.test(raw)) {
    return mk('rate_limit', status, raw, { retryable: true, skipProvider: false });
  }
  if (/overloaded|busy/i.test(raw)) {
    return mk('overloaded', status, raw, { retryable: true, skipProvider: false });
  }
  if (/safety|content[_ ]?filter|blocked.*?prompt/i.test(raw)) {
    return mk('content_filter', status, raw, { retryable: false, skipProvider: false });
  }
  if (/not found|does not exist|unknown model/i.test(raw)) {
    return mk('not_found', status, raw, { retryable: false, skipProvider: false });
  }

  return mk('unknown', status, raw, { retryable: true, skipProvider: false });
}

function mk(kind, status, raw, { retryable, skipProvider }) {
  return {
    kind,
    status,
    retryable: !!retryable,
    skipProvider: !!skipProvider,
    userMessage: KIND_LABELS[kind] || KIND_LABELS.unknown,
    raw: typeof raw === 'string' ? raw.slice(0, 500) : '',
  };
}

/** Короткая строка для логов: "rate_limit/429 — too many requests…" */
export function shortErrorLine(info) {
  const tail = info.raw ? ` — ${info.raw.slice(0, 160)}` : '';
  return `${info.kind}${info.status ? '/' + info.status : ''}${tail}`;
}
