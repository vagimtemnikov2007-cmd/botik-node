import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createBot } from '../src/bot.js';
import { loadConfig } from '../src/config.js';

const logger = { warn() {}, error() {}, info() {} };
function harness(service, extra = {}) {
  const config = loadConfig({ BOT_TOKEN: '123:fake', USER_COOLDOWN_SECONDS: '0', ...extra });
  const { bot, queue } = createBot(config, logger, service);
  bot.botInfo = { id: 123, is_bot: true, first_name: 'Botik', username: 'botik_test_bot' };
  const calls = []; let messageId = 100;
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload });
    const message = { message_id: messageId++, date: 1, chat: { id: payload.chat_id, type: 'private' } };
    if (method === 'sendPhoto') message.photo = [{ file_id: 'photo-cache', width: 100, height: 100 }];
    if (method === 'sendVideo') message.video = { file_id: 'video-cache' };
    if (method === 'sendAudio') message.audio = { file_id: 'audio-cache' };
    if (method === 'sendMediaGroup') return { ok: true, result: payload.media.map((item, i) => ({ ...message, message_id: message.message_id + i,
      ...(item.type === 'photo' ? { photo: [{ file_id: `photo-${i}`, width: 100, height: 100 }] } : { video: { file_id: `video-${i}` } }),
    })) };
    return { ok: true, result: method === 'answerCallbackQuery' ? true : message };
  });
  let updateId = 1;
  const update = (text, user = 1) => bot.handleUpdate({ update_id: updateId++, message: {
    message_id: updateId, date: 1, chat: { id: 1, type: 'private' }, from: { id: user, is_bot: false, first_name: 'User' }, text,
    ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}),
  } });
  async function drain() {
    for (let i = 0; i < 100; i++) {
      if (!queue.size) { await delay(2); return; }
      await delay(5);
    }
    throw new Error('Queue did not drain');
  }
  return { bot, queue, calls, update, drain };
}
test('bot sends media, cleans temporary files and reuses Telegram file_id', async () => {
  let downloads = 0, cleaned = 0;
  const service = { async download() {
    downloads++;
    return { title: 'Test photo', files: [{ type: 'photo', path: '/unused-mocked-photo.jpg' }], async cleanup() { cleaned++; } };
  } };
  const h = harness(service);
  await h.update('https://www.pinterest.com/pin/123/'); await h.drain();
  await delay(5);
  await h.update('https://www.pinterest.com/pin/123/'); await h.drain();
  assert.equal(downloads, 1); assert.equal(cleaned, 1);
  const sent = h.calls.filter(c => c.method === 'sendPhoto');
  assert.equal(sent.length, 2); assert.equal(sent[1].payload.photo, 'photo-cache');
  assert.match(sent[0].payload.caption, /Test photo/);
  await h.queue.close();
});
test('cancel command works while a download is active', async () => {
  let aborted = false;
  const h = harness({ async download(_link, { signal }) {
    try { await delay(10000, null, { signal }); } catch (error) { aborted = true; throw error; }
  } });
  await h.update('https://youtu.be/dQw4w9WgXcQ');
  await h.update('/cancel'); await h.drain();
  assert.equal(aborted, true);
  assert(h.calls.some(c => c.method === 'editMessageText' && /отменена/.test(c.payload.text)));
  await h.queue.close();
});
test('cleanup still runs after Telegram upload fails', async () => {
  let cleaned = false;
  const h = harness({ async download() { return { title: 'Test', files: [{ type: 'photo', path: '/mock.jpg' }], async cleanup() { cleaned = true; } }; } });
  h.bot.api.config.use(async (previous, method, payload, signal) => {
    if (method === 'sendPhoto') throw new Error('upload failed');
    return previous(method, payload, signal);
  });
  await h.update('https://www.pinterest.com/pin/123/'); await h.drain();
  assert.equal(cleaned, true);
  await h.queue.close();
});
test('allowlist blocks unauthorized users before accepting tasks', async () => {
  let downloaded = false;
  const h = harness({ async download() { downloaded = true; } }, { ALLOWED_USERS: '99' });
  await h.update('https://youtu.be/dQw4w9WgXcQ', 1);
  assert.equal(downloaded, false); assert.equal(h.calls.length, 0);
  await h.update('/help', 99);
  assert.equal(h.calls[0].method, 'sendMessage');
  await h.queue.close();
});
