# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
COPY shared/ /build/shared/
RUN npm run build

FROM node:24-bookworm-slim AS backend
WORKDIR /build/backend
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
COPY shared/ /build/shared/
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production DATA_DIR=/data FRONTEND_DIR=/app/frontend PORT=8000
WORKDIR /app
COPY --from=backend --chown=node:node /build/backend/dist ./dist
COPY --from=backend --chown=node:node /build/backend/node_modules ./node_modules
COPY --from=backend --chown=node:node /build/backend/package.json ./package.json
COPY --from=frontend --chown=node:node /build/frontend/dist ./frontend
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8000/api/health',{headers:{host:new URL(process.env.APP_URL).host}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
