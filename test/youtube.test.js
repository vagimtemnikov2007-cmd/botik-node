import test from 'node:test';
import assert from 'node:assert/strict';
import { durationSeconds, youtubeMetadata } from '../src/youtube.js';
import { errorDetails } from '../src/diagnostics.js';

test('YouTube durations support days and reject invalid input', () => {
  assert.equal(durationSeconds('P1DT2H3M4S'), 93784);
  assert.equal(durationSeconds('PT0S'), 0);
  assert.throws(() => durationSeconds('P'));
  assert.throws(() => durationSeconds('unknown'));
});
test('API metadata request detects upcoming streams', async () => {
  const info = await youtubeMetadata('dQw4w9WgXcQ', 'secret', new AbortController().signal, async raw => {
    const url = new URL(raw);
    assert.equal(url.hostname, 'www.googleapis.com');
    assert.equal(url.searchParams.get('part'), 'snippet,contentDetails');
    assert.equal(url.searchParams.get('key'), 'secret');
    return JSON.stringify({ items: [{ id: 'dQw4w9WgXcQ', snippet: { title: 'Title', liveBroadcastContent: 'upcoming' }, contentDetails: { duration: 'PT3M' } }] });
  });
  assert.deepEqual(info, { title: 'Title', duration: 180, is_live: true });
});
test('API failures hide credentials and respect cancellation', async () => {
  const controller = new AbortController();
  const request = async () => { throw new Error('secret'); };
  await assert.rejects(youtubeMetadata('dQw4w9WgXcQ', 'secret', controller.signal, request), error => !error.message.includes('secret'));
  controller.abort(new Error('cancelled'));
  await assert.rejects(youtubeMetadata('dQw4w9WgXcQ', 'secret', controller.signal, request), /cancelled/);
  assert.equal(errorDetails(new Error('secret'), { youtubeApiKey: 'secret' }).message, '[REDACTED]');
});
test('missing videos and malformed responses are rejected', async () => {
  for (const data of [{ items: [] }, {}]) {
    await assert.rejects(youtubeMetadata('dQw4w9WgXcQ', 'secret', new AbortController().signal, async () => JSON.stringify(data)));
  }
});
