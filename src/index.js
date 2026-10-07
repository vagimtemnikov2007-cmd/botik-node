import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import pino from 'pino';
import { loadConfig } from './config.js';
import { createBot } from './bot.js';
import { TTLCache } from './state.js';
import { runProcess } from './process.js';
import { errorDetails } from './diagnostics.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel });
const { bot, queue } = createBot(config, logger);
let ready = false;
const processedUpdates = new TTLCache(10000, 86400000);
const incomingUpdates = new Map();
const server = createServer(async (req, res) => {
  const respond = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && req.url === '/healthz') return respond(ready ? 200 : 503, { ok: ready, jobs: queue.size });
  if (req.method !== 'POST' || req.url !== '/telegram' || !config.webhookUrl) return respond(404, { error: 'Not found' });
  const provided = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] || ''));
  const expected = Buffer.from(config.webhookSecret);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return respond(403, { error: 'Forbidden' });
  if (!ready) return respond(503, { error: 'Starting' });
  try {
    let bytes = 0; const chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) return respond(413, { error: 'Too large' });
      chunks.push(chunk);
    }
    const update = JSON.parse(Buffer.concat(chunks).toString());
    if (!Number.isSafeInteger(update.update_id)) return respond(400, { error: 'Invalid update' });
    // Acknowledge only after lightweight handlers have accepted work into the queue.
    if (!processedUpdates.get(update.update_id)) {
      let pending = incomingUpdates.get(update.update_id);
      if (!pending) {
        pending = bot.handleUpdate(update).then(() => processedUpdates.set(update.update_id, true));
        incomingUpdates.set(update.update_id, pending);
      }
      try { await pending; } finally { incomingUpdates.delete(update.update_id); }
    }
    respond(200, { ok: true });
  } catch { respond(400, { error: 'Invalid request' }); }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '0.0.0.0', resolve); });
const commands = [
  ['help', 'Помощь и поддерживаемые платформы'], ['quality', 'Выбор качества видео'], ['audio', 'MP3 по ссылке'],
  ['music', 'Поиск музыки'], ['cancel', 'Отмена задач'], ['status', 'Состояние очереди'], ['id', 'Telegram ID'],
].map(([command, description]) => ({ command, description }));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true; ready = false;
  logger.info('Stopping bot');
  const deadline = setTimeout(() => process.exit(1), 15000); deadline.unref();
  const closed = new Promise(resolve => server.close(resolve));
  if (bot.isRunning()) await bot.stop();
  await queue.close();
  await closed;
  clearTimeout(deadline);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
try {
  for (const [tool, command, args] of [
    ['yt-dlp', config.ytdlp, ['--ignore-config', '--version']],
    ['FFmpeg', config.ffmpeg, ['-version']],
    ['FFprobe', config.ffprobe, ['-version']],
  ]) {
    try {
      const output = await runProcess(command, args, { timeoutMs: 10000 });
      logger.info({ tool, version: output.split('\n')[0], nodeVersion: process.version }, 'Media tool available');
    } catch (error) {
      logger.error({ tool, details: errorDetails(error, config) }, 'Media tool unavailable');
      throw error;
    }
  }
  await bot.init();
  await bot.api.setMyCommands(commands);
  if (config.webhookUrl) {
    await bot.api.setWebhook(`${config.webhookUrl.replace(/\/$/, '')}/telegram`, {
      secret_token: config.webhookSecret, allowed_updates: ['message', 'channel_post', 'callback_query'], max_connections: 10,
    });
    ready = true; logger.info('Webhook bot started');
  } else {
    await bot.api.deleteWebhook();
    await bot.start({ allowed_updates: ['message', 'channel_post', 'callback_query'], onStart: () => { ready = true; logger.info('Polling bot started'); } });
  }
} catch (error) {
  logger.error({ name: error.name }, 'Bot startup failed. Check token and network access.');
  await shutdown(); process.exitCode = 1;
}
