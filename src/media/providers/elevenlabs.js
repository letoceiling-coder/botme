/**
 * Минимальный клиент ElevenLabs API для AI Media Studio.
 *
 * Документация:
 *   - TTS:    https://elevenlabs.io/docs/api-reference/text-to-speech
 *   - Voices: https://elevenlabs.io/docs/api-reference/voices/get-all
 *
 * Используем endpoint /v1/text-to-speech/{voice_id} с не-streaming ответом —
 * возвращает audio/mpeg, который мы скачиваем и кладём в папку проекта.
 */

import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://api.elevenlabs.io/v1';

/** Базовый набор «системных» голосов ElevenLabs (id неизменны). */
export const ELEVENLABS_VOICES = [
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel',   description: 'мягкий женский, нейтральный' },
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam',     description: 'глубокий мужской, рассказчик' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella',    description: 'молодой женский, дружелюбный' },
  { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni',   description: 'тёплый мужской, ровный' },
  { id: 'AZnzlk1HvdrSU8DSDx0M', name: 'Domi',     description: 'женский, эмоциональный' },
  { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli',     description: 'женский, тёплый' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh',     description: 'мужской, разговорный' },
  { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold',   description: 'мужской, с харизмой' },
];

export const ELEVENLABS_MODELS = [
  { id: 'eleven_multilingual_v2',   label: 'Multilingual v2 — лучшее качество' },
  { id: 'eleven_turbo_v2_5',        label: 'Turbo v2.5 — быстро + дёшево' },
  { id: 'eleven_flash_v2_5',        label: 'Flash v2.5 — самая быстрая' },
];

function key() {
  return (process.env.ELEVENLABS_API_KEY || '').trim();
}

export function isElevenLabsConfigured() {
  return !!key();
}

/**
 * Запускает синтез речи и записывает MP3 в файл по абсолютному пути.
 * Возвращает { filePath, charsBilled, model, voiceId }.
 */
export async function synthesizeTTS({ text, voiceId, modelId, outputDir, filename }) {
  if (!key()) throw new Error('ELEVENLABS_API_KEY не задан в .env');
  if (!text || !String(text).trim()) throw new Error('Пустой текст для озвучки.');
  const url = `${BASE}/text-to-speech/${encodeURIComponent(voiceId)}`;

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': key(),
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
      // Cloudflare у api.elevenlabs.io отбивает запросы без User-Agent.
      // Node-овский fetch (undici) не ставит UA по умолчанию → 403.
      'User-Agent': 'Botme-MediaStudio/1.0 (+https://botme.neeklo.ru)',
    },
    body: JSON.stringify({
      text: String(text),
      model_id: modelId,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: true,
      },
    }),
  });

  if (!r.ok) {
    const txt = await r.text();
    const err = new Error(`ElevenLabs ${r.status}: ${txt.slice(0, 400)}`);
    err.status = r.status;
    err.body = txt;
    throw err;
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const buf = Buffer.from(await r.arrayBuffer());
  const full = path.join(outputDir, filename);
  fs.writeFileSync(full, buf);

  // Заголовок 'character-cost' возвращается ElevenLabs в meta-headers
  // (зависит от ответа API). Если не пришёл — считаем по длине текста.
  const charsBilled = Number(r.headers.get('character-cost')) || String(text).length;

  return { filePath: full, charsBilled, model: modelId, voiceId, bytes: buf.length };
}

/** Список доступных голосов из аккаунта (если ключ задан). */
export async function listVoices() {
  if (!key()) return ELEVENLABS_VOICES;
  try {
    const r = await fetch(`${BASE}/voices`, {
      headers: {
        'xi-api-key': key(),
        'User-Agent': 'Botme-MediaStudio/1.0 (+https://botme.neeklo.ru)',
      },
    });
    if (!r.ok) return ELEVENLABS_VOICES;
    const d = await r.json();
    const fromApi = (d.voices || []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      description: v.labels?.descriptive || v.category || '',
    }));
    // Если в аккаунте нет своих голосов — отдадим системные.
    return fromApi.length ? fromApi : ELEVENLABS_VOICES;
  } catch {
    return ELEVENLABS_VOICES;
  }
}
