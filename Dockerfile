# OpsCat Community Edition image (Apache-2.0 core, no marketing site / EE).
# In the public opscat.io repo this file is published as `Dockerfile`.
# --- Stage 1: build the web UI ---
FROM node:22-alpine AS webbuild
WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- Stage 2: server dependencies (build tools for better-sqlite3 fallback) ---
FROM node:22-alpine AS serverdeps
RUN apk add --no-cache python3 make g++
WORKDIR /build/server
COPY server/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- Stage 3: runtime ---
FROM node:22-alpine
# iputils/traceroute: real ping (rtt/mdev output) + traceroute for synthetics
RUN apk add --no-cache iputils traceroute wget
WORKDIR /app
COPY server/ ./server/
COPY agent/ ./agent/
COPY --from=serverdeps /build/server/node_modules ./server/node_modules
COPY --from=webbuild /build/web/dist ./server/public

ENV NODE_ENV=production \
    OPSCAT_DATA_DIR=/data \
    OPSCAT_PUBLIC_DIR=/app/server/public \
    OPSCAT_EDITION=community \
    PORT=3000
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server/src/index.js"]
