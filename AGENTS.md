# Agent instructions

For coding agents working in this repository. Everything in [CONTRIBUTING.md](CONTRIBUTING.md) applies, and setup is there too. This file adds the rules agents tend to skip.

Today's rules for each area are in [`docs/dev/`](docs/dev/): [structure](docs/dev/structure.md), [testing](docs/dev/testing.md), [engine](docs/dev/engine.md), [server and API](docs/dev/server-api.md), [plugin host](docs/dev/plugins-host.md), [web UI](docs/dev/web-ui.md), [conventions](docs/dev/conventions.md), [CI and releases](docs/dev/ci-release.md). Where a topic doc and the code disagree, the code wins and the doc needs updating.

## Repo map

Where a new file or folder goes, the layer order and the naming rules: [docs/dev/structure.md](docs/dev/structure.md). Read it first. `pnpm check-structure` enforces it.

Dependencies point one way: `packages/shared` ← `packages/sdk` ← `packages/contract` ← `apps/server` and `apps/web`. `pnpm check-deps` enforces this and refuses relative imports across packages.

- **`packages/`**: `shared` (types and pure helpers both sides use), `sdk` (the published plugin and node SDK, `defineNode`), `contract` (every API procedure's route, input, output and errors, oRPC).
- **`apps/server/src`**: `app/` (the composition root: app, bootstrap, deps wiring), `platform/` (logger, `config.ts` with the environment variables, process guards, disk and child-process helpers); `rpc/` (procedures, guards), `http/` (plain routes), `auth/` (sessions, tokens, host check, proxies); `db/` (SQLite, migrations, repos, backups), `settings.ts`, `system/` (health, app update, folder browsing); `engine/` (`model/` what to do to a file, `files/` the library on disk, `media/` probing and sidecars, `encode/` the ffmpeg child, `verify/`, `walk/` the workflow walk, `queue/` the queue and scheduler, `pipeline/` a job's run), `capabilities/` (ffmpeg and GPU probes), `nodes/` (core nodes, registry), `workflows/` (validation, versions, activation); `plugins/` and `plugin-host/` (sandboxed plugin processes), `mcp/`, `metrics/`.
- **`apps/web/src`**: `App.tsx` (routes), `jobs/` (the Jobs, job and run pages and their parts), `libraries/`, `plugins/`, `recycle/`, `settings/`, `auth/` (sign-in, setup and their pages), `editor/` (`EditorPage/` the page and its hooks, `model/` pure, `flow/` React Flow and the on-node rows, `ui/`, `trace/`), `api/`, `hooks/`, `components/`, `shell/` (nav and app chrome), `workflows/` (the Workflows and new-workflow pages, activation, examples), `lib/`, `styles/` (tokens, per-area stylesheets, design guard tests), `testing/`.
- **Elsewhere**: `e2e/` (Playwright flows, screenshot baselines), `docker/` (the image), `examples/` (shipped workflows, Grafana dashboard), `scripts/` (repo checks, fixtures, release tooling).

## What done means

- `pnpm check` passes (typecheck, Biome with warnings as errors, knip, dependency, structure, licence and file-size checks, all tests). No file over 1200 lines; split it rather than grow an entry in `.github/file-size-allowlist.json` ([conventions.md](docs/dev/conventions.md#file-size)).
- **Release note:** a note in `.changes/` ([format](.changes/README.md)). Use the `no user-facing change` label instead when users will not notice the change.
- **Tests** are in the right tier ([testing.md](docs/dev/testing.md)), and a bug fix comes with a test that failed before the fix.
  - Run `pnpm fixtures` once per checkout. Without it, the real-ffmpeg tests skip silently.
  - After engine changes, run `pnpm test:docker`. CI runs it too (`real-ffmpeg`) on a pull request that touches the engine.
- **Docs:** update `README.md` and `docs/` for users, and the topic doc in `docs/dev/` when a rule changes.
- **UI changes:** add the screenshots described under "UI changes".
- **Pull request title:** `Area: what changed`, e.g. `Engine: drop hardware encoders that cannot run here`.
  - Areas in use: Engine, Jobs, Libraries, Workflows, Editor, Plugins, Settings, Metrics, Design, UI, Docker, CI, Tests, Docs, Release, Dependencies, Structure (the source layout and its check, [structure.md](docs/dev/structure.md)).
  - No `feat:` or `fix(x):`, and no full stop ([details](CONTRIBUTING.md#pr-titles)).
- **Names:** fixtures, docs and screenshots use invented titles and names only. Never a real show, film, person, host or address.

## Changing a rule

A change to how things work updates the rule, as it stands now, in its topic doc in `docs/dev/`. The pull request says why.

A code comment that rests on a rule cites the topic doc, or gives the reason itself.

## Recipes

**Add a core node**
1. Define it with `defineNode` in `apps/server/src/nodes/core/<file>.ts`, with a test beside it. It needs:
   - type `core:<kebab-name>` and a `kind`;
   - an `icon` that `apps/web/src/components/NodeIcon.tsx` can draw;
   - a settings schema and its hooks.
2. Add it to `coreNodes` in `apps/server/src/nodes/core/index.ts` and to the list in `apps/server/src/nodes/core/index.test.ts`.
3. Regenerate the web fixture. `apps/server/src/nodes/web-fixture.test.ts` fails until you do.
   - Run `pnpm --filter @transcoda/server dump-nodes > apps/web/src/testing/fixtures/nodes.json`.
   - Re-add the hand-written `test:unavailable` entry (see `apps/web/src/testing/fixtures/catalog.ts`).
4. Give an action node its job-page sentence in `ACTIONS` in `apps/web/src/jobs/JobPage/steps.ts`, tested in `steps.test.ts`. Condition and data nodes show the engine's reason.
5. To change an existing node's settings, bump its `version` and add a step to its `migrations` (`NodeMigration` in `packages/sdk/src/node.ts`); saved workflows must keep working. Update `docs/plugins.md` or `examples/` if they show the node.

**Add a migration**
- Write `apps/server/src/db/migrations/NNNN_snake_case.ts` with the next number. Use frozen SQL and keep existing data.
- Give it its own `NNNN_snake_case.test.ts`.
- Register it, in order, in `apps/server/src/db/migrations/index.ts`.
- `apps/server/src/db/migrate.conventions.test.ts` checks all three. Never edit a shipped migration.

**Add an RPC procedure**
1. Contract:
   - `packages/contract/src/routers/<area>.ts`: route, input, output, `.errors(...)`.
   - Schemas go in `packages/contract/src/schemas/<area>.ts`; a new error code in `packages/contract/src/errors.ts`.
   - Update the router's test beside it, `packages/contract/src/routers/<area>.test.ts`.
2. Server:
   - Implement it in `apps/server/src/rpc/procedures/<area>.ts` with a guard from `rpc/middleware.ts`, with a test beside it.
   - Register it in `createRouter()` in `apps/server/src/rpc/router.ts`.
   - REST (`/api/v1`) and OpenAPI come from the contract; nothing else to add.
3. MCP, if agents should have it:
   - Add it with `defineTool` in `apps/server/src/mcp/tools/<group>.ts`, with a test.
   - Add it to `ALL_TOOLS` in `mcp/tools/index.ts` and to `EXPECTED_TOOLS` in `mcp/never.test.ts`.
   - Add its row to the Tools table in `docs/mcp.md` and update the tool count; `apps/server/src/mcp/mcp-docs.test.ts` checks both and each tool's scopes.
   - Activation and other human-only actions get no tool.
4. Web: call it through `api` (`apps/web/src/api/client.ts`) from a hook.

**Add a page**
- The page in its feature folder (`apps/web/src/recycle/RecyclePage.tsx`; a page with parts of its own is a folder, `apps/web/src/jobs/JobPage/`) and its route in `apps/web/src/App.tsx`.
- Its route pattern in `ROUTE_PATTERNS` (`packages/shared/src/client-errors.ts`), so error reports can name the page; `apps/web/src/lib/client-errors/routes.test.ts` checks the two lists match. Only `App.tsx` imports a page.
- A nav item in `apps/web/src/shell/Shell.tsx` if it needs one.
- `usePageTitle` for the tab title, and the shared `Loading` and `NotFound` states.
- Its styles in its area's file under `apps/web/src/styles/`, or a new file imported from `styles/index.css` at the right place in the cascade (a guard test fails on a file that is not imported). Never add to `assorted.css`.
- A unit test with `renderAt`. Add a browser flow or screenshot only for a key page ([web-ui.md](docs/dev/web-ui.md)).

**Add a setting** (stored in the database, edited in Settings)
- Contract: `SettingsSchema` and `SettingsUpdateInputSchema` in `packages/contract/src/schemas/settings.ts`.
- Server: `SETTING_KEYS` and `SETTING_DEFAULTS` in `apps/server/src/db/repos/settings.ts`, and `apps/server/src/settings.ts` with `settings.test.ts`.
- Web: the section in `apps/web/src/settings/`, and the fixture in `apps/web/src/settings/testing.ts`.
- Docs: the "Settings in the database" table in `docs/env.md`, with the default. `apps/server/src/settings.docs.test.ts` checks its keys and defaults against `SETTING_KEYS` and `SETTING_DEFAULTS`.

**Add an environment variable**
- Parse it only in `loadConfig()` in `apps/server/src/platform/config.ts`, tested in `config.test.ts`.
- Document it in a table row in `docs/env.md`. `apps/server/src/platform/config.docs.test.ts` fails when a variable `config.ts` reads has no row, or a row names one nothing reads.
- If Settings shows it read-only, see `apps/server/src/settings.ts` and `apps/web/src/settings/source-text.ts`.

**Add a metric**
- Define it in `METRICS` in `apps/server/src/metrics/catalog.ts`.
- Fill its value in `metrics/service.ts`, `metrics/recorder.ts` or `db/repos/metrics.ts`.
- Add it to `docs/metrics.md` in catalogue order. `apps/server/src/metrics/catalog.sync.test.ts` checks the doc and `examples/grafana/transcoda-dashboard.json`.

## Test helpers

Use these rather than re-declaring them ([more](docs/dev/testing.md#helpers-to-use)): `createTestApp` (`apps/server/src/app/testing/app.ts`); `send`, `login`, `withCsrf`, `createToken`, `abortableGet` (`apps/server/src/app/testing/http.ts`); `createTestDb` (`apps/server/src/db/testing.ts`); `node`, `edge`, `mainGraph`, `testRegistry` (`apps/server/src/workflows/testing.ts`); `probeOf`, `fileOf`, `capsOf` (`apps/server/src/engine/testing/builders.ts`); `fixturesAvailable` (`apps/server/src/engine/testing/fixtures.ts`); `renderAt` (`apps/web/src/testing/render.tsx`).

## UI changes

- A UI fix or change counts as done only with **before and after screenshots** of the affected page, at the widths and in the themes it touches. Put both in the pull request description. The `screenshots` check fails a pull request that changes `apps/web/src/` without an image there; a change nobody can see (a refactor, a test helper) gets the `no screenshots needed` label instead.
- Run the browser tests (`pnpm e2e:docker`) when a change touches a page or a flow they cover. When a page changes on purpose, update its screenshot baselines with `pnpm e2e:update`, look at every changed image, and commit them in the same pull request.
- Follow [DESIGN.md](DESIGN.md) for colours, type, spacing and icons.
- CSS lives in per-area files under `apps/web/src/styles/`, imported in a fixed order from `styles/index.css` (`tokens.css` first). Put a rule in its area's file; a new area gets a new file imported at the right place. Don't add to `assorted.css`, and never reorder the imports ([web-ui.md](docs/dev/web-ui.md)).
