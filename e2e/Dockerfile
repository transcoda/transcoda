# The one place the browser tests run for screenshots: the same Linux, fonts and Chromium locally
# and in CI, so a baseline made on one matches the other. scripts/e2e-docker.sh builds and runs it.
# Its tag moves with @playwright/test (Renovate groups them).
FROM mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579

# Node (the node_image build context), corepack (the corepack build context: docker/corepack's
# lockfile, as docker/Dockerfile installs it) and jellyfin-ffmpeg at the version docker/Dockerfile
# pins; the script passes them.
ARG JELLYFIN_FFMPEG_VERSION
COPY --from=node_image /usr/local/bin/node /usr/local/bin/node
COPY --from=node_image /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=corepack package.json package-lock.json /opt/corepack/
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN set -eux; \
    ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    npm ci --prefix /opt/corepack --ignore-scripts --no-audit --no-fund; \
    ln -sf /opt/corepack/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack; \
    corepack enable; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg rsync; \
    curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor -o /usr/share/keyrings/jellyfin.gpg; \
    codename=$(. /etc/os-release && echo "$VERSION_CODENAME"); \
    echo "deb [signed-by=/usr/share/keyrings/jellyfin.gpg] https://repo.jellyfin.org/ubuntu $codename main" \
      > /etc/apt/sources.list.d/jellyfin.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "jellyfin-ffmpeg8=${JELLYFIN_FFMPEG_VERSION%-*}-$codename"; \
    rm -rf /var/lib/apt/lists/*
ENV PATH="/usr/lib/jellyfin-ffmpeg:${PATH}" \
    TRANSCODA_E2E_CONTAINER=1 \
    TRANSCODA_FIXTURE_FONT=/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf
# Runs as the calling user (the script passes -u): the copy, the store and corepack's cache are open.
RUN mkdir -p /work /pnpm-store && chmod 1777 /work /pnpm-store
ENV HOME=/tmp COREPACK_HOME=/pnpm-store/corepack
WORKDIR /work
