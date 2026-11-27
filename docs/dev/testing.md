# Testing

Today's rules for tests: which tier a test belongs in, the shared helpers, real-ffmpeg fixtures, browser tests and screenshots, and the nightly run. Code style for tests (no `.only`, `afterEach(cleanup)`) is in [conventions.md](conventions.md).

## Tiers

A change gets its test in the lowest tier that can catch the bug.

| Tier | Where | For | Not for | Budget |
| --- | --- | --- | --- | --- |
| Unit | `*.test.ts(x)` beside the code (Vitest; web tests use Testing Library in jsdom) | One module's rules: planners, node logic, config parsing, a component's states and handlers | Anything that needs a real server, a real browser or a real ffmpeg | `pnpm test` whole, under 2 min |
| Server end-to-end | `*.test.ts` built on `createTestApp` and `test-http.ts` (for example `apps/server/src/workflows/e2e.test.ts`) | A feature through the real HTTP and RPC API: auth, CSRF, validation, the database, the engine | Layout and anything only the browser does | Part of `pnpm test` |
| Real-ffmpeg | Tests that read `.local/fixtures` through `apps/server/src/engine/fixtures.ts`, mostly `*.real.test.ts`; they skip when `pnpm fixtures` has not run | What ffmpeg really does with a plan: tracks, defaults, sizes, verify | Rules a probe object can show; those are unit tests | Part of `pnpm test` where fixtures exist |
| Render snapshots | `toMatchSnapshot` on generated output, such as the ffmpeg argv in `apps/server/src/engine/render.test.ts` | Text output that must not change by accident | UI markup: a snapshot of a component's HTML breaks on every harmless change and nobody reviews it | Part of `pnpm test` |
| Browser | `e2e/*.e2e.ts` (Playwright, Chromium) against the built server and the fixture media (`e2e/server.mjs`) | A few key flows end to end, and screenshots of the main pages | Every state of every page; those are unit tests | `e2e` CI job, under 10 min |

## Helpers to use

Use these instead of writing your own:

- **Server app and HTTP:** `createTestApp` (`apps/server/src/test-app.ts`) builds the whole app over a migrated in-memory database, with a fixed secret key and a manual clock. `apps/server/src/test-http.ts` has `send`, `login`, `withCsrf`, `secondUser`, `createToken`, `bearer` and the file-handle leak check (`trackFileHandles`, `expectAllClosed`).
- **Database:** `createTestDb` (`apps/server/src/db/test-db.ts`), a migrated in-memory SQLite.
- **Workflow graphs and registries:** `apps/server/src/workflows/test-helpers.ts`: `node`, `edge`, `mainGraph`, `subGraph`, `chain`, `testRegistry`, `withSetting` and the test node definitions. Don't re-declare graph builders in a test file.
- **Engine inputs:** `apps/server/src/engine/test-helpers.ts`: `probeOf`, `fileOf`, `capsOf`, `withStream`, `withSidecar`, `packetRows`.
- **MCP:** `apps/server/src/mcp/test-client.ts`.
- **Web:** `renderAt` (`apps/web/src/test/render.tsx`) renders inside a router on an in-memory location, with the toast provider; `renderFlow` (`apps/web/src/test/flow.tsx`) renders a bare React Flow for canvas tests; `apps/web/src/test/fake-event-stream.ts` for the live event stream. The node catalogue fixture is `apps/web/src/test/fixtures/nodes.json` (see "Fixtures that are checked" below).

## Real-ffmpeg fixtures

- `pnpm fixtures` (`scripts/fixtures/generate.mjs`) makes small, reproducible test videos with your local ffmpeg into `.local/fixtures/` (git-ignored) and checks each with ffprobe. Run it once on a new checkout; without it the real-ffmpeg tests skip silently (`it.skipIf(!fixturesAvailable())`).
- The `check` job in CI has no fixtures, so these tests skip on pull requests. They run in the e2e container in the nightly (`pnpm test:docker`), against the image's jellyfin-ffmpeg. When you change the engine, run `pnpm test:docker` (or `pnpm fixtures && pnpm test`) yourself.
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

- `apps/web/src/test/fixtures/nodes.json` must match the live core node catalogue (`apps/server/src/nodes/web-fixture.test.ts`). Regenerate it with `pnpm --filter @transcoda/server dump-nodes > apps/web/src/test/fixtures/nodes.json`, then re-add the hand-written `test:unavailable` entry (see `apps/web/src/test/fixtures/catalog.ts`).
- `docs/metrics.md` and the Grafana example must match the metrics catalogue (`apps/server/src/metrics/sync.test.ts`).
- DESIGN.md's quoted values must match the stylesheets (the guard tests in `apps/web/src/styles/`).
- Every migration has its own test (`apps/server/src/db/migration-conventions.test.ts`).
- The `.changes/` release notes are linted on every `pnpm check` (`scripts/changes.test.ts`).
- Every decision-log entry is dated and listed in its index (`scripts/decisions-index.test.ts`).

## Nightly

- `.github/workflows/nightly.yml` runs once a night when `main` moved since the last finished nightly (a manual run always runs): the unit tests with fixtures in the e2e container (`pnpm test:docker`), and the browser and screenshot tests.
- A failing test gets a GitHub issue labelled `nightly`, titled `Nightly: <file> > <test>` (`scripts/nightly-issues.ts`). A test that fails again gets a comment, a test that passes again gets its issue closed, more than 10 new failures get one "many tests fail" issue, and a run that fails before any report gets one "the run failed" issue.
- The plugins repository runs the same script against core `main`.

History: [2026-11](../decisions/2026-11.md) ("Test tiers", "Nightly tests and their issues"), [M2 editor](../decisions/2026-10-m2-editor.md) ("M2 Task 1").
