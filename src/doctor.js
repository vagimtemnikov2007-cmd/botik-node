import { runProcess } from './process.js';
import { loadConfig } from './config.js';

let failed = false;
for (const [name, command, args] of [
  ['Node.js', process.execPath, ['--version']],
  ['yt-dlp', 'yt-dlp', ['--version']],
  ['FFmpeg', 'ffmpeg', ['-version']],
  ['FFprobe', 'ffprobe', ['-version']],
]) {
  try { console.log(`✓ ${name}: ${(await runProcess(command, args, { timeoutMs: 10000 })).split('\n')[0]}`); }
  catch { console.error(`✗ ${name}: не найден или не запускается`); failed = true; }
}
try { loadConfig(); console.log('✓ Настройки окружения корректны (токен не проверен в Telegram)'); }
catch (error) { console.error(`✗ ${error.message}`); failed = true; }
process.exitCode = failed ? 1 : 0;
