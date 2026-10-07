import { mkdtemp, readdir, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from './process.js';
import { downloadFile, fetchText } from './network.js';

export function twitterMedia(tweet, maxItems) {
  const all = tweet.media?.all || [...(tweet.media?.photos || []), ...(tweet.media?.videos || [])];
  return all.slice(0, maxItems).map(item => ({
    url: item.url, type: item.type === 'photo' || (!item.type && /\.(jpg|jpeg|png|webp)(\?|$)/i.test(item.url)) ? 'photo' : 'video',
  })).filter(item => item.url);
}
export function ogValue(html, property) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map(m => [m[1].toLowerCase(), m[3]]));
    if ((attrs.property || attrs.name) === property) return (attrs.content || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  return '';
}

export class MediaService {
  constructor(config, logger) { this.config = config; this.logger = logger; }
  commonArgs() {
    const c = this.config;
    return ['--ignore-config', '--no-warnings', '--no-playlist', '--socket-timeout', '20', '--retries', '2', '--fragment-retries', '2',
      ...(c.ffmpeg === 'ffmpeg' ? [] : ['--ffmpeg-location', c.ffmpeg]), '--js-runtimes', 'node', ...(c.cookies ? ['--cookies', c.cookies] : [])];
  }
  async download(link, { quality, audio = false, signal }) {
    const dir = await mkdtemp(join(tmpdir(), 'botik-node-'));
    const deadline = AbortSignal.timeout(this.config.timeoutMs);
    const jobSignal = AbortSignal.any([signal, deadline]);
    try {
      let result;
      if (link.platform === 'twitter' && !audio) {
        try { result = await this.twitter(link, dir, jobSignal); }
        catch (error) { jobSignal.throwIfAborted(); this.logger.warn({ platform: 'twitter' }, 'FxTwitter unavailable, trying yt-dlp'); }
      }
      if (!result) {
        try { result = await this.ytdlp(link, dir, quality, audio, jobSignal); }
        catch (error) {
          jobSignal.throwIfAborted();
          if (link.platform !== 'pinterest' || audio) throw error;
          result = await this.pinterestPhoto(link, dir, jobSignal);
        }
      }
      for (const file of result.files) {
        jobSignal.throwIfAborted();
        if (file.type === 'video') await this.fitVideo(file, dir, jobSignal);
        const size = (await stat(file.path)).size;
        if (!size || size > this.config.maxBytes) throw new Error('Файл превышает лимит Telegram. Выберите качество 360p или аудио.');
        if (file.type === 'photo' && size > 9 * 1024 * 1024) file.type = 'document';
      }
      return { ...result, cleanup: () => rm(dir, { recursive: true, force: true }) };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      if (deadline.aborted && !signal.aborted) throw new Error('Загрузка заняла слишком много времени. Попробуйте более короткое видео.');
      throw error;
    }
  }
  async twitter(link, dir, signal) {
    const response = JSON.parse(await fetchText(`https://api.fxtwitter.com/status/${link.id}`, { domains: ['api.fxtwitter.com'], signal }));
    if (!response.tweet || response.code !== 200) throw new Error('Пост недоступен.');
    const tweet = response.tweet;
    const items = twitterMedia(tweet, this.config.maxItems);
    const files = [];
    for (const [i, item] of items.entries()) {
      const path = join(dir, `twitter-${i}.${item.type === 'photo' ? 'jpg' : 'mp4'}`);
      const contentType = await downloadFile(item.url, path, this.config.maxBytes, { domains: ['twimg.com', 'fxtwitter.com'], signal });
      if (!/^(image|video)\//.test(contentType)) throw new Error('Сервис вернул неверный формат медиа.');
      files.push({ path, type: item.type });
    }
    return { title: tweet.author?.name || 'X / Twitter', text: tweet.text || '', files };
  }
  async pinterestPhoto(link, dir, signal) {
    const html = await fetchText(link.url, { domains: ['pin.it', 'pinterest.com', 'pinterest.ru'], signal });
    if (ogValue(html, 'og:video') || ogValue(html, 'og:video:url') || /"video_list"\s*:\s*\{\s*"/.test(html)) throw new Error('Видео Pinterest сейчас недоступно загрузчику. Попробуйте прямую ссылку на пин.');
    const image = ogValue(html, 'og:image');
    if (!image) throw new Error('Пин недоступен или требует авторизации.');
    const path = join(dir, 'pinterest.jpg');
    const contentType = await downloadFile(image, path, this.config.maxBytes, { domains: ['pinimg.com'], signal });
    if (!contentType.startsWith('image/')) throw new Error('Изображение Pinterest недоступно.');
    return { title: ogValue(html, 'og:title') || 'Pinterest', files: [{ type: 'photo', path }] };
  }
  async ytdlp(link, dir, quality, audio, signal) {
    const c = this.config;
    const target = link.platform === 'music' ? `ytsearch1:${link.query}` : link.url;
    const raw = await runProcess(c.ytdlp, [...this.commonArgs(), '--dump-single-json', '--skip-download', '--playlist-end', String(c.maxItems), '--', target], { signal, timeoutMs: c.timeoutMs });
    const info = JSON.parse(raw);
    const entries = info.entries ? info.entries.filter(Boolean).slice(0, c.maxItems) : [info];
    if (!entries.length) throw new Error('Медиа не найдено.');
    if (entries.some(e => e.is_live || e.live_status === 'is_live' || Number(e.duration) > c.maxDuration)) throw new Error(`Трансляции и видео длиннее ${Math.floor(c.maxDuration / 60)} минут не поддерживаются.`);
    const format = audio ? ['-x', '--audio-format', 'mp3', '--audio-quality', '192K', '--embed-metadata'] : [
      '-f', `bv*[height<=${quality}][ext=mp4]+ba[ext=m4a]/b[height<=${quality}][ext=mp4]/b[height<=${quality}]/b`,
      '--merge-output-format', 'mp4', '--recode-video', 'mp4', '--postprocessor-args', 'ffmpeg:-movflags +faststart',
    ];
    // Bound temporary disk use even when a site's file size estimate is missing.
    const diskController = new AbortController();
    let checking = false;
    const diskTimer = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const sizes = await Promise.all((await readdir(dir)).map(async name => (await stat(join(dir, name)).catch(() => ({ size: 0 }))).size));
        if (sizes.reduce((a, b) => a + b, 0) > c.maxBytes * (c.maxItems + 2) * 3) diskController.abort(new Error('Превышен лимит временных файлов.'));
      } catch { /* The directory may have been removed after cancellation. */ }
      finally { checking = false; }
    }, 1000);
    try {
      await runProcess(c.ytdlp, [...this.commonArgs(), '--playlist-end', String(c.maxItems), '--max-filesize', String(c.maxBytes * 3),
        '--match-filter', `!is_live & duration <=? ${c.maxDuration}`, '--write-info-json', '-o', join(dir, '%(autonumber)03d-%(id)s.%(ext)s'),
        ...format, '--', target], { signal: AbortSignal.any([signal, diskController.signal]), timeoutMs: c.timeoutMs });
    } finally { clearInterval(diskTimer); }
    const names = (await readdir(dir)).sort();
    const files = names.filter(name => /\.(mp4|mp3|m4a|webm|mkv|mov)$/i.test(name)).slice(0, c.maxItems).map(name => ({
      path: join(dir, name), type: audio ? 'audio' : 'video', duration: entries[0].duration,
    }));
    if (!files.length) throw new Error('Нет доступного файла подходящего размера. Попробуйте 360p или аудио.');
    let metadata = entries[0];
    const infoFile = names.find(n => n.endsWith('.info.json'));
    if (infoFile) metadata = JSON.parse(await readFile(join(dir, infoFile), 'utf8'));
    return { title: metadata.title || info.title || 'Медиа', files };
  }
  async fitVideo(file, dir, signal) {
    if ((await stat(file.path)).size <= this.config.maxBytes) return;
    const probe = await runProcess(this.config.ffprobe || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file.path], { signal });
    const duration = Number(JSON.parse(probe).format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Не удалось определить длительность видео.');
    const bitrate = Math.floor(this.config.maxBytes * 0.92 * 8 / duration / 1000) - 96;
    if (bitrate < 180) throw new Error('Видео слишком большое. Попробуйте аудио или более короткое видео.');
    const output = join(dir, `compressed-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`);
    await runProcess(this.config.ffmpeg, ['-nostdin', '-y', '-i', file.path, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=-2:min(ih\\,720)',
      '-c:v', 'libx264', '-preset', 'fast', '-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`,
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', output], { signal });
    file.path = output;
  }
}
