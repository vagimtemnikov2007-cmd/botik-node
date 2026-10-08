import { fetchText } from './network.js';

export function durationSeconds(value) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value || '');
  if (!match || !match.slice(1).some(v => v !== undefined)) throw new Error('Некорректная длительность YouTube.');
  return Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0);
}

export async function youtubeMetadata(id, apiKey, signal, request = fetchText) {
  if (!/^[\w-]{11}$/.test(id || '')) throw new Error('Некорректный ID YouTube.');
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.search = new URLSearchParams({ part: 'snippet,contentDetails', id, key: apiKey }).toString();
  let data;
  try {
    data = JSON.parse(await request(url.href, {
      domains: ['www.googleapis.com'],
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    }));
  } catch {
    signal.throwIfAborted();
    // Do not propagate transport errors containing the API key.
    throw new Error('YouTube Data API недоступен. Проверьте ключ, включение API и квоту.');
  }
  if (!Array.isArray(data.items)) throw new Error('Некорректный ответ YouTube Data API.');
  const video = data.items.find(item => item.id === id);
  if (!video) throw new Error('Видео недоступно через YouTube Data API.');
  return {
    title: video.snippet?.title,
    duration: durationSeconds(video.contentDetails?.duration),
    is_live: ['live', 'upcoming'].includes(video.snippet?.liveBroadcastContent),
  };
}
