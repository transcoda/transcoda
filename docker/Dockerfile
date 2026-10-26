# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f docker/Dockerfile -t transcoda:dev .

ARG NODE_IMAGE=node:24.22.1-bookworm-slim

# 1. Build the web UI and the server bundle on the build host's platform.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/contract/package.json packages/contract/
COPY packages/sdk/package.json packages/sdk/
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
# The fixtures flag also builds the sandbox denial plugin the image's CI job checks. `pnpm notices`
# writes third-party.json and THIRD_PARTY_NOTICES.txt (fails on a licence outside the allow-list).
RUN TRANSCODA_BUILD_FIXTURES=1 pnpm build && pnpm notices

# 2. Production node_modules for the server, resolved on the target platform.
#    better-sqlite3 ships prebuilt binaries, so no compiler is needed (allowBuilds stays false).
FROM ${NODE_IMAGE} AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/contract/package.json packages/contract/
COPY packages/sdk/package.json packages/sdk/
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm deploy --prod --filter @transcoda/server /deploy \
 && cd /deploy/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 \
 && rm -rf deps src \
 && find prebuilds -type f ! -name "linux-$(node -p process.arch).node" -delete \
 && node -e "new (require('/deploy/node_modules/better-sqlite3'))(':memory:').prepare('select 1').get()"

# 3. Runtime image.
FROM ${NODE_IMAGE} AS runtime
ARG JELLYFIN_FFMPEG_VERSION=8.1.3-1-bookworm
LABEL org.opencontainers.image.title="Transcoda" \
      org.opencontainers.image.description="Node-based ffmpeg workflow runner" \
      org.opencontainers.image.source="https://github.com/transcoda/transcoda" \
      org.opencontainers.image.licenses="GPL-3.0"
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg tini procps; \
    curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor -o /usr/share/keyrings/jellyfin.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian bookworm main" \
      > /etc/apt/sources.list.d/jellyfin.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "jellyfin-ffmpeg8=${JELLYFIN_FFMPEG_VERSION}"; \
    apt-get purge -y --auto-remove curl gnupg; \
    rm -rf /var/lib/apt/lists/*; \
    command -v setpriv; \
    # The base image's "node" user (uid 1000) would clash with the default PUID.
    userdel node; \
    # npm, corepack and yarn are not used at runtime (less attack surface; no size gain).
    rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

WORKDIR /app
COPY --from=deps /deploy/package.json /app/package.json
COPY --from=deps /deploy/node_modules /app/node_modules
COPY --from=build /src/apps/server/dist/main.js /app/server/main.js
COPY --from=build /src/apps/server/dist/plugin-host.js /app/server/plugin-host.js
COPY --from=build /src/apps/server/dist/fixtures/denial-0.1.0.js /app/server/fixtures/denial.js
COPY --from=build /src/apps/web/dist /app/web
COPY --from=build /src/apps/server/third-party.json /src/apps/server/THIRD_PARTY_NOTICES.txt /app/
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/transcoda-entrypoint

# Optional build id (for example `--build-arg TRANSCODA_BUILD_ID=$(git rev-parse --short HEAD)`);
# a new one makes the server back up its database at start. Empty: it hashes /app/server/main.js.
ARG TRANSCODA_BUILD_ID=
ENV TRANSCODA_BUILD_ID=${TRANSCODA_BUILD_ID} \
    TRANSCODA_CONFIG_DIR=/config \
    TRANSCODA_TRANSCODE_DIR=/transcode \
    TRANSCODA_WEB_DIR=/app/web \
    TRANSCODA_FFMPEG_PATH=/usr/lib/jellyfin-ffmpeg/ffmpeg \
    NODE_ENV=production \
    PUID=1000 \
    PGID=1000 \
    PLUGIN_UID=65001 \
    PLUGIN_GID=65001 \
    UMASK=022

VOLUME ["/config", "/transcode"]
# /run/transcoda (plugin bundle staging) is expected to be a tmpfs mounted by compose; without
# one the entrypoint creates it on the writable layer.
EXPOSE 8080
# Probes TRANSCODA_HOST unless it is a wildcard (then 127.0.0.1). Host: localhost is always
# allowed by the host check, whatever address the server is bound to.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "const h=process.env.TRANSCODA_HOST;require('node:http').get({host:!h||h==='0.0.0.0'||h==='::'?'127.0.0.1':h,port:process.env.TRANSCODA_PORT||8080,path:'/api/v1/system/health',headers:{host:'localhost'},timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/transcoda-entrypoint"]
CMD ["node", "/app/server/main.js"]
