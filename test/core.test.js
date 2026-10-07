import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { parseLink, extractLinks } from '../src/links.js';
import { JobQueue, TTLCache } from '../src/state.js';
import { loadConfig } from '../src/config.js';
import { runProcess } from '../src/process.js';
import { isPublicAddress, hostAllowed, requestSafe } from '../src/network.js';
import { twitterMedia, ogValue } from '../src/media.js';

test('canonicalization covers requested platforms and rejects forged domains', () => {
  assert.equal(parseLink('https://youtu.be/dQw4w9WgXcQ?si=test').url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(parseLink('https://youtube.com/shorts/dQw4w9WgXcQ').platform, 'youtube');
  assert.equal(parseLink('https://twitter.com/author/status/123?s=20').url, 'https://x.com/i/web/status/123');
  assert.equal(parseLink('https://instagram.com/reels/ABC_xyz/').url, 'https://www.instagram.com/reel/ABC_xyz/');
  assert.equal(parseLink('https://ru.pinterest.com/pin/12345/').platform, 'pinterest');
  assert.equal(parseLink('https://pin.it/Abc123').platform, 'pinterest');
  assert.equal(parseLink('https://www.tiktok.com/@person/video/1234').platform, 'tiktok');
  for (const url of ['https://youtube.com.evil.test/watch?v=dQw4w9WgXc', 'https://youtube.com@localhost/watch?v=dQw4w9WgXc', 'file:///etc/passwd', 'https://youtube.com/playlist?list=x', 'https://x.com/home', 'https://youtube.com:8443/watch?v=dQw4w9WgXc']) assert.equal(parseLink(url), null);
});
test('captions, hidden links, punctuation and duplicate URLs', () => {
  const links = extractLinks({ caption: 'Видео (https://youtu.be/dQw4w9WgXcQ). https://x.com/user/status/123!', caption_entities: [{ type: 'text_link', url: 'https://youtube.com/shorts/dQw4w9WgXcQ' }, { type: 'text_link', url: 'https://pin.it/ABC' }] });
  assert.deepEqual(links.map(l => l.platform), ['youtube', 'twitter', 'pinterest']);
});
test('config rejects unsafe limits and missing webhook secrets', () => {
  const env = { BOT_TOKEN: '123:fake' };
  assert.equal(loadConfig(env).maxBytes, 49 * 1024 * 1024);
  assert.throws(() => loadConfig({ ...env, MAX_FILE_MB: '100' }));
  assert.throws(() => loadConfig({ ...env, WEBHOOK_URL: 'https://example.com' }));
  assert.throws(() => loadConfig({ ...env, ALLOWED_USERS: '123,nope' }));
  assert.throws(() => loadConfig({ ...env, CONCURRENCY: '0' }));
});
test('queue enforces concurrency, capacity and cancellation per owner', async () => {
  const queue = new JobQueue(1, 3);
  let running = 0, peak = 0, queuedRan = false;
  const work = signal => { running++; peak = Math.max(peak, running); return delay(40, undefined, { signal }).finally(() => running--); };
  const first = queue.submit('a', work);
  const canceled = queue.submit('b', () => { queuedRan = true; });
  const second = queue.submit('a', work);
  assert.throws(() => queue.submit('c', work), /заполнена/);
  assert.equal(queue.cancel('b'), 1);
  await assert.rejects(canceled, { name: 'AbortError' });
  await Promise.all([first, second]);
  assert.equal(peak, 1); assert.equal(queuedRan, false);
  await queue.close(); assert.throws(() => queue.submit('a', work));
});
test('running queue task is aborted and shutdown drains work', async () => {
  const queue = new JobQueue(2, 10);
  const task = queue.submit('a', signal => delay(10000, null, { signal }));
  const assertion = assert.rejects(task, { name: 'AbortError' });
  await delay(1); await queue.close(); await assertion;
  assert.equal(queue.active.size, 0);
});
test('cache expires and evicts least recently used entries', async () => {
  const cache = new TTLCache(2, 20);
  cache.set('a', 1); cache.set('b', 2); cache.get('a'); cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  await delay(25); assert.equal(cache.get('a'), undefined);
});
test('network rejects private addresses, IPv4 mapped IPv6 and host spoofing', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(hostAllowed('pbs.twimg.com', ['twimg.com']), true);
  assert.equal(hostAllowed('evil-twimg.com', ['twimg.com']), false);
  await assert.rejects(requestSafe('https://evil.test/file', { domains: ['twimg.com'] }), /Недопустимый/);
});
test('extracts mixed Twitter albums and Pinterest OpenGraph in either attribute order', () => {
  const tweet = { media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com/a.jpg' }, { type: 'video', url: 'https://video.twimg.com/a.mp4' }] } };
  assert.deepEqual(twitterMedia(tweet, 10).map(i => i.type), ['photo', 'video']);
  assert.equal(twitterMedia(tweet, 1).length, 1);
  assert.equal(ogValue('<meta content="https://i.pinimg.com/a.jpg?x=1&amp;y=2" property="og:image">', 'og:image'), 'https://i.pinimg.com/a.jpg?x=1&y=2');
});
test('child processes use argument arrays and can be killed on cancellation', async () => {
  const literal = '$(echo SECRET); `echo SECRET`';
  const output = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal]);
  assert.equal(output, literal);
  const controller = new AbortController();
  const child = runProcess(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { signal: controller.signal });
  controller.abort(); await assert.rejects(child, { name: 'AbortError' });
});
