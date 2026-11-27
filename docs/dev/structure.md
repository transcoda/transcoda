# Structure

Where code goes in `apps/server/src`, `apps/web/src` and `packages/`, and how `pnpm check-structure` holds it there. Read this first when you add a file or a folder. Code style is in [conventions.md](conventions.md), test tiers in [testing.md](testing.md).

The layout below is the target. The repository is moving to it one pull request at a time (see "Migration status"), so some files still sit at their old paths. The check knows both: an old path is mapped onto its target layer, and whatever breaks a rule today is listed in `scripts/structure-allowlist.json`, a list that only shrinks.

## Three rules

**Rule A: layers.** Each folder directly under `src/` is an area, and so is each folder directly under the server's `engine/`. Areas are layered in a fixed order. A production file imports from its own layer and from layers below it, never from a layer above. Tests and test support may import anything.

**Rule B: a file that grows becomes a folder.** When `x.ts` nears 600 lines, or you are about to add `x-something.ts` next to it, make a module folder instead:

```
verify/
  verify.ts               the entry: named after the folder, the only file code outside imports
  verify.test.ts
  verify.targets.test.ts  a further test file on the same subject takes a dot part
  durations.ts            internal, named for what it holds (no "verify-" prefix)
  durations.test.ts
  testing.ts              fixtures and builders for this folder's tests (optional)
```

- A folder holding a file with its own name is a module folder. Code outside it imports only the entry; files inside it, tests included, import anything in it. Tests outside may also import its `testing.ts` or `testing/`.
- The entry holds real code (the public functions, the orchestration), not only re-exports. When code outside needs an internal type, the entry re-exports that one type.
- No `index.ts` barrels. An import names the entry file (`./verify/verify.ts`). `index.ts` means a registry, an ordered list of things, and only these three: `apps/server/src/nodes/core/index.ts`, `apps/server/src/db/migrations/index.ts`, `apps/server/src/mcp/tools/index.ts`. A package's entry point (`packages/shared/src/index.ts`, named in its `package.json` `exports`) is not a barrel.
- The other way round: a folder with fewer than three source files and no sub-folder goes back to being files in its parent.
- Areas themselves (`engine/`, `db/`, `jobs/`) are not module folders, even when one holds a file of its own name (`engine/engine.ts`).

**Rule C: test support is called `testing`.** Builders, fixtures and helpers that tests share live in a `testing.ts` (or `testing.tsx`) beside the tests, or in a `testing/` folder; data files in `fixtures/`. Production code never imports a test, a `testing` file, anything in `testing/` or `fixtures/`, or a file only tests import.

## Layers

The order the check uses is `LAYERS` in `scripts/check-structure.ts`, bottom first. A file belongs to the layer whose entry is the longest prefix of its path, so `engine/verify/verify.ts` is in `engine/verify` while `engine/engine.ts` falls through to `engine`.

Server, bottom to top:

`platform` < `engine/model` < `db` < `engine/events` < `capabilities` < `auth` < `engine/files` < `engine/media` < `engine/encode` < `engine/verify` < `nodes` < `workflows` < `plugin-host` < `plugins` < `engine/walk` < `engine/queue` < `engine/pipeline` < `engine` < `metrics` < `settings` < `system` < `rpc` < `http` < `mcp` < `app` < `main`

`platform/` imports no other area. `app/` (the composition root) imports everything and nothing imports it.

Web, bottom to top:

