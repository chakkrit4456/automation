# Stage 1: build the dashboard.
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: API + FFmpeg + Thai fonts + Edge TTS.
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core fonts-thai-tlwg python3 python3-pip ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages edge-tts \
  && rm -rf /var/lib/apt/lists/* /root/.cache

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY backend/server.js ./
COPY backend/src ./src
COPY database /app/database
COPY --from=web /web/dist /app/frontend/dist

RUN mkdir -p /data/media && chown -R node:node /data/media
ENV NODE_ENV=production PORT=3000 MEDIA_ROOT=/data/media
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
