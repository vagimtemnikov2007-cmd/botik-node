import test from 'node:test';
import assert from 'node:assert/strict';
import { errorDetails } from '../src/diagnostics.js';

test('diagnostics retain downloader failures and redact configured secrets and URL credentials', () => {
  const error = Object.assign(new Error('HTTP Error 403: Forbidden'), {
    command: 'yt-dlp', exitCode: 1, stage: 'metadata',
    stderr: 'ERROR: HTTP Error 403: Forbidden\nhttps://user:pass@example.com/video?token=secret\nCookie: session=private\nbot-secret webhook-secret cookie-value',
  });
  const details = errorDetails(error, { token: 'bot-secret', webhookSecret: 'webhook-secret', cookiesText: '# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t0\tsession\tcookie-value' });
  assert.equal(details.exitCode, 1);
  assert.equal(details.stage, 'metadata');
  assert.match(details.stderr, /HTTP Error 403: Forbidden/);
  assert.match(details.stderr, /https:\/\/example.com\/video/);
  assert.doesNotMatch(JSON.stringify(details), /bot-secret|webhook-secret|cookie-value|user:pass|token=secret|session=private/);
});
