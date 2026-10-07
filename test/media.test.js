import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaService } from '../src/media.js';
import { loadConfig } from '../src/config.js';
import { runProcess } from '../src/process.js';

const logger = { warn() {} };
const config = loadConfig({ BOT_TOKEN: '123:fake' });
test('cookies come from environment and their private temporary file is removed on failure', async () => {
  const content = '# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t0\tsession\tsecret-value\n';
  const service = new MediaService(loadConfig({ BOT_TOKEN: '123:fake', COOKIES_TEXT: content }), logger);
  let cookiePath;
  service.ytdlp = async (_link, dir) => {
    const args = await service.downloadArgs(dir);
    cookiePath = args[args.indexOf('--cookies') + 1];
    assert.equal(await readFile(cookiePath, 'utf8'), content);
    assert.equal((await stat(cookiePath)).mode & 0o777, 0o600);
    throw new Error('extractor unavailable');
  };
  await assert.rejects(service.download({ platform: 'youtube', url: 'https://youtube.com/watch?v=dQw4w9WgXcQ' }, { quality: '720', signal: new AbortController().signal }), /extractor unavailable/);
  await assert.rejects(access(cookiePath), { code: 'ENOENT' });
});
test('yt-dlp uses FFmpeg from PATH by default and accepts an explicit binary path', () => {
  assert.equal(new MediaService(config, logger).commonArgs().includes('--ffmpeg-location'), false);
  const args = new MediaService({ ...config, ffmpeg: '/usr/bin/ffmpeg' }, logger).commonArgs();
  assert.equal(args[args.indexOf('--ffmpeg-location') + 1], '/usr/bin/ffmpeg');
});
test('actual FFmpeg compression produces a video below the upload limit', async t => {
  try { await runProcess('ffmpeg', ['-version']); await runProcess('ffprobe', ['-version']); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('FFmpeg not installed'); throw error; }
  const dir = await mkdtemp(join(tmpdir(), 'botik-test-'));
  try {
    const path = join(dir, 'source.mp4');
    await runProcess('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', path]);
    const limit = 200 * 1024;
    assert((await stat(path)).size > limit);
    const file = { path, type: 'video' };
    await new MediaService({ ...config, maxBytes: limit }, logger).fitVideo(file, dir, new AbortController().signal);
    assert.notEqual(file.path, path);
    assert((await stat(file.path)).size < limit);
    const info = JSON.parse(await runProcess('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', file.path]));
    assert.equal(info.streams[0].codec_name, 'h264');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('media service removes temporary directory after extraction failure', async () => {
  let workingDir;
  const service = new MediaService(config, logger);
  service.ytdlp = async (_link, dir) => {
    workingDir = dir;
    await writeFile(join(dir, 'partial.mp4'), 'partial download');
    throw new Error('extractor unavailable');
  };
  await assert.rejects(service.download({ platform: 'youtube', url: 'https://youtube.com/watch?v=dQw4w9WgXcQ' }, { quality: '720', signal: new AbortController().signal }), /extractor unavailable/);
  await assert.rejects(access(workingDir), { code: 'ENOENT' });
});
test('media service returns a cleanup function for successful downloads', async () => {
  const service = new MediaService(config, logger);
  service.ytdlp = async (_link, dir) => {
    const path = join(dir, 'audio.mp3'); await writeFile(path, 'test audio');
    return { title: 'Audio', files: [{ path, type: 'audio' }] };
  };
  const result = await service.download({ platform: 'music', query: 'song' }, { quality: '720', audio: true, signal: new AbortController().signal });
  assert((await stat(result.files[0].path)).size > 0);
  await result.cleanup();
  await assert.rejects(access(result.files[0].path), { code: 'ENOENT' });
});
