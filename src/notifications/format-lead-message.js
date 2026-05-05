// Текст уведомления о новом лиде (общий для всех каналов).

export function formatLeadSource(metaJson) {
  if (!metaJson) return '—';
  try {
    const m = JSON.parse(metaJson);
    if (m.source === 'api') return 'виджет / API';
    if (m.source === 'admin') return 'админ-чат';
    if (m.source === 'admin') return 'админ-чат';
    return String(m.source || '—');
  } catch {
    return '—';
  }
}

export function formatLeadNotificationBody(lead) {
  const source = formatLeadSource(lead.meta_json);
  return [
    'Новый лид',
    `Имя: ${lead.name || '—'}`,
    `Телефон: ${lead.phone || '—'}`,
    `Email: ${lead.email || '—'}`,
    `Сообщение: ${lead.message || '—'}`,
    `Источник: ${source}`,
  ].join('\n');
}
