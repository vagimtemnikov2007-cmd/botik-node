import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { setTimeout as delay } from 'node:timers/promises';
import { extractLinks } from './links.js';
import { TTLCache, JobQueue } from './state.js';
import { MediaService } from './media.js';
import { errorDetails } from './diagnostics.js';

const help = `Отправьте ссылку — я пришлю медиа прямо в чат.

Поддержка: YouTube и Shorts, X/Twitter (видео, фото и текст), Instagram Reels, Pinterest (видео и фото), TikTok.

/quality — качество видео
/audio ссылка — скачать MP3
/music название — найти музыку в YouTube
/cancel — отменить ваши задачи в этом чате
/status — состояние очереди
/id — ваш Telegram ID

Можно отправить несколько ссылок или ссылку в подписи к фото. Закрытые публикации могут требовать cookies на сервере.`;

export function publicError(error) {
  if (error.name === 'AbortError') return 'Загрузка отменена.';
  // Match actual error lines, not debug output or Python function names.
  const stderrErrors = String(error.stderr || '').split('\n').filter(line => /^(?:ERROR|WARNING):/i.test(line));
  const text = stderrErrors.length ? stderrErrors.join('\n') : String(error.message || '');
  if (/ENOENT/.test(text)) return 'На сервере не установлен yt-dlp или FFmpeg. Сообщите владельцу бота.';
  if (/Unexpected response from webpage request/i.test(text)) return 'TikTok вернул ответ, который загрузчик не смог обработать. Подробности записаны в лог сервера.';
  if (/429/.test(text)) return 'Сервис ограничил частоту запросов. Попробуйте позже.';
  if (/sign in|login|cookies|confirm.*bot|private|403|401/i.test(text)) return 'Сайт требует авторизации или ограничил доступ. Попробуйте позже; владельцу бота может понадобиться cookies.txt.';
  if (/Загрузчик|HTTP|JSON|Unexpected|fetch|ECONN|ENOTFOUND|certificate/i.test(text)) return 'Не удалось получить медиа. Проверьте ссылку и доступность публикации.';
  return /[а-яё]/i.test(text) ? text.slice(0, 350) : 'Не удалось обработать ссылку. Попробуйте позже.';
}

