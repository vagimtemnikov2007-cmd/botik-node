FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
    && python3 -m venv /opt/ytdlp \
    && /opt/ytdlp/bin/pip install --no-cache-dir "yt-dlp[default,curl-cffi]" \
    && /opt/ytdlp/bin/python -c "from curl_cffi import requests; assert requests.BrowserType.chrome" \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/opt/ytdlp/bin:$PATH" NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node src ./src
USER node
EXPOSE 8000
CMD ["node", "src/index.js"]
