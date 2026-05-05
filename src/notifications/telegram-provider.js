export async function sendTelegramMessage({ botToken, chatId, text }) {
  const token = String(botToken || '').trim();
  const chat = String(chatId || '').trim();
  if (!token || !chat) throw new Error('telegram: не заданы bot_token или chat_id');

  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chat,
      text,
      disable_web_page_preview: true,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) {
    const desc = j.description || r.statusText || 'request failed';
    throw new Error(`telegram: ${desc}`);
  }
}
