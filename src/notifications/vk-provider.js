// Отправка личного сообщения пользователю VK через messages.send (user access_token с правом messages).

export async function sendVkUserMessage({ accessToken, userId, message }) {
  const token = String(accessToken || '').trim();
  const uid = String(userId || '').trim();
  if (!token || !uid) throw new Error('vk: не заданы access_token или user_id');

  const random_id = Math.floor(Math.random() * 2_000_000_000);
  const params = new URLSearchParams({
    access_token: token,
    v: '5.131',
    user_id: uid,
    message: String(message).slice(0, 4096),
    random_id: String(random_id),
  });
  const r = await fetch(`https://api.vk.com/method/messages.send?${params}`);
  const j = await r.json().catch(() => ({}));
  if (j.error) {
    throw new Error(`vk: ${j.error.error_msg || j.error.error_code || 'api error'}`);
  }
  if (j.response === undefined) throw new Error('vk: пустой ответ API');
}
