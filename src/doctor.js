import { runProcess } from './process.js';
import { loadConfig } from './config.js';
import { access } from 'node:fs/promises';

let failed = false;
for (const [name, command, args] of [
  ['Node.js', process.execPath, ['--version']],
  ['yt-dlp', process.env.YTDLP_PATH || 'yt-dlp', ['--version']],
  ['FFmpeg', process.env.FFMPEG_PATH || 'ffmpeg', ['-version']],
  ['FFprobe', process.env.FFPROBE_PATH || 'ffprobe', ['-version']],
]) {
  try { console.log(`✓ ${name}: ${(await runProcess(command, args, { timeoutMs: 10000 })).split('\n')[0]}`); }
  catch { console.error(`✗ ${name}: не найден или не запускается`); failed = true; }
}
try { const config = loadConfig(); if (config.cookies) await access(config.cookies); console.log('✓ Настройки корректны (токен не проверен в Telegram)'); }
catch (error) { console.error(`✗ ${error.message}`); failed = true; }
process.exitCode = failed ? 1 : 0;
