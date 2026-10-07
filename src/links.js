const domains = {
  youtube: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
  twitter: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'fxtwitter.com', 'fixupx.com'],
  instagram: ['instagram.com', 'www.instagram.com'],
  pinterest: ['pinterest.com', 'www.pinterest.com', 'ru.pinterest.com', 'pinterest.ru', 'www.pinterest.ru', 'pin.it'],
  tiktok: ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
};

export function parseLink(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  const platform = Object.keys(domains).find(p => domains[p].includes(url.hostname));
  if (!platform) return null;
  url.protocol = 'https:';
  url.hash = '';
  let id;
  if (platform === 'youtube') {
    id = url.hostname === 'youtu.be' ? url.pathname.slice(1).split('/')[0] : url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/)?.[1];
    if (!/^[\w-]{11}$/.test(id || '')) return null;
    url = new URL(`https://www.youtube.com/watch?v=${id}`);
  } else if (platform === 'twitter') {
    id = url.pathname.match(/^\/(?:\w+|i\/web)\/status\/(\d+)/)?.[1];
    if (!id) return null;
    url = new URL(`https://x.com/i/web/status/${id}`);
  } else if (platform === 'instagram') {
    const match = url.pathname.match(/^\/(reel|reels|p|tv)\/([\w-]+)\/?$/);
    if (!match) return null;
    url = new URL(`https://www.instagram.com/${match[1] === 'reels' ? 'reel' : match[1]}/${match[2]}/`);
  } else if (platform === 'pinterest') {
    if (url.hostname === 'pin.it') {
      if (!/^\/[\w-]+\/?$/.test(url.pathname)) return null;
    } else {
      id = url.pathname.match(/^\/pin\/(?:[\w-]+--)?(\d+)\/?$/)?.[1];
      if (!id) return null;
      url = new URL(`https://www.pinterest.com/pin/${id}/`);
    }
    url.search = '';
  } else {
    if (!/^\/@[^/]+\/(video|photo)\/\d+\/?$/.test(url.pathname) && !['vm.tiktok.com', 'vt.tiktok.com'].includes(url.hostname) && !/^\/t\/[\w-]+\/?$/.test(url.pathname)) return null;
    url.search = '';
  }
  return { platform, url: url.href, id };
}

export function extractLinks(message) {
  const text = message.text || message.caption || '';
  const entities = message.entities || message.caption_entities || [];
  const raw = [...(text.match(/https?:\/\/[^\s<>"\u200b]+/gi) || []).map(s => s.replace(/[.,!?)\]}]+$/, '')),
    ...entities.filter(e => e.type === 'text_link').map(e => e.url)];
  return [...new Map(raw.map(parseLink).filter(Boolean).map(link => [link.url, link])).values()];
}
