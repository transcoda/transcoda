# CI, the image and releases

The rules in force today for `.github/workflows/`, `docker/`, `renovate.json`, `scripts/` and cutting a release. History is in the decision files linked at the end; where they disagree with this page, the files in the repo win.

## On a pull request

- **CI** (`ci.yml`): job `check` runs `pnpm install --frozen-lockfile`, `pnpm check` (typecheck, Biome with `--error-on-warnings`, knip, `check-deps`, `check-licences`, Vitest), `pnpm build`, and `docker/entrypoint.test.sh` in the image's Node base. Job `e2e` runs the browser and screenshot tests through `scripts/e2e-docker.sh`, the same script as `pnpm e2e:docker`.
- **PR title** (`pr-title.yml`, job `pr-title`) and **Release note** (`release-note.yml`, job `release-note`) call the shared actions in the org's `.github` repository.
- The `main` ruleset requires the `check`, `release-note` and `pr-title` checks, one approving review (code owner review on), and allows squash merges only. `e2e` runs on every pull request but is not a required check.
- The script is named `check`, not `ci`: `pnpm ci` is a pnpm built-in.

## On `main` and on tags

- `ci.yml` runs again on every push to `main`.
- **Docker** (`docker.yml`) runs on `main`, on `v*` tags and by hand. Job `image` builds amd64 and arm64 and pushes to `ghcr.io/transcoda/transcoda`. Then: `sandbox` (the plugin sandbox denial check inside the pushed image, natively per arch), `hardening` (the shipped compose file against the pushed image: capabilities, read-only root, plugin user), `vulnerabilities` (on `main` only) and `release-assets` (on release tags only). These run after the push, so a failure is a red run on an image that is already published.
- Image tags: `main` for the branch; `<version>`, `<major>.<minor>` and `latest` for a release tag; a pre-release gets only its own version. No commit-SHA tags.
- **GHCR cleanup** (`ghcr-cleanup.yml`) runs after each successful Docker run and weekly. It deletes untagged images older than a day only. A manual run defaults to a dry run.
- **Scorecard** (`scorecard.yml`) runs on `main` and weekly. It needs `permissions: read-all` at the top level; keep write permissions on the job.

## Nightly

`nightly.yml` runs daily at 07:17 UTC, only when `main` moved since the last finished nightly; a manual run always runs. Job `unit` runs the unit tests with the fixture media in the e2e container (`pnpm test:docker`), so the real-ffmpeg tests that pull requests skip run against the image's jellyfin-ffmpeg. Job `e2e` runs the browser tests. Job `issues` runs `scripts/nightly-issues.ts`: one issue per failing test, labelled `nightly` and titled `Nightly: <file> > <test>`; a further failure adds a comment, a pass closes it. More than 10 new failures give one combined issue; a run that fails before any report gives one "run failed" issue. The plugins repo runs the same script from its checkout of core.

## Code scanning

- **CodeQL is GitHub's default code-scanning setup** for this repository (JavaScript/TypeScript and Actions, weekly). It is configured in the repository settings. There is no CodeQL workflow file here; do not add one.
- Scorecard and the Grype scan upload SARIF to code scanning. **Vulnerability scan** (`vulnerability-scan.yml`) runs weekly on `main`'s image and the latest release's image, and `docker.yml` calls it for `main` after each build. It scans the image's signed SBOM when one exists, otherwise the image. It reports only vulnerabilities with a fix and never fails the build.

## The Docker image

