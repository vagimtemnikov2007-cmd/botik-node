import { resolve } from 'node:path';

export function loadConfig(env = process.env) {
  const number = (key, fallback, min, max) => {
    const value = Number(env[key] || fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Некорректный ${key}: ${min}..${max}`);
    return value;
  };
  const token = env.BOT_TOKEN;
  if (!token || !/^\d+:[\w-]+$/.test(token)) throw new Error('Укажите BOT_TOKEN в .env');
  const webhookUrl = env.WEBHOOK_URL || '';
  const webhookSecret = env.WEBHOOK_SECRET || '';
  if (webhookUrl && (new URL(webhookUrl).protocol !== 'https:' || !/^[\w-]{16,256}$/.test(webhookSecret))) {
    throw new Error('Webhook требует HTTPS URL и WEBHOOK_SECRET длиной 16..256 символов');
  }
  const quality = String(env.DEFAULT_QUALITY || '720');
  if (!['360', '720', '1080'].includes(quality)) throw new Error('DEFAULT_QUALITY: 360, 720 или 1080');
  const allowedUsers = (env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowedUsers.some(id => !/^\d+$/.test(id))) throw new Error('ALLOWED_USERS должен содержать числовые ID');
  return {
    token, webhookUrl, webhookSecret, quality, allowedUsers: new Set(allowedUsers),
    port: number('PORT', 8000, 1, 65535), concurrency: number('CONCURRENCY', 2, 1, 8),
    maxQueue: number('MAX_QUEUE', 30, 1, 1000), cooldownMs: number('USER_COOLDOWN_SECONDS', 10, 0, 3600) * 1000,
    maxBytes: number('MAX_FILE_MB', 49, 1, 49) * 1024 * 1024,
    maxDuration: number('MAX_DURATION_SECONDS', 1800, 1, 14400),
    timeoutMs: number('JOB_TIMEOUT_SECONDS', 300, 10, 1800) * 1000,
    maxLinks: number('MAX_LINKS', 3, 1, 10), maxItems: number('MAX_ITEMS', 10, 1, 20),
    ytdlp: env.YTDLP_PATH || 'yt-dlp', ffmpeg: env.FFMPEG_PATH || 'ffmpeg', ffprobe: env.FFPROBE_PATH || 'ffprobe',
    cookies: env.COOKIES_FILE ? resolve(env.COOKIES_FILE) : '', logLevel: env.LOG_LEVEL || 'info',
  };
}
