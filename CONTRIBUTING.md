# Contributing to Transcoda

Thanks for helping. Bug reports, ideas, docs fixes and code are all welcome.

## Before you start

- **Found a bug?** [Open an issue](https://github.com/transcoda/transcoda/issues/new/choose) with the bug template. Say what you did, what happened and what you expected. Logs help; take out secrets and file paths you don't want public first.
- **Have an idea?** Open an issue with the feature template before writing code, so we can agree on the approach. Small fixes (typos, an obvious bug) can go straight to a pull request.
- **Found a security problem?** Don't open an issue. Follow [SECURITY.md](SECURITY.md).
- **Want to write a plugin?** Plugins live in their own repository: [transcoda-plugins](https://github.com/transcoda/transcoda-plugins). The SDK is described in [`docs/plugin-sdk.md`](docs/plugin-sdk.md).

Issues labeled [`good first issue`](https://github.com/transcoda/transcoda/labels/good%20first%20issue) are a good place to start.

## Setting up

This is the one place the development setup is described; the README links here.

You need Node 26 (`>=26.13.1`, see `.node-version`), pnpm through corepack (Node 26 no longer bundles it) and ffmpeg for the capability probe and the test videos (`brew install ffmpeg` on a Mac; the Docker image uses jellyfin-ffmpeg instead).

```sh
git clone https://github.com/<you>/transcoda.git
cd transcoda
npm install -g corepack
corepack enable
pnpm install
pnpm fixtures                          # small test videos, made with ffmpeg (once per checkout)
pnpm --filter @transcoda/server dev    # API on http://localhost:8080, state in apps/server/.local/config
pnpm --filter @transcoda/web dev       # UI with hot reload on http://localhost:5173, proxies /api and /rpc to :8080
```

Open `http://localhost:5173`; the first visit asks you to create the admin account. `localhost` is always an allowed host.

| Command | Does |
| --- | --- |
| `pnpm check` | typecheck, lint, dependency-direction check, licence check and tests: what CI runs (`pnpm ci` is a pnpm built-in, so the script is named `check`) |
| `pnpm test` / `pnpm typecheck` / `pnpm lint` | one step of the above |
| `pnpm format` | Biome autofix |
| `pnpm build` | production bundles for web and server |
| `pnpm e2e:docker` | browser tests and screenshots, in Docker as CI runs them |
| `pnpm e2e:update` | after a UI change on purpose: new screenshot baselines |
| `pnpm test:docker` | unit tests with real ffmpeg, as the nightly runs them |
| `pnpm notices` | (not `pnpm licences`: that is a pnpm built-in) writes `apps/server/third-party.json` and `apps/server/THIRD_PARTY_NOTICES.txt` (git-ignored; the Docker build runs it) from the production dependencies of web and server, plus the image's jellyfin-ffmpeg, Node.js and Debian base and the vendored lucide icons |

`pnpm check` (and so CI) fails when a production dependency's licence is outside the allow-list (`ALLOWED` in `scripts/third-party-notices.ts`: permissive licences and OFL-1.1 for the fonts; GPL, LGPL and AGPL fail) or when a package ships no licence text. An exception, a corrected licence or a hand-supplied text goes in `scripts/licences/overrides.json`, keyed by package name (or `name@version`) and always with a `reason`; text files live beside it.

To run the production bundle without Docker: `pnpm build && TRANSCODA_CONFIG_DIR=./.local/prod-config TRANSCODA_WEB_DIR=apps/web/dist node apps/server/dist/main.js`. To build the image: `docker build -f docker/Dockerfile -t transcoda:dev .`

How the code is organised and the rules it follows: [`AGENTS.md`](AGENTS.md) and the topic docs in [`docs/dev/`](docs/dev/).

## Making a pull request

1. Fork the repository and create a branch from `main`.
2. Keep it to one change. Small pull requests get reviewed faster.
3. Add tests. A bug fix comes with a test that failed before the fix.
4. Run `pnpm check` and make sure it passes.
5. Add a release note: a small file in `.changes/` that tells users what they will notice ([format](.changes/README.md)). A change users won't notice (refactor, tests, tooling) needs none; say so in the pull request and a maintainer adds the `no user-facing change` label.
6. Open the pull request and fill in the template.

Never put secrets, API keys, real media or personal file paths in code, tests, logs or screenshots.

## How pull requests get merged

- CI must pass: `pnpm check`, the build, the release-note check and the PR-title check.
- A maintainer reviews it. Every pull request from a contributor needs a maintainer's approval before it can be merged.
- A maintainer merges it with **squash merge**: your branch becomes one commit on `main`, and the pull request title becomes the commit message. The title follows the house style `Area: what changed`, for example `Engine: a stopped job keeps its partial output` (a check enforces it; see [PR titles](#pr-titles)).
- If the pull request is meant for a particular release, a maintainer puts it in that release's milestone.

After merging, your change ships in the next release. How releases work: [`docs/releasing.md`](docs/releasing.md).

### PR titles

Squash merges make the title the commit message on `main`, so titles read as a history: `Area: what changed`.

- The area names the part of the project and starts with a capital letter or a digit. Areas in use: `Engine`, `Jobs`, `Libraries`, `Workflows`, `Editor`, `Plugins`, `Settings`, `Metrics`, `Design`, `UI`, `Docker`, `CI`, `Tests`, `Docs`, `Release`, `Dependencies`. A narrower one is fine when it says more (`Damaged sources`, `Verify`, `Job page`).
- After the colon, one space and a sentence in lower case that says what changed: `Engine: drop hardware encoders that cannot run here, and name the encoder that ran`.
- No conventional-commit prefixes (`feat:`, `fix(engine):`, `chore(deps):`), no `(scope)` and no full stop at the end.

## Code of conduct

Be kind and assume good intent. Keep discussion about the work. Harassment or personal attacks get you removed from the project.

## License

Transcoda is licensed under the [GNU General Public License v3.0](LICENSE). By opening a pull request you confirm that the contribution is your own work and may be distributed under that license.