- Built from `docker/Dockerfile` (build from the repo root). Three stages: `build`, `deps`, `runtime`.
- Base: `ARG NODE_IMAGE`, a Node bookworm-slim image pinned by exact patch tag and multi-arch digest. CI's entrypoint checks and `scripts/e2e-docker.sh` read that same line, so change it there only.
- ffmpeg: `jellyfin-ffmpeg8` from Jellyfin's apt repository, pinned by `ARG JELLYFIN_FFMPEG_VERSION`, at `/usr/lib/jellyfin-ffmpeg/ffmpeg`.
- Node 26 ships no corepack. The build stages install it from npm (`ARG COREPACK_VERSION`) and then use the pnpm that `packageManager` names. The runtime stage deletes npm, npx, corepack and yarn, and removes the base image's `node` user.
- Users: the entrypoint (`docker/entrypoint.sh`, under tini) starts as root, prepares ids and directories, then runs the server as `PUID:PGID` (default 1000) with only `SETUID`, `SETGID` and `KILL`. Plugin hosts run as `PLUGIN_UID:PLUGIN_GID` (default 65001) with no capabilities; ffmpeg and ffprobe children get none either. There is no `useradd`: ids are numeric, so the root filesystem can be read-only.
- `docker/docker-compose.yml` is the shipped hardening: `cap_drop: ALL` plus a short `cap_add` list, `no-new-privileges`, `read_only: true`, tmpfs for `/tmp` and `/run/transcoda`. The `hardening` job tests this file as shipped, so a change to it is a change to CI too.
- The healthcheck calls `/api/v1/system/health` with `Host: localhost` on `TRANSCODA_PORT`.
- Every pushed image gets keyless (Sigstore) build provenance and an SPDX SBOM attestation, pushed to GHCR next to it. A release also gets both as files on the GitHub Release. How to verify: [`SECURITY.md`](../../SECURITY.md#verifying-the-image).
- Signed plugin catalogs are signed in the plugins repo's CI, not here. This repo only pins the public keys (`apps/server/src/plugins/official-keys.ts`).

## Release notes and PR titles

- Every pull request adds a `.changes/<name>.md` note or carries the `no user-facing change` label. `scripts/check-release-note.mjs` is the checker; the org action runs it. `pnpm check` also validates every note waiting in `.changes/`. Format and highlights: [`.changes/README.md`](../../.changes/README.md).
- PR titles follow the house style `Area: what changed`. The area is free-form but starts with a capital letter or a digit, has no `(scope)`, and the title has no trailing full stop. No `feat:` or `chore(deps):`. Squash merges use the title as the commit message.

## Cutting a release

`pnpm release <version>` (`--dry-run` to preview) turns `.changes/` into a `CHANGELOG.md` section and the in-app list, and sets the version in the app's `package.json` files. Then a `Release: <version>` pull request with the `no user-facing change` label, and an annotated `v<version>` tag on its merge commit. `release.yml` checks that the tag matches `apps/server/package.json` and is on `main` or a `release/*` branch, then publishes the GitHub Release; `docker.yml` builds the image. Release tags are protected: never move or re-tag, cut the next patch. Full steps: [`docs/releasing.md`](../releasing.md).

## SDK publishing

`@transcoda/sdk` has its own version. Bump `packages/sdk/package.json` in a pull request, then push an `sdk-v<version>` tag on `main`. `sdk-publish.yml` waits for approval in the `npm` environment, checks the tag, tests, builds and publishes with provenance through npm trusted publishing (no token). Steps: [`docs/releasing.md`](../releasing.md#releasing-the-plugin-sdk).

## Dependency updates (Renovate)

- One weekly window, Sunday 17:00 to 23:59 New York time; security fixes skip it and get the `security` label. Releases must be 3 days old first (not `@transcoda/sdk`). Weekly lockfile maintenance in the same window.
- Every Renovate PR gets the `dependencies` and `no user-facing change` labels, and a house-style title (`Dependencies:`, `CI:` for actions, `FFmpeg:` for jellyfin-ffmpeg).
- Groups: `GitHub Actions`, `npm non-major` (majors one by one), `Node.js` (`node` and `@types/node`; majors are disabled and done by hand), `Playwright` (the npm package and the container image together; run `pnpm e2e:update` on that PR and commit the new baselines).
- Regex managers keep `JELLYFIN_FFMPEG_VERSION` and `COREPACK_VERSION` in `docker/Dockerfile` current. A jellyfin-ffmpeg PR asks the reviewer to swap the label for a `.changes/` note when users would notice the update.
- There is no Dependabot.

## Toolchain pins

- Node: `.node-version` is the source of truth. CI reads it through `node-version-file`. Keep `NODE_IMAGE`, root `engines` and `@types/node` on the same release; a Node bump moves all four together.
- pnpm: `packageManager` in `package.json`, used through corepack locally and in the image, through `pnpm/action-setup` in CI.
- npm dependencies are exact pins (`save-exact=true` in `.npmrc`, `rangeStrategy: pin` in Renovate). `engine-strict=true`.
- Every action is pinned by full commit SHA with the version in a comment; Renovate updates both. The Dockerfile syntax and the base image are pinned by digest.
- Workflows declare `permissions: contents: read` (Scorecard: `read-all`) at the top and grant write access per job only.

History: [M0 tooling, image and Actions](../decisions/2026-10-m0.md), [plugin isolation and image hardening](../decisions/2026-10-m3-plugins.md), [versioned releases](../decisions/2026-10.md), [Node 26, test tiers, nightly](../decisions/2026-11.md).