export function createBot(config, logger, service = new MediaService(config, logger)) {
  const bot = new Bot(config.token, { client: { timeoutSeconds: 300 } });
  const queue = new JobQueue(config.concurrency, config.maxQueue);
  const preferences = new TTLCache(10000, 30 * 86400000);
  const cooldowns = new TTLCache(10000, Math.max(config.cooldownMs, 1000));
  const mediaCache = new TTLCache(1000, 6 * 3600000);
  const busy = new Set();
  const ownerOf = ctx => `${ctx.chat.id}:${ctx.from?.id || `channel-${ctx.chat.id}`}`;
  const replyOptions = ctx => ({ reply_parameters: { message_id: ctx.msg.message_id, allow_sending_without_reply: true } });

  async function retry(operation, signal) {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try { return await operation(); }
      catch (error) {
        const seconds = error.parameters?.retry_after;
        if (attempt >= 2 || !seconds || seconds > 30) throw error;
        await delay((seconds + 1) * 1000, undefined, { signal });
      }
    }
  }
  async function sendFiles(ctx, result, link, signal) {
    const caption = `${result.title || 'Медиа'}${result.text ? `\n\n${result.text}` : ''}\n\n${link.url || 'Поиск музыки в YouTube'}`.slice(0, 1000);
    const options = replyOptions(ctx);
    if (!result.files.length) {
      await retry(() => ctx.reply(`${result.text || result.title}\n\n${link.url || ''}`.slice(0, 4000), options), signal);
      return [];
    }
    const sent = [];
    const remember = (message, type) => ({ type, fileId: type === 'photo' ? message.photo.at(-1).file_id : message[type].file_id });
    for (let i = 0; i < result.files.length;) {
      signal.throwIfAborted();
      const file = result.files[i];
      const compatible = ['photo', 'video'].includes(file.type);
      const group = [];
      if (compatible) {
        for (let j = i; j < Math.min(i + 10, result.files.length) && ['photo', 'video'].includes(result.files[j].type); j++) group.push(result.files[j]);
      }
      if (group.length >= 2) {
        const messages = await retry(() => ctx.replyWithMediaGroup(group.map((item, n) => ({
          type: item.type, media: item.fileId || new InputFile(item.path), ...(n === 0 ? { caption } : {}),
          ...(item.type === 'video' ? { supports_streaming: true } : {}),
        })), options), signal);
        sent.push(...messages.map((message, n) => remember(message, group[n].type))); i += group.length;
      } else {
        const input = file.fileId || new InputFile(file.path);
        const opts = { ...options, caption: i === 0 ? caption : undefined };
        let message;
        if (file.type === 'photo') message = await retry(() => ctx.replyWithPhoto(input, opts), signal);
        else if (file.type === 'video') message = await retry(() => ctx.replyWithVideo(input, { ...opts, supports_streaming: true }), signal);
        else if (file.type === 'audio') message = await retry(() => ctx.replyWithAudio(input, { ...opts, title: (result.title || 'Аудио').slice(0, 64) }), signal);
        else message = await retry(() => ctx.replyWithDocument(input, opts), signal);
        sent.push(remember(message, file.type)); i++;
      }
    }
    return sent;
  }

  async function schedule(ctx, links, audio = false) {
    const owner = ownerOf(ctx);
    if (busy.has(owner)) return ctx.reply('У вас уже есть задача в этом чате. Дождитесь результата или используйте /cancel.');
    if (config.cooldownMs && cooldowns.get(owner)) return ctx.reply('Подождите несколько секунд перед следующим запросом.');
    if (links.length > config.maxLinks) return ctx.reply(`За один запрос можно отправить до ${config.maxLinks} ссылок.`);
    if (queue.size >= config.maxQueue || queue.closed) return ctx.reply('Очередь заполнена. Попробуйте чуть позже.');
    busy.add(owner);
    let status;
    let context = { stage: 'queue' };
    try {
      status = await ctx.reply('⏳ Добавлено в очередь. Отмена: /cancel', replyOptions(ctx));
      const quality = preferences.get(ctx.from?.id || owner) || config.quality;
      const promise = queue.submit(owner, async signal => {
        const edit = text => bot.api.editMessageText(ctx.chat.id, status.message_id, text).catch(() => {});
        let completed = 0;
        for (const link of links) {
          context = { platform: link.platform, url: link.url, stage: 'download' };
          signal.throwIfAborted();
          await edit(`⏬ Загружаю ${link.platform === 'music' ? 'музыку' : link.platform}… (${completed + 1}/${links.length})`);
          const key = `${link.url || link.query}:${audio}:${quality}`;
          const cached = mediaCache.get(key);
          if (cached) {
            // On a stale file_id fail visibly; avoid resending a partially sent album.
            try { context.stage = 'telegram_upload'; await sendFiles(ctx, cached, link, signal); }
            catch (error) { mediaCache.delete(key); throw error; }
          } else {
            const result = await service.download(link, { quality, audio, signal });
            try {
              signal.throwIfAborted();
              await edit('📤 Отправляю в Telegram…');
              context.stage = 'telegram_upload';
              const files = await sendFiles(ctx, result, link, signal);
              mediaCache.set(key, { title: result.title, text: result.text, files });
            } finally { await result.cleanup(); }
          }
          completed++;
        }
        await edit(`✅ Готово: ${completed}/${links.length}`);
      });
      if (config.cooldownMs) cooldowns.set(owner, true);
      promise.catch(error => {
        logger.warn({ owner, ...context, error: publicError(error), details: errorDetails(error, config) }, 'Job failed');
        return bot.api.editMessageText(ctx.chat.id, status.message_id, `⚠️ ${publicError(error)}`).catch(() => {});
      }).finally(() => busy.delete(owner));
    } catch (error) {
      busy.delete(owner);
      if (status) await bot.api.editMessageText(ctx.chat.id, status.message_id, publicError(error)).catch(() => {});
      else throw error;
    }
  }

  bot.use(async (ctx, next) => {
    if (config.allowedUsers.size && !config.allowedUsers.has(String(ctx.from?.id))) return;
    await next();
  });
  bot.command(['start', 'help'], ctx => ctx.reply(help));
  bot.command('id', ctx => ctx.reply(`Ваш ID: ${ctx.from?.id || 'отправитель канала'}\nID чата: ${ctx.chat.id}`));
  bot.command('status', ctx => ctx.reply(`В работе: ${queue.active.size}\nОжидают: ${queue.pending.length}\nКачество: ${preferences.get(ctx.from?.id || ownerOf(ctx)) || config.quality}p`));
  bot.command('cancel', ctx => ctx.reply(queue.cancel(ownerOf(ctx)) ? 'Отменяю ваши задачи…' : 'У вас нет активных задач в этом чате.'));
  bot.command('quality', ctx => {
    if (!ctx.from) return;
    const keyboard = new InlineKeyboard();
    for (const quality of ['360', '720', '1080']) keyboard.text(`${quality}p`, `quality:${ctx.from.id}:${quality}`);
    return ctx.reply('Выберите максимальное качество. Крупные видео будут сжаты до лимита Telegram.', { reply_markup: keyboard });
  });
  bot.callbackQuery(/^quality:(\d+):(360|720|1080)$/, async ctx => {
    if (String(ctx.from.id) !== ctx.match[1]) return ctx.answerCallbackQuery({ text: 'Эта кнопка предназначена автору команды.' });
    preferences.set(ctx.from.id, ctx.match[2]);
    await ctx.answerCallbackQuery({ text: `Установлено ${ctx.match[2]}p` });
    await ctx.editMessageText(`Качество: ${ctx.match[2]}p`);
  });
  bot.command('audio', ctx => {
    const links = extractLinks(ctx.msg);
    return links.length ? schedule(ctx, links, true) : ctx.reply('Использование: /audio ссылка_на_видео');
  });
  bot.command('music', ctx => {
    const query = String(ctx.match || '').trim();
    if (!query || query.length > 200 || /https?:\/\//i.test(query)) return ctx.reply('Использование: /music исполнитель название (до 200 символов)');
    return schedule(ctx, [{ platform: 'music', query }], true);
  });
  bot.on(['message:text', 'message:caption', 'channel_post:text', 'channel_post:caption'], ctx => {
    const links = extractLinks(ctx.msg);
    if (links.length) return schedule(ctx, links);
    const text = ctx.msg.text || ctx.msg.caption || '';
    const mention = `@${bot.botInfo.username}`;
    if (text.toLowerCase().startsWith(`${mention.toLowerCase()} `)) {
      const query = text.slice(mention.length).trim();
      if (query && query.length <= 200 && !/https?:\/\//i.test(query)) return schedule(ctx, [{ platform: 'music', query }], true);
    }
    if (ctx.chat.type === 'private' && !text.startsWith('/')) return ctx.reply('Пришлите ссылку на публикацию или используйте /music название. Список команд: /help');
  });
  bot.catch(error => logger.error({ error: publicError(error.error), updateId: error.ctx.update.update_id }, 'Telegram update failed'));
  return { bot, queue };
}
