# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
COPY shared/ /build/shared/
RUN npm run build

FROM node:24-bookworm-slim AS backend
ARG CSWATCH_REVISION=
ARG CSWATCH_BUILD_TIMESTAMP=
WORKDIR /build/backend
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
COPY shared/ /build/shared/
RUN npm run build && npm prune --omit=dev

# Optional operator asset tooling. This target never contains the app's native
# parser, database/auth/provider dependencies or proprietary game resources.
FROM node:24-bookworm-slim AS asset-build
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY tools/assets/package*.json ./tools/assets/
RUN npm ci --prefix tools/assets --omit=dev
COPY tools/assets/*.mjs ./tools/assets/
COPY tools/assets/native/asset-network-deny.c ./tools/assets/native/
COPY shared/map-previews.json ./shared/
RUN node tools/assets/build-network-deny.mjs --output tools/assets/bin/asset-network-deny \
    && node -e "const fs=require('node:fs'); for (const name of fs.readdirSync('tools/assets')) if (name.endsWith('.test.mjs')) fs.unlinkSync('tools/assets/'+name)"

FROM node:24-bookworm-slim AS assets
ARG CSWATCH_REVISION=
ARG CSWATCH_BUILD_TIMESTAMP=
LABEL org.opencontainers.image.source="https://github.com/Buco7854/cswatch" \
      org.opencontainers.image.revision="${CSWATCH_REVISION}" \
      org.opencontainers.image.created="${CSWATCH_BUILD_TIMESTAMP}"
ENV NODE_ENV=production MAP_ASSETS_DIR=/map-assets MAP_JOBS_DIR=/map-jobs MAP_CACHE_DIR=/map-cache MAP_CATALOG_FILE=/map-catalog/catalog.json
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libicu72 util-linux unzip tar gzip && rm -rf /var/lib/apt/lists/*
COPY --from=asset-build /build/tools/assets/package*.json ./tools/assets/
COPY --from=asset-build /build/tools/assets/node_modules ./tools/assets/node_modules
COPY --from=asset-build /build/tools/assets/*.mjs ./tools/assets/
COPY --from=asset-build /build/tools/assets/bin/asset-network-deny ./tools/assets/bin/asset-network-deny
COPY --from=backend /build/backend/dist/map-catalog.js /build/backend/dist/map-identity.js /build/backend/dist/map-jobs.js /build/backend/dist/map-asset-files.js /build/backend/dist/asset-content.js ./backend/dist/
COPY --from=backend /build/backend/node_modules/zod ./backend/node_modules/zod
COPY shared/equipment-icons.json shared/equipment-models.json shared/agent-animation.json shared/map-previews.json shared/gameplay-sounds.json shared/gameplay-sound-files.mjs ./shared/
RUN mkdir -p /map-assets /map-jobs /map-cache /map-catalog \
    && node -e "const fs=require('node:fs'); fs.writeFileSync('backend/package.json', JSON.stringify({type:'module',private:true})); fs.writeFileSync('/map-catalog/catalog.json',JSON.stringify({schemaVersion:1,entries:[]})+'\n',{mode:0o640})" \
    && chown -R node:node /map-assets /map-jobs /map-cache /map-catalog
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node --input-type=module -e "import {mapWorkerAvailable} from './backend/dist/map-jobs.js'; process.exit(await mapWorkerAvailable(process.env.MAP_JOBS_DIR)?0:1)"
CMD ["node", "tools/assets/map-worker.mjs"]

# Keep the application runtime last: an ordinary docker build remains the web image.
FROM node:24-bookworm-slim AS runtime
ARG CSWATCH_REVISION=
ARG CSWATCH_BUILD_TIMESTAMP=
LABEL org.opencontainers.image.source="https://github.com/Buco7854/cswatch" \
      org.opencontainers.image.revision="${CSWATCH_REVISION}" \
      org.opencontainers.image.created="${CSWATCH_BUILD_TIMESTAMP}"
ENV NODE_ENV=production DATA_DIR=/data FRONTEND_DIR=/app/frontend PORT=8000
WORKDIR /app
COPY --from=backend --chown=node:node /build/backend/dist ./dist
COPY --from=backend --chown=node:node /build/backend/node_modules ./node_modules
COPY --from=backend --chown=node:node /build/backend/package.json ./package.json
COPY --from=frontend --chown=node:node /build/frontend/dist ./frontend
RUN mkdir -p /data /map-assets /map-jobs /map-cache /map-catalog \
    && node -e "require('node:fs').writeFileSync('/map-catalog/catalog.json',JSON.stringify({schemaVersion:1,entries:[]})+'\n',{mode:0o640})" \
    && chown -R node:node /data /map-assets /map-jobs /map-cache /map-catalog
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8000/api/health',{headers:{host:new URL(process.env.APP_URL).host}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
