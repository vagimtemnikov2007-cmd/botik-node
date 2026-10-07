import { stat } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { parseLink } from '../src/links.js';
import { MediaService } from '../src/media.js';

const config = loadConfig({ ...process.env, BOT_TOKEN: '0:local_test', JOB_TIMEOUT_SECONDS: '90' });
const service = new MediaService(config, { warn: (...args) => console.error('Резервный загрузчик:', args.at(-1)) });
if (process.argv.length < 3) {
  console.error('Использование: npm run smoke -- https://ссылка_на_публикацию');
  process.exitCode = 1;
}
for (const raw of process.argv.slice(2)) {
  const link = parseLink(raw);
  if (!link) { console.error('Неподдерживаемая ссылка'); process.exitCode = 1; continue; }
  console.log(`Проверяю: ${link.platform}`);
  let result;
  try {
    result = await service.download(link, { quality: '360', signal: new AbortController().signal });
    const files = await Promise.all(result.files.map(async file => ({ type: file.type, bytes: (await stat(file.path)).size })));
    console.log(JSON.stringify({ ok: true, platform: link.platform, title: result.title, files, hasText: Boolean(result.text) }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, platform: link.platform, error: error.message.slice(0, 1500) }));
    process.exitCode = 1;
  } finally { if (result) await result.cleanup(); }
}
