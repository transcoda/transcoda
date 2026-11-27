#!/bin/sh
# Runs the browser tests in e2e/Dockerfile's container, the way CI does. Screenshots compare against
# baselines made in that container, so update them here too:
#   pnpm e2e:docker                      # all specs
#   pnpm e2e:update                      # rewrite the screenshot baselines (e2e/__screenshots__)
#   pnpm e2e:docker e2e/3-visual.e2e.ts  # more Playwright arguments pass through
#   pnpm test:docker                     # the unit tests instead, with the fixtures, so the
#                                        # real-ffmpeg ones run against the image's jellyfin-ffmpeg
# The repo is copied into the container (Linux node_modules, its own build); only the baselines and
# the reports come back, into e2e/__screenshots__ and .local/ (JSON reports in .local/nightly/).
set -eu
mode=e2e
if [ "${1:-}" = --unit ]; then mode=unit; shift; fi
cd "$(dirname "$0")/.."
arg() { sed -n "s/^ARG $1=//p" docker/Dockerfile | head -n 1; }
node_image=$(arg NODE_IMAGE)
image=transcoda-e2e
# amd64 everywhere, as on the CI runner: Chromium draws text a little differently on arm64, and x265
# cannot build its thread pool there. On an Apple silicon Mac this runs under Rosetta.
platform=linux/amd64
docker build -q --platform "$platform" -t "$image" -f e2e/Dockerfile \
  --build-context "node_image=docker-image://$node_image" \
  --build-arg "COREPACK_VERSION=$(arg COREPACK_VERSION)" \
  --build-arg "JELLYFIN_FFMPEG_VERSION=$(arg JELLYFIN_FFMPEG_VERSION)" \
  e2e >/dev/null

tty=; [ -t 1 ] && tty=-t
# SYS_NICE lets libx265 set its NUMA memory policy: without it, on a host with NUMA nodes (the CI
# runner) ffmpeg logs "set_mempolicy" and the job page gains a note the baselines do not have.
# shellcheck disable=SC2016 # expanded inside the container
docker run --rm --platform "$platform" $tty --init -u "$(id -u):$(id -g)" --cap-add SYS_NICE --ipc=host -e CI -e GITHUB_ACTIONS \
  -v "$PWD:/src" -v transcoda-e2e-pnpm-store:/pnpm-store \
  "$image" sh -euc '
    mkdir /work/repo && cd /work/repo
    rsync -a --exclude node_modules --exclude dist --exclude .local --exclude .git /src/ ./
    pnpm config set store-dir /pnpm-store >/dev/null
    pnpm install --frozen-lockfile --reporter=silent
    mode=$1; shift
    [ "$mode" = unit ] || pnpm build >/dev/null
    pnpm fixtures >/dev/null
    status=0
    if [ "$mode" = unit ]; then
      pnpm test --reporter=default --reporter=json --outputFile.json=.local/nightly/vitest.json "$@" \
        || status=$?
    else
      pnpm exec playwright test "$@" || status=$?
    fi
    mkdir -p /src/.local/nightly
    [ -d .local/nightly ] && cp -r .local/nightly/. /src/.local/nightly/
    [ "$mode" = unit ] && exit $status
    rm -rf /src/.local/e2e-report /src/.local/e2e-results
    [ -d .local/e2e-report ] && cp -r .local/e2e-report /src/.local/
    [ -d .local/e2e-results ] && cp -r .local/e2e-results /src/.local/
    [ -d e2e/__screenshots__ ] && rsync -a --delete e2e/__screenshots__/ /src/e2e/__screenshots__/
    exit $status
  ' e2e "$mode" "$@"
