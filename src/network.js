import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import ipaddr from 'ipaddr.js';

export function isPublicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function hostAllowed(host, domains) {
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
}
export async function requestSafe(raw, { domains, signal, redirects = 5 } = {}) {
  signal?.throwIfAborted();
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !hostAllowed(url.hostname, domains)) throw new Error('Недопустимый адрес медиа.');
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('Недопустимый сетевой адрес.');
  const chosen = addresses[0];
  const response = await new Promise((resolve, reject) => {
    const req = https.get(url, {
      signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; BotikNode/1.0)', 'accept-encoding': 'identity' },
      lookup: (_host, options, callback) => options?.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family),
    }, resolve);
    req.setTimeout(20000, () => req.destroy(new Error('Сервер не отвечает.')));
    req.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.resume();
    if (redirects <= 0 || !response.headers.location) throw new Error('Слишком много перенаправлений.');
    return requestSafe(new URL(response.headers.location, url).href, { domains, signal, redirects: redirects - 1 });
  }
  if (response.statusCode !== 200) { response.resume(); throw new Error(`Сервис вернул HTTP ${response.statusCode}.`); }
  return response;
}
export async function fetchText(url, options) {
  const response = await requestSafe(url, options);
  const chunks = []; let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) { response.destroy(); throw new Error('Ответ сервиса слишком большой.'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function downloadFile(url, path, maxBytes, options) {
  const response = await requestSafe(url, options);
  if (Number(response.headers['content-length']) > maxBytes) { response.destroy(); throw new Error('Файл превышает лимит размера.'); }
  let size = 0;
  const limiter = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    callback(size > maxBytes ? new Error('Файл превышает лимит размера.') : null, chunk);
  } });
  await pipeline(response, limiter, createWriteStream(path, { flags: 'wx' }), { signal: options.signal });
  return response.headers['content-type'] || '';
}
