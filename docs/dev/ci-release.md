# CI, the image and releases

The rules in force today for `.github/workflows/`, `docker/`, `renovate.json`, `scripts/` and cutting a release. Where this page and the files in the repo disagree, the files in the repo win.

## On a pull request

- **CI** (`ci.yml`): job `check` runs `scripts/check-lockfile.ts` (every package in `pnpm-lock.yaml` and `docker/corepack/package-lock.json` resolves from `registry.npmjs.org` or a pinned commit of `transcoda/.github` on `codeload.github.com`, `.npmrc` and `pnpm-workspace.yaml` name no other registry and no pnpmfile exists; it runs before the install so an edited lockfile cannot fetch anything first), `pnpm install --frozen-lockfile`, `pnpm check` (typecheck, Biome with `--error-on-warnings`, knip, `check-deps`, `check-structure`, `check-lockfile`, `check-licences`, `check-file-size`, Vitest), `pnpm build`, and `docker/entrypoint.test.sh` in the image's Node base. Job `file-size` runs the org's `file-size` action: no source file over 1200 lines, and on a pull request no new or raised entry in `.github/file-size-allowlist.json` ([conventions.md](conventions.md#file-size)). Job `e2e` runs the browser and screenshot tests through `scripts/e2e-docker.sh`, the same script as `pnpm e2e:docker`.
- **Real ffmpeg** (`real-ffmpeg.yml`, job `real-ffmpeg`): only on pull requests that touch the engine, its capabilities, the core nodes, the fixture generator or the Dockerfiles that pin ffmpeg (the `paths` list in the file). It runs `pnpm test:docker`: the unit tests in the e2e container with the fixtures, so the real-ffmpeg tests that `check` skips run against jellyfin-ffmpeg. Not a required check, since it doesn't run on every pull request.
- **PR title** (`pr-title.yml`, job `pr-title`) and **Release note** (`release-note.yml`, job `release-note`) call the shared actions in the org's `.github` repository.
- **Screenshots** (`screenshots.yml`, job `screenshots`): a pull request that changes `apps/web/src/` (tests and `src/testing/` aside), `apps/web/index.html` or `apps/web/public/` needs an image in its description, or the `no screenshots needed` label when nothing visible changed. It runs again when the description or the labels change.
- **PR gate** (`pr-gate.yml`, commit status `pr-gate`): high-risk paths need the `risk-approved` label, external pull requests need CodeRabbit's and the owner's approval. See [The pr-gate check](#the-pr-gate-check).
- The `main` ruleset requires the `check`, `file-size`, `e2e`, `release-note`, `pr-title` and `screenshots` checks, one approving review (code owner review on), and allows squash merges only. A required check has to run on every pull request: a workflow with a `paths` filter (like `real-ffmpeg`) never reports on the pull requests it skips, and its missing check would block their merge. `screenshots` always runs and passes on its own when no web UI file changed.
- The script is named `check`, not `ci`: `pnpm ci` is a pnpm built-in.

## The pr-gate check

`pr-gate.yml` posts a commit status `pr-gate` on every pull request's head commit (`scripts/pr-gate.ts`, tests beside it). It fails unless:

- **A high-risk change carries `risk-approved`.** A pull request that changes `.github/`, `scripts/`, `docker/`, `e2e/`, any `Dockerfile*`, `.dockerignore`, `package.json`, `.npmrc`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.node-version`, `renovate.json`, `.coderabbit.yaml` or `apps/server/src/platform/official-plugins.ts` (`RISKY` in the script) needs the `risk-approved` label. A maintainer adds it by hand after reviewing the head commit, and it counts only when it was added after that commit was pushed. Every push removes it, so a reviewed change can't be changed afterwards; re-review and add it again. Agents never add this label, the owner does.
- **An external pull request is approved by both CodeRabbit and the owner on its head commit.** External means from a fork, or opened by anyone but the owner account. Both approvals have to be on the current head commit: a later push makes them stale.
- **Renovate's pull requests need the owner's approval on the head commit**, not CodeRabbit's (plus the label, since they change dependency files). Only a pull request opened by the `renovate[bot]` app (a Bot account) from a branch of this repository counts; a fork or a look-alike name is external.

How it stays out of the pull request's reach:

- It runs on `pull_request_target`, so GitHub runs `main`'s copy of the workflow and the script. It checks out `main`, installs nothing, and reads the pull request (files, labels, label events, reviews) only through the API, with `pull-requests: write` (to remove the label), `issues: read` and `statuses: write`.
- A check run from `pull_request_target` would attach to `main`'s commit, so the result is a commit status on the head commit, posted with the workflow's token (the GitHub Actions app).
- Reviews: `pr-review.yml` runs on `pull_request_review` with no permissions and does nothing; its completion starts `pr-gate.yml` again through `workflow_run`, from `main`, which finds the open pull request whose head is that commit through the API. Event fields reach the script only through `env` and the event file, and are checked before use.
- To re-evaluate by hand: `gh workflow run pr-gate.yml --ref main -f pr=<number>`. For example, a review on a first-time contributor's fork may not start `pr-review.yml` until its run is approved.

CodeRabbit approves once its blocking comments are resolved (`reviews.auto_approvals.enabled` in `.coderabbit.yaml`; everything else is at its defaults). It may not review a pull request by itself (it skips or pauses some, and its free plan has limits): when the head commit has no CodeRabbit review, comment `@coderabbitai review` on the pull request, and again after new pushes.

## On `main` and on tags

- `ci.yml` runs again on every push to `main`.
- **Main red** (`main-red.yml`): when a push run of CI or Docker on `main` fails, the org's `main-red` action opens one issue for that workflow, labelled `main-red`; a further failing run adds a comment, and the issue closes when the workflow passes on `main` again. It is a `workflow_run` workflow, so it runs from `main`'s copy only, and it must not get a `concurrency` group. To watch another workflow, add its `name:` to the list.
- **Docker** (`docker.yml`) runs on `main`, on `v*` tags and by hand, and publishes only for `main` and `v*` tags: a run by hand from another branch skips every job. Job `source` first fails the run unless the commit is on `main` (a tag: on `main` or a `release/*` branch, as `release.yml` requires). Job `image` builds amd64 and arm64 and pushes to `ghcr.io/transcoda/transcoda`. Then: `sandbox` (the plugin sandbox denial check inside the pushed image, natively per arch), `hardening` (the shipped compose file against the pushed image: capabilities, read-only root, plugin user), `vulnerabilities` (on `main` only) and `release-assets` (on release tags only). These run after the push, so a failure is a red run on an image that is already published.
- Image tags: `main` for the branch; `<version>`, `<major>.<minor>` and `latest` for a release tag; a pre-release gets only its own version. No commit-SHA tags.
- **GHCR cleanup** (`ghcr-cleanup.yml`) runs after each successful Docker run and weekly. It deletes untagged images older than a day only. A manual run defaults to a dry run.
- **Scorecard** (`scorecard.yml`) runs on `main` and weekly. It needs `permissions: read-all` at the top level; keep write permissions on the job.

## Nightly

`nightly.yml` runs daily at 07:17 UTC, only when `main` moved since the last finished nightly; a manual run always runs (job `changed`, the org's `nightly-changed` action). Job `unit` runs the unit tests with the fixture media in the e2e container (`pnpm test:docker`), so the real-ffmpeg tests run against the image's jellyfin-ffmpeg, and with `FC_NUM_RUNS=10000`, so each property test tries 10000 cases instead of 100 ([testing.md](testing.md#property-tests)). Job `e2e` runs the browser tests. Job `issues` runs the org's `nightly-issues` action on both JSON reports: one issue per failing test, labelled `nightly` and titled `Nightly: <file> > <test>`; a further failure adds a comment, a pass closes it. More than 10 new failures give one combined issue; a run that fails outside its tests gives one "the run failed outside its tests" issue. The workflow keeps its `concurrency` group (`nightly`, not cancelled), so two runs never open the same issue.

The plugins repository's nightly uses the same two actions.

## Code scanning

- **CodeQL is GitHub's default code-scanning setup** for this repository (JavaScript/TypeScript and Actions, weekly). It is configured in the repository settings. There is no CodeQL workflow file here; do not add one.
- Scorecard and the Grype scan upload SARIF to code scanning. **Vulnerability scan** (`vulnerability-scan.yml`) runs weekly on `main`'s image and the latest release's image, and `docker.yml` calls it for `main` after each build. It scans the image's signed SBOM when one exists, otherwise the image. It reports only vulnerabilities with a fix and never fails the build.

## The Docker image

- Built from `docker/Dockerfile` (build from the repo root). Three stages: `build`, `deps`, `runtime`.
- Base: `ARG NODE_IMAGE`, a Node bookworm-slim image pinned by exact patch tag and multi-arch digest. CI's entrypoint checks and `scripts/e2e-docker.sh` read that same line, so change it there only.
- ffmpeg: `jellyfin-ffmpeg8` from Jellyfin's apt repository, pinned by `ARG JELLYFIN_FFMPEG_VERSION`, at `/usr/lib/jellyfin-ffmpeg/ffmpeg`.
- Node 26 ships no corepack. The build stages install it with `npm ci` from `docker/corepack/` (a `package.json` and `package-lock.json` holding only corepack, so its version and hash are pinned), link its bin into `/usr/local/bin` and then use the pnpm that `packageManager` names. `e2e/Dockerfile` installs it the same way, from that folder as the `corepack` build context. Never `npm install -g` a package in a Dockerfile: Scorecard's Pinned-Dependencies check counts only `npm ci` as pinned. The runtime stage deletes npm, npx, corepack and yarn, and removes the base image's `node` user.
- Users: the entrypoint (`docker/entrypoint.sh`, under tini) starts as root, prepares ids and directories, then runs the server as `PUID:PGID` (default 1000) with only `SETUID`, `SETGID` and `KILL`. Plugin hosts run as `PLUGIN_UID:PLUGIN_GID` (default 65001) with no capabilities; ffmpeg and ffprobe children get none either. There is no `useradd`: ids are numeric, so the root filesystem can be read-only.
- `docker/docker-compose.yml` is the shipped hardening: `cap_drop: ALL` plus a short `cap_add` list, `no-new-privileges`, `read_only: true`, tmpfs for `/tmp` and `/run/transcoda`. The `hardening` job tests this file as shipped, so a change to it is a change to CI too.
- The healthcheck calls `/api/v1/system/health` with `Host: localhost` on `TRANSCODA_PORT`.
- Every pushed image gets keyless (Sigstore) build provenance and an SPDX SBOM attestation, pushed to GHCR next to it. A release also gets both as files on the GitHub Release: `transcoda-v<version>.sigstore.json` (the Sigstore bundle), `transcoda-v<version>.intoto.jsonl` (its signed DSSE envelope, one line, which Scorecard's Signed-Releases check needs for a 10) and `transcoda-v<version>.spdx.json`. How to verify: [`SECURITY.md`](../../SECURITY.md#verifying-the-image).
- Signed plugin catalogs are signed in the plugins repo's CI, not here. This repo only pins the public keys (`apps/server/src/platform/official-plugins.ts`).

## Release notes and PR titles

- Every pull request adds a `.changes/<name>.md` note or carries the `no user-facing change` label. The checker is the shared one: the org's `release-note` action with `layout: flat` runs `transcoda-release-note check` from `@transcoda/dev-config`, which also refuses commit hashes and pull request numbers in a note. `pnpm check` validates every note waiting in `.changes/` with the same rules (`scripts/changes.test.ts`), and `pnpm release` reads them through the same library (`@transcoda/dev-config/changes`). The plugins repository uses the same format, one folder per plugin. Format and highlights: [`.changes/README.md`](../../.changes/README.md).
- PR titles follow the house style `Area: what changed`. The area is free-form but starts with a capital letter or a digit, has no `(scope)`, and the title has no trailing full stop. No `feat:` or `chore(deps):`. Squash merges use the title as the commit message.

## Cutting a release

`pnpm release <version>` (`--dry-run` to preview) turns `.changes/` into a `CHANGELOG.md` section and the in-app list, and sets the version in the app's `package.json` files. Then a `Release: <version>` pull request with the `no user-facing change` label, and an annotated `v<version>` tag on its merge commit. `release.yml` checks that the tag matches `apps/server/package.json` and is on `main` or a `release/*` branch, then publishes the GitHub Release; `docker.yml` builds the image. Release tags are protected: never move or re-tag, cut the next patch. Full steps: [`docs/releasing.md`](../releasing.md).

## SDK publishing

`@transcoda/sdk` has its own version. Bump `packages/sdk/package.json` in a pull request, then push an `sdk-v<version>` tag on `main`. `sdk-publish.yml` has two jobs. `build` (no environment, read-only token) checks the tag, tests, builds and packs the SDK and uploads the tarball. `publish` waits for approval in the `npm` environment, installs nothing, and publishes that tarball with provenance through npm trusted publishing (no token). Steps: [`docs/releasing.md`](../releasing.md#releasing-the-plugin-sdk).

## Dependency updates (Renovate)

- One weekly window, Sunday 17:00 to 23:59 New York time; security fixes skip it and get the `security` label. Releases must be 3 days old first, except our own: `@transcoda/sdk`, and the shared tooling from `transcoda/.github`. Weekly lockfile maintenance in the same window.
- Every Renovate PR gets the `dependencies` and `no user-facing change` labels, and a house-style title (`Dependencies:`, `CI:` for actions, `FFmpeg:` for jellyfin-ffmpeg).
- Groups: `GitHub Actions`, `npm non-major` (majors one by one), `pnpm` (the `packageManager` field, on its own, as in the plugins repository so both move in the same week), `Node.js` (`node` and `@types/node`; majors are disabled and done by hand), `Playwright` (the npm package and the container image together; run `pnpm e2e:update` on that PR and commit the new baselines), `transcoda shared tooling` (the `@transcoda/dev-config` dev dependency and every `transcoda/.github/actions/*` pin move to the same tag in one PR, titled `CI:`).
- A regex manager keeps `JELLYFIN_FFMPEG_VERSION` in `docker/Dockerfile` current. corepack is an ordinary npm dependency in `docker/corepack/`: Renovate's npm manager updates its `package.json` and lockfile in their own `corepack` group, and lockfile maintenance refreshes the lockfile. A jellyfin-ffmpeg PR asks the reviewer to swap the label for a `.changes/` note when users would notice the update.
- There is no Dependabot.

## Toolchain pins

- Node: `.node-version` is the source of truth. CI reads it through `node-version-file`. Keep `NODE_IMAGE`, root `engines` and `@types/node` on the same release; a Node bump moves all four together.
- pnpm: `packageManager` in `package.json`, used through corepack locally and in the image, through `pnpm/action-setup` in CI.
- npm dependencies are exact pins (`save-exact=true` in `.npmrc`, `rangeStrategy: pin` in Renovate). `engine-strict=true`.
- Every action is pinned by full commit SHA with the version in a comment; Renovate updates both. The Dockerfile syntax and the base image are pinned by digest, and corepack by its lockfile's integrity hash.
- Workflows declare `permissions: contents: read` (Scorecard: `read-all`) at the top and grant write access per job only.
- Every `actions/checkout` sets `persist-credentials: false`: no job here pushes with git, so none keeps the token in `.git/config`.
- A job that holds a publishing credential (an environment, an OIDC token for npm) installs no dependencies and restores no cache: it takes what an earlier job built as an artifact.
