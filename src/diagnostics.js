export function errorDetails(error, config = {}) {
  const secrets = [config.token, config.webhookSecret,
    ...(config.cookiesText || '').split('\n').filter(line => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_'))).map(line => line.split('\t')[6]),
  ].filter(Boolean);
  const clean = value => {
    let text = String(value ?? '');
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text.replace(/https?:\/\/[^\s"'<>]+/g, raw => {
      try { const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
      catch { return '[URL]'; }
    }).replace(/\b(?:Cookie|Authorization|Set-Cookie)\s*:[^\r\n]*/gi, '[REDACTED HEADER]').slice(-16000);
  };
  return {
    name: clean(error?.name), message: clean(error?.message || error),
    code: clean(error?.code), command: clean(error?.command || error?.path),
    stage: clean(error?.stage), exitCode: error?.exitCode, stderr: clean(error?.stderr),
    stack: clean(error?.stack),
  };
}