- **shared:** `components/`, `hooks/`, `lib/`, `api/`, `data/`, `assets/`, `styles/`. Imports no feature.
- **features:** `shell/`, `auth/`, `workflows/`, `editor/`, `jobs/`, `libraries/`, `plugins/`, `recycle/`, `settings/`. A feature may import another feature (Biome's `noImportCycles` keeps that acyclic); forbidding it would only grow a `shared/` dumping ground.
- **app:** `App.tsx` and `main.tsx`.

Only `App.tsx` imports a page. What two pages share moves to the feature folder's root, or to `components/`, `hooks/` or `lib/` when it knows no feature.

Packages keep their own direction, `shared <- sdk <- contract <- server/web`, checked by `pnpm check-deps`.

## Target tree

### `apps/server/src`

```
platform/        leaves with no domain knowledge: logger, config, process guards, build version,
                 fs-ops, child-caps, memory-guard; the official plugin catalog's URLs and keys and
                 the key-list format (deployment defaults config reads). Imports no other area.
db/              open, migrate, backups; testing.ts (createTestDb)
  migrations/    one file per migration, registered in index.ts
  repos/         one file (or module folder) per table group; all SQL lives here
    jobs/        jobs.ts (entry), rows.ts, list.ts, stats.ts, results.ts, trace.ts, journals.ts,
                 prior-runs.ts; testing.ts (a seeded database, job and result builders)
    files.ts     the files table and the fingerprint key
    recycled.ts  the recycle index
capabilities/    ffmpeg and GPU probes
auth/            sessions, tokens, CSRF, cookies, passwords, rate limits, host-check, request-info
nodes/           registry, remote nodes, availability, the CoreTools interface; core/ (the core nodes)
workflows/       the workflow service, upgrade, subworkflow settings, webhook URLs
  validate/      validate.ts (entry), nodes, outputs, graph, paths, subworkflows, issues, types;
                 testing.ts
plugin-host/     the plugin child process entry (bundled on its own)
plugins/         settings, crypto, installer, errors
  service/       service.ts (entry, PluginService), install, update, catalogs, listing; testing.ts
  trust/         catalogs, signatures, blocklist, guarded HTTP reads
  runtime/       supervisor, process, channel, isolation, limits, restart gate, hooks,
                 check-plugin and its sandbox expectations, dev plugins
  network/       fetch proxy, address policy, catalog-token hosts
  testing/       build, sign, spawn, global setup, fake child; fixtures/ (the fixture plugins)
engine/
  model/         what to do to a file: model.ts (entry), changes.ts, render.ts, targets.ts,
                 retarget.ts, fallback.ts. Imports nothing but platform.
  events.ts      the event bus types
  files/         touching the library: fingerprint, paths, replace, recycle, restore, sweep,
                 test outputs and their browser preview
  media/         reading a file: probe, media info, NFO, posters, content hash
  encode/        the ffmpeg child: process, progress, stall guard, log condensing
  verify/        verify.ts (entry), durations, stream checks, decode checks
  walk/          walk.ts (entry), check-source, already-processed, load-workflow, plugin context
  queue/         queue service, scheduler, catch-up, media pass, run hours
  pipeline/      pipeline.ts (entry), core, prepare, plan, encode, output, steps, branches, trace,
                 types; testing.ts (the harness)
  engine.ts      EngineService, which wires the above
  testing/       builders.ts (probeOf, fileOf, capsOf); fixtures.ts (the real-ffmpeg fixtures,
                 tempDir)
metrics/         the Prometheus catalogue, recorder and service
settings.ts      the settings service
system/          health, app update, folder browsing
rpc/             context, middleware, router, handlers, redaction
  procedures/    one file per contract router, same names
http/            plain Hono routes only
mcp/             the MCP server; tools/ (registered in index.ts)
app/             the composition root: app, bootstrap, deps, exit code; testing/ (createTestApp, send)
main.ts          the process entry
```

### `apps/web/src`

```
main.tsx, App.tsx   providers and routes
shell/              app chrome that knows features: Shell, ActivityButton
auth/               the auth provider, use-auth, LoginPage, SetupPage, HostNotAllowedPage
workflows/          WorkflowsPage, NewWorkflowPage, EmptyWorkflows, the bundled examples
  activation/       ActivateDialog, ActivationControl
editor/             EditorPage/, model/ (pure), flow/ (React Flow, on-node rows), ui/, trace/
jobs/               JobsPage/, JobPage/, RunPage/, and what those pages share at the root
libraries/          LibrariesPage/, LibraryPage/, LibraryFilePage/, and their shared parts
plugins/            PluginsPage/ and its parts
recycle/            RecyclePage, RestoreButton
settings/           SettingsPage and its sections
components/         primitives only: Dialog, Toast, Icon, Chips, Loading, NotFound, ...
api/, hooks/, lib/, data/   shared
styles/             every stylesheet, imported in order from styles/index.css
testing/            test setup, render helpers, fixtures
```

There is no `pages/` folder: each page lives in its feature. Stylesheets stay in `styles/` because they are one global cascade in a fixed order ([web-ui.md](web-ui.md)); name a new one after the feature it serves (`jobs-*.css`).

## The page pattern

Rule B applied to a React page:

```
jobs/JobPage/
  JobPage.tsx            the route component: load, guard states (Loading, NotFound, error),
                         compose the sections. Aim for under 300 lines.
  JobPage.test.tsx       the page's main states
  JobPage.plan.test.tsx  one more test file per topic
  JobHead.tsx            a section only this page uses, with JobHead.test.tsx beside it
  use-job-actions.ts     a page-only hook: the state, effects and handlers for one concern
  testing.tsx            render helpers and fixtures for this page's tests
```

- A page that fits in one file of about 400 lines stays a file (`RecyclePage.tsx`). It becomes a folder with its first private component or hook.
- A component or hook a second page uses moves to the feature root. One that a second feature uses stays in its feature root; only something with no feature knowledge goes to `components/` or `hooks/`.
- State and handlers leave a big page component as hooks named for the concern (`use-editor-save.ts`), not for the page.
- Folder names are kebab-case; a component's module folder is PascalCase, like its entry file.

## Test names

- A test sits beside its subject: `<subject>.test.ts` for `<subject>.ts`, and `<subject>.<topic>.test.ts` for a further file on the same subject (`jobs.history.test.ts`, `pipeline.gates.test.ts`, `paths.property.test.ts`, `pipeline.real.test.ts`). No `__tests__` folders.
- A test with no subject file (a docs sync test, a CSS guard, an end-to-end flow) is listed in `orphanTests` in `scripts/structure-allowlist.json`. Don't add to that list: give a new test a subject, or put a CSS guard beside its stylesheet in `styles/`.
- A test split by topic shares its setup through the folder's `testing.ts`.

## One name per router

The contract's routers set the vocabulary: `auth`, `tokens`, `settings`, `system`, `fs`, `nodes`, `workflows`, `libraries`, `jobs`, `queue`, `runs`, `recycle`, `events`, `plugins`. A procedure file, a repository file, an MCP tool file and a web feature folder that serve one router use its name, and a split test uses it as its first part (`jobs.history.test.ts`).

| Contract router | Server procedure | Server implementation | Web |
| --- | --- | --- | --- |
| `workflows` | `rpc/procedures/workflows.ts` | `workflows/` | `workflows/`, `editor/` |
| `jobs`, `queue`, `runs` | same names | `engine/queue/`, `engine/pipeline/`, `db/repos/jobs/` | `jobs/` |
| `libraries` | `rpc/procedures/libraries.ts` | `engine/queue/` (scan, catch-up), `db/repos/libraries.ts`, `db/repos/library-files.ts` | `libraries/` |
| `recycle` | `rpc/procedures/recycle.ts` | `engine/files/` | `recycle/` |
| `plugins` | `rpc/procedures/plugins.ts` | `plugins/` | `plugins/` |
| `settings`, `tokens`, `system`, `fs` | same names | `settings.ts`, `auth/`, `system/` | `settings/` |

## File size

The hard budget is 1200 lines for any file ([conventions.md](conventions.md#file-size)). On top of it, a source file (tests and fixtures aside, CSS included) has a soft limit of 800 lines, so a file becomes a module folder long before the budget. The files above 800 today are in `softSizeLimit` with their line count, which works like the file-size allowlist: it may only go down.

## The check

`pnpm check-structure` (`scripts/check-structure.ts`, part of `pnpm check`, well under a second) reads every file under `apps/*/src` and `packages/*/src`, resolves each relative import and each `@transcoda/*` import to a file, and checks the rules above. It also reads `AGENTS.md` and `docs/dev/*.md` (all but this doc, which names the target layout). It has no dependencies; its tests are in `scripts/check-structure.test.ts`.

Two pieces of data drive it:

- **The tables** at the top of `scripts/check-structure.ts`: `LAYERS` (each app's layers, bottom first, as path prefixes), `REGISTRIES` (the three `index.ts` files) and `PAGE_PARTS` (folders that belong to a page today). Entries marked "today" are old paths mapped onto their target layer. A target folder that does not exist yet is just a prefix that matches nothing.
- **The allowlists** in `scripts/structure-allowlist.json`: what broke each rule before the check existed. Each list only shrinks. An entry the code no longer needs fails the check until it is removed, so fixing the code and removing its entry go in the same pull request. Never add an entry to get past a failure.

| List | Key | Rule |
| --- | --- | --- |
| `upwardImports` | `importer -> imported` | Rule A |
| `moduleEntryImports` | `importer -> imported` | Rule B, entry only |
| `barrels` | file | Rule B, no `index.ts` |
| `testSupportImports` | `importer -> imported` | Rule C, production never imports test code |
| `testSupportNames` | file, or folder ending in `/` | Rule C, test support under another name |
| `pageImports` | `importer -> imported` | only `App.tsx` imports a page |
| `folderNames` | folder | kebab-case or a component's PascalCase |
| `smallFolders` | folder | at least three source files or a sub-folder |
| `orphanTests` | test file | test names |
| `softSizeLimit` | file: lines | the 800-line soft limit |
| `docPaths` | `doc: path` | back-ticked paths exist (for a path in another repository) |

### Fixing a failure

- **"… imports … a higher layer"**: move what you need down to the importer's layer or lower, or let the higher layer pass it in (a parameter, a callback, an interface the lower layer declares and the higher one implements).
- **"… is in no layer"**: add the new folder (or file) to the right layer in `LAYERS`. A new area needs a place in the order; say why in the pull request.
- **"… inside the module folder …"**: import the entry instead. If code outside needs something the entry does not export, export it from the entry.
- **"… is an index file"**: rename it after its folder (`verify/verify.ts`) and update the imports.
- **"… which is test code"**: production code needs something that lives in test support. Move that part into a production module, and let the test support import it from there.
- **"… only tests import it"**: it is test support. Move it into a `testing.ts` beside the tests that use it, or a `testing/` folder; if it is dead code, delete it.
- **"… only … App.tsx imports a page"**: move what both pages use to the feature root.
- **"a folder name …"**: rename the folder to kebab-case, or give a PascalCase folder its same-named component.
- **"… and no sub-folder"**: move the files up into the parent folder, with their tests.
- **"… is named after no source file beside it"**: rename the test after its subject, with a dot part for the topic.
- **"… over the soft limit"**: split the file into a module folder (Rule B). Listed files fail when they grow, and when they shrink until their number is lowered.
- **"… names `…`, which does not exist"**: you moved or deleted a file a doc names. Update the doc in the same pull request.
- **"… no longer breaks the rule: remove the entry"**: you fixed something. Delete the entry from `scripts/structure-allowlist.json`.

A move pull request updates the paths in the allowlists and the "today" entries in `LAYERS` along with the files; the check names every entry that no longer matches.

## Migration status

Steps 1 (the check and this doc), 2, 3, 4, 5 and 6 are done. Each later pull request ticks its line.

- [x] 2. Server: `platform/`, `app/` and `system/`; `host-check.ts` and `request-info.ts` into `auth/`.
- [x] 3. Server: fix the upward imports (`fingerprintKey` into the repository layer, the official plugin constants out of `plugins/`, `CoreTools` into `nodes/`).
- [x] 4. Server: `engine/` sub-areas, part 1: `model/`, `files/`, `media/`, `encode/`.
- [x] 5. Server: `engine/` sub-areas, part 2: `verify/`, `walk/`, `queue/`, `pipeline/`, `testing/`.
- [x] 6. Server: `plugins/` sub-folders (`trust/`, `runtime/`, `network/`) and its test support into `testing/`.
- [ ] 7. Server splits, one pull request each: `db/repos/jobs.ts` (done), `plugins/service.ts` (done), `workflows/validate.ts` (done), `engine/verify/verify.ts`.
- [ ] 8. Server: test names in the dot form; split the over-budget tests.
- [ ] 9. Web: `shell/`, `test/` to `testing/`, the CSS guard tests into `styles/`.
- [ ] 10. Web: pages into their features, in three pull requests; then delete `pages/`.
- [ ] 11. Web splits: the editor page's hooks, the jobs page, the over-budget page tests, the two largest stylesheets.
- [ ] 12. Packages: `shared/src/workflow` to `workflows`; split `contract.test.ts` per router.
- [ ] 13. Tighten: empty `upwardImports`, remove the "today" entries from `LAYERS` and `PAGE_PARTS`, and check this doc's paths too (`DOC_PATHS_SKIP`).

History: [2026-11](../decisions/2026-11.md) ("Source layout and its check").
