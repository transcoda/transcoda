# Testing

Today's rules for tests: which tier a test belongs in, the shared helpers, real-ffmpeg fixtures, browser tests and screenshots, and the nightly run. Code style for tests (no `.only`, `afterEach(cleanup)`) is in [conventions.md](conventions.md).

## Tiers

A change gets its test in the lowest tier that can catch the bug.

| Tier | Where | For | Not for | Budget |
| --- | --- | --- | --- | --- |
| Unit | `*.test.ts(x)` beside the code (Vitest; web tests use Testing Library in jsdom; the `scripts/` tests are Vitest's `scripts` project, not `node --test`) | One module's rules: planners, node logic, config parsing, a component's states and handlers | Anything that needs a real server, a real browser or a real ffmpeg | `pnpm test` whole, under 2 min |
| Server end-to-end | `*.test.ts` built on `createTestApp` and `app/testing/http.ts` (for example `apps/server/src/workflows/e2e.test.ts`) | A feature through the real HTTP and RPC API: auth, CSRF, validation, the database, the engine | Layout and anything only the browser does | Part of `pnpm test` |
| Real-ffmpeg | Tests that read `.local/fixtures` through `apps/server/src/engine/testing/fixtures.ts`, mostly `*.real.test.ts`; they skip when `pnpm fixtures` has not run | What ffmpeg really does with a plan: tracks, defaults, sizes, verify | Rules a probe object can show; those are unit tests | Part of `pnpm test` where fixtures exist |
| Render snapshots | `toMatchSnapshot` on generated output, such as the ffmpeg argv in `apps/server/src/engine/model/render.test.ts` | Text output that must not change by accident | UI markup: a snapshot of a component's HTML breaks on every harmless change and nobody reviews it | Part of `pnpm test` |
| Browser | `e2e/*.e2e.ts` (Playwright, Chromium) against the built server and the fixture media (`e2e/server.mjs`) | A few key flows end to end, and screenshots of the main pages | Every state of every page; those are unit tests | `e2e` CI job, under 10 min |

## Property tests

- Parsers and pure functions that take outside input (ffmpeg's output, HTTP headers, file paths, numbers to format) also get a property test with [fast-check](https://fast-check.dev): `<module>.property.test.ts` beside the code, in the unit tier, importing `fc from 'fast-check'`.
- Every `fc.assert` takes its options from `fcRuns()` (`@transcoda/shared/testing`) and sets no seed, so each run tries new cases. `fcRuns()` reads the number of cases from `FC_NUM_RUNS`: 100 by default, so `pnpm test` stays fast, and 10000 in the nightly's unit run.
- **Reproducing a failure.** fast-check prints the counterexample and a line like `{ seed: 1234567890, path: "12:3:0", endOnFailure: true }`. Pass those to the failing assert, for example `fc.assert(property, { ...fcRuns(), seed: 1234567890, path: '12:3:0' })`, and it replays that case straight away. Don't commit the seed: turn the counterexample into a plain example test instead.
- A property states what must hold for every input (never throws, stays in range, round-trips), not one example. When it finds a bug, the fix also gets that example test with the shrunk counterexample.
- These are what OpenSSF Scorecard's Fuzzing check counts: it looks for a TypeScript file that imports `fast-check`.

## Test names and test support

- A test sits beside its subject and is named after it: `<subject>.test.ts`, or `<subject>.<topic>.test.ts` for a further file on the same subject (`JobPage.plan.test.tsx`, `paths.property.test.ts`, `pipeline.real.test.ts`). No `__tests__` folders. A test with no subject file is in the `orphanTests` list in `scripts/structure-allowlist.json`, which only shrinks ([structure.md](structure.md#test-names)).
- Builders, fixtures and helpers tests share go in a `testing.ts` beside those tests, or a `testing/` folder; data files in `fixtures/`. Production code never imports them, and a file only tests import is test support and must be named so. `pnpm check-structure` checks both; the helpers below that still have older names are listed in `testSupportNames` until they move.

## Helpers to use

Use these instead of writing your own:

- **Server app and HTTP:** `createTestApp` (`apps/server/src/app/testing/app.ts`) builds the whole app over a migrated in-memory database, with a fixed secret key and a manual clock. `apps/server/src/app/testing/http.ts` has `send`, `login`, `withCsrf`, `secondUser`, `createToken`, `bearer`, the file-handle leak check (`trackFileHandles`, `expectAllClosed`), and `abortableGet` for a client that goes away mid-request: never pass `signal` to `app.request`, whose copy of the request follows it only weakly, so a garbage collection can drop the abort.
- **Database:** `createTestDb` (`apps/server/src/db/testing.ts`), a migrated in-memory SQLite.
- **Workflow graphs and registries:** `apps/server/src/workflows/testing.ts`: `node`, `edge`, `mainGraph`, `subGraph`, `chain`, `testRegistry`, `withSetting` and the test node definitions. Don't re-declare graph builders in a test file.
- **Engine inputs:** `apps/server/src/engine/testing/builders.ts`: `probeOf`, `fileOf`, `capsOf`, `withStream`, `withSidecar`, `packetRows`.
- **MCP:** `apps/server/src/mcp/testing.ts`.
- **Web:** `renderAt` (`apps/web/src/testing/render.tsx`) renders inside a router on an in-memory location, with the toast provider; `renderFlow` (`apps/web/src/testing/flow.tsx`) renders a bare React Flow for canvas tests; `apps/web/src/testing/fake-event-stream.ts` for the live event stream. The node catalogue fixture is `apps/web/src/testing/fixtures/nodes.json` (see "Fixtures that are checked" below).

## Real-ffmpeg fixtures

- `pnpm fixtures` (`scripts/fixtures/generate.ts`) makes small, reproducible test videos with your local ffmpeg into `.local/fixtures/` (git-ignored) and checks each with ffprobe. Run it once on a new checkout; without it the real-ffmpeg tests skip silently (`it.skipIf(!fixturesAvailable())`).
- The `check` job in CI has no fixtures, so these tests skip there. A pull request that touches the engine (`apps/server/src/engine/`, the disk, child-process and memory helpers in `platform/`, `capabilities/`, `nodes/core/`, the fixture generator, or the Dockerfiles that pin ffmpeg) also runs `real-ffmpeg.yml`: every unit test in the e2e container with the fixtures, against the image's jellyfin-ffmpeg (`pnpm test:docker`). The nightly runs the same for every change to `main`. Run `pnpm test:docker` (or `pnpm fixtures && pnpm test`) yourself before you push an engine change.
- Encoders in tests are software only (`libx264`, `libx265`). Hardware encoders are not tested automatically.

## Browser tests and screenshots

- **One server per run.** The specs share its state and run in order, one worker, no retries: `setup.e2e.ts` creates the admin and saves the session, `1-workflow` builds and activates a workflow, `2-library-jobs` scans the library it feeds, `3-visual` takes the screenshots. The server starts from an empty config folder (`E2E_WORK`, default `/tmp/transcoda-e2e`, a fixed path so pages that show a folder look the same everywhere). Nothing reaches the network.
- **Fixture media are invented movies,** copied from `pnpm fixtures` and backdated so the library's settle window takes them at once. Never use a real title.
- **Locators by role and accessible name.** A wait checks a row's own status, not text anywhere on the page.
- **Screenshots** are taken in three projects: light, dark (both 1280×720) and phone (Pixel 7, light). Baselines are in `e2e/__screenshots__/<project>/`. A pull request that changes the UI on purpose updates them with `pnpm e2e:update`, and every changed image is looked at before it is committed. A diff fails CI.
- **One renderer.** Screenshots are made and compared only in `e2e/Dockerfile`'s container (amd64, Rosetta on Apple silicon), which pins the same Node and jellyfin-ffmpeg as `docker/Dockerfile`. `scripts/e2e-docker.sh` builds it, runs everything inside and copies back only the baselines and the report; CI runs the same script. Outside the container (`pnpm e2e`) the screenshot projects are left out.
- **Volatile text is rewritten in the page,** not masked: dates, relative times, durations, the build version, sizes, bitrates and percentages.
- **Commands:** `pnpm e2e:docker` (everything, as CI), `pnpm e2e:update` (new baselines), `pnpm build && pnpm fixtures && pnpm e2e` (flows only, no Docker), `pnpm e2e:report` (the last HTML report). A failure keeps a screenshot and a trace in `.local/e2e-results`.

## Fixtures that are checked

- `apps/web/src/testing/fixtures/nodes.json` must match the live core node catalogue (`apps/server/src/nodes/web-fixture.test.ts`). Regenerate it with `pnpm --filter @transcoda/server dump-nodes > apps/web/src/testing/fixtures/nodes.json`, then re-add the hand-written `test:unavailable` entry (see `apps/web/src/testing/fixtures/catalog.ts`).
- `docs/metrics.md` and the Grafana example must match the metrics catalogue (`apps/server/src/metrics/catalog.sync.test.ts`).
- `docs/env.md`'s tables must name every environment variable `config.ts` reads, and no variable nothing reads (`apps/server/src/platform/config.docs.test.ts`). Its "Settings in the database" table must list `SETTING_KEYS` with their defaults (`apps/server/src/settings.docs.test.ts`).
- `docs/mcp.md`'s Tools table and tool count must match `ALL_TOOLS`, with each tool's scopes (`apps/server/src/mcp/mcp-docs.test.ts`).
- DESIGN.md's quoted values must match the stylesheets (the guard tests in `apps/web/src/styles/`).
- Every migration has its own test (`apps/server/src/db/migrate.conventions.test.ts`).
- The `.changes/` release notes are linted on every `pnpm check` (`scripts/changes.test.ts`).

## Nightly

- `.github/workflows/nightly.yml` runs once a night when `main` moved since the last finished nightly (a manual run always runs): the unit tests with fixtures in the e2e container (`pnpm test:docker`, with `FC_NUM_RUNS=10000` for the property tests), and the browser and screenshot tests.
- A failing test gets a GitHub issue labelled `nightly`, titled `Nightly: <file> > <test>` (the org's `nightly-issues` action, from `transcoda/.github`). A test that fails again gets a comment, a test that passes again gets its issue closed, more than 10 new failures get one "many tests fail" issue, and a run that fails outside its tests gets one "the run failed outside its tests" issue.
