# The web app

The rules in force today for `apps/web/**`. History is in the decision files linked at the end; where they disagree with this page, the code wins. Colours, type, spacing, motion and icons are in [DESIGN.md](../../DESIGN.md); this page does not repeat its values.

## Layout of `apps/web/src`

- `App.tsx`: every route. `main.tsx`: fonts, stylesheets, theme before first paint, providers.
- `pages/`: one component per route (`WorkflowsPage`, `EditorPage`, `JobsPage`, `JobPage`, `RunPage`, `LibrariesPage`, `LibraryPage`, `LibraryFilePage`, `RecyclePage`, `PluginsPage`, `NewWorkflowPage`, `LoginPage`, `SetupPage`). `pages/settings/` holds Settings and its sections.
- `editor/`: the workflow editor. `model/` is pure (no React, no React Flow), `flow/` adapts it to React Flow, `ui/` is the panels, dialogs and hooks around the canvas, `trace/` is the read-only canvas on the job page.
- `jobs/`: job and run pieces (steps, plan view, result, queue bar, process again) and their wording modules (`steps.ts`, `jobText.ts`, `planText.ts`, `mediaText.ts`).
- `libraries/`, `plugins/`, `recycle/`, `examples/`: the parts of those pages that are big enough to stand alone.
- `components/`: shared primitives (`Shell`, `Dialog`, `Toast`, `Chips`, `Icon`, `Loading`, `NotFound`, `Headings`, `RowMenu`, `ListboxSelect`, `Disclosure`, `FilePath`, ...).
- `api/` (client, CSRF, error mapping), `hooks/` (data and event hooks), `lib/` (formatting, page title, guarded navigation, breakpoints, theme), `data/` (codec and language tables).
- `styles/`: `tokens.css` (vendored from the design handoff, excluded from Biome, never hand-edited except the additions DESIGN.md lists), the design guard tests and their one exceptions file.
- `test/`: setup, helpers and fixtures for the web tests.

## Talking to the server

- One oRPC client, `api` in `api/client.ts`, typed by `@transcoda/contract`. The web app imports types and shared logic from `@transcoda/contract` and `@transcoda/shared`, never from `@transcoda/sdk` or the server.
- Errors: `describeError` (`api/errors.ts`) turns anything thrown into `{ code, status, message }`. Use `safe(...)` (re-exported from `api/client.ts`) when you need a typed `err.code` from the contract's defined errors.
- Loading data: `useAsync(fn, deps)` (`hooks/useAsync.ts`). A failed `reload()` keeps the last data next to the error. Shared lists have their own hooks: `useCatalog` (one `nodes.list` for every consumer), `useWorkflows` / `useWorkflow`, `useLibraries`.
- Live updates: one event stream per tab, `EventsProvider` in `App.tsx`, above the routes so navigating does not reconnect. Subscribe with `useEvents`; refetch with `useRefetchOn(filter, reload)`, which also reloads after every reconnect or resync and coalesces to one reload a second. Never open a second `api.events.subscribe()`.

## Adding a page

- Register the route in `App.tsx` inside `<RequireAuth><Shell>...</Shell></RequireAuth>` (the editor uses `<Shell rail>`). A Settings section goes in `pages/settings/sections.ts`, not in `App.tsx`. Keep old URLs working with a `<Redirect>`.
- Nav items live in `components/Shell.tsx` (`NavLink`).
- Name the tab with `usePageTitle(...)` from `lib/pageTitle.ts`; never set `document.title` yourself. The title reads "Page · server name · Transcoda".
- Loading: the shared `Loading` component (a test fails if a page types its own "Loading…"). Missing item: `NotFound` (it sets its own title with `useOverrideTitle`). Load errors: a `role="alert"` line with the `describeError` message and "Try again".
- An error from an action inside a dialog shows inline in the dialog, not as a toast (toasts are inert under a modal).
- One h1 per page, no skipped heading levels; use `SectionHeading` and `GroupLabel` from `components/Headings.tsx`.
- Widths come from `lib/breakpoints.ts` (`usePhone` for the phone layout). Every page works at phone width; the editor alone is view-only below 1024 px ("needs a wider window").

## The editor model

- Graph changes go through `editor/model/graph-ops.ts`: pure functions that return a new graph or a refusal (`{ ok: false, refusal }`), shown as a toast. Do not mutate a graph anywhere else.
- Connection rules live in `editor/model/connection.ts` (`checkConnection`, `compatibleTargets`). The check order is: self-loop, ports exist, port types match, input is free. `editor/flow/connectionFit.ts` mirrors it for the drag feedback; change both together.
- State is the reducer in `editor/model/editor-state.ts`. A graph change is an `apply` action; moves and settings edits pass a `coalesce` key so one drag or one typing run is one undo step. Undo keeps 100 steps (`history.ts`). Nothing applies while `readOnly` (a past version).
- React Flow is only a view: `flow/toFlow.ts` builds its nodes and edges, `flow/fromFlow.ts` turns its changes back into graph ops. React Flow never deletes on its own; deletion is the editor's `removeSelection` / `removeNodes`.
- The server is the authority on validity: `useValidation` calls `api.workflows.validate` 400 ms after the last change. `editor/model/issues.ts` maps issues to what the canvas draws, and unknown issue codes render as a generic error or warning.
- The node catalogue comes from the server (`useCatalog`), never from a list in the web app. Unknown node types still render ("plugin missing", "unknown node").
- Leaving a dirty draft goes through `useLeaveGuard`. Links and navigation that can leave the editor use `GuardedLink`, `useGuardedNavigate` or `guardedRun` from `lib/navigation.tsx`.
- Keyboard (`editor/ui/useEditorKeys.ts`, plus `editor/ui/Canvas.tsx` for the toolbar): Tab and Shift+Tab move between nodes in graph order, Enter or "." enters a node's toolbar and Escape leaves it, Delete removes the selection, "/" opens node search, "c" connects from the selected node, Ctrl/Cmd+Z, Shift+Z, Y and S undo, redo and save. A new canvas action needs a keyboard path too.

## Job pages and wording

- `jobs/steps.ts` writes the job's step list ("What the workflow did / would do"). It words each step from the trace's structured parts (changes, findings, settings, the probe), not from the engine's reason text, except for conditions, data and plugin nodes, which only have that.
- The steps name the encoder that actually ran: when the plan's video conversion differs from what the graph built (a software fallback, a GPU retarget), Encode video's sentence uses the plan (`videoConversionOf`, `ranAs`).
- A badge on the job trace is the job's own problem or warning for that node (`result.nodeProblems`, drawn by `withJobProblems`), not the workflow's issues.
- Job states and verdict words come from `jobs/jobText.ts`; plan lines from `jobs/planText.ts`. Add a word there, not inline in a page.

## UI words

- Activation: "Activate", "Activate vN", "Roll back to vN" (below the active version, from `editor/model/version-text.ts`), "Deactivate", and the pill "Not active" / "Active v3" / "Active v3 · can't run" (`ActivationPill` in `editor/ui/ActivationControl.tsx`). Never "enable", "enabled" or "dry-run mode" for a workflow.
- Sizes are SI (1 kB = 1000 B) and always printed by `fmtBytes` (from `@transcoda/shared`, re-exported by `lib/bytes.ts`); bitrates by `fmtKbps` (`lib/rate.ts`). No GiB or MiB anywhere a person reads.
- Times and dates: the helpers in `lib/time.ts` (`fmtAgo`, `fmtAgoShort`, `fmtAgoLong`, `fmtWhen`, `fmtDate`, `fmtDuration`, ...). They use the browser's locale. Web tests run in a fixed non-UTC zone (set in `apps/web/vite.config.ts`).
- Labels and headings are typed in sentence case; capitals come from CSS on mono labels only (a test checks the source). Node kind words come from `KIND_WORD` in `components/Chips.tsx`.

## Design rules that tests check

- The guard tests in `apps/web/src/styles/` read the web stylesheets through a CSS parser (`styles/css-source.ts`) and hold them to DESIGN.md: tokens only for colour, font size, spacing and radius; hover only under `@media (hover: hover)`; no font-weight change on a selected state; focus rings never removed; limited shadows, transitions and z-index layers; named breakpoints only.
- `styles/design-doc-sync.test.ts` checks the values DESIGN.md quotes against the stylesheets. When they disagree, the stylesheet is right: update DESIGN.md.
- `src/design-source.test.tsx` checks the components: no colour literal in TypeScript, icons only from `components/Icon.tsx` (stroke `ICON_STROKE`, 2.4, not a prop), inline SVG only in the icon set and the listed drawings.
- Every exception to a design rule is in one file, `styles/design-exceptions.ts`, with its reason. Add one there only with a reason a reviewer can check. Do not add a second exceptions list.
- New styles go in the stylesheet for that page; the design tests pick them up through `styles/css-source.ts`.

## Accessibility

- Every control works from the keyboard and shows the focus ring; focus is never hidden under the sticky top bar.
- Nothing is hover-only: anything a hover reveals, focus reveals too, and hover styles are gated on `(hover: hover)`.
- Targets are 44px (24px at least for text links outside a sentence, with `.text-target`).
- Accessible names start with the visible label. Colour never carries meaning alone: a state has a word or an icon.
- Dialogs: `Dialog` handles focus. A danger dialog focuses Cancel; pass `returnFocusTo` when the opener (a menu item) unmounts.
- Forms use real labels, `aria-invalid` and `role="alert"` for errors.

## Web tests

- Unit tests sit beside the code (`*.test.ts(x)`), Vitest in jsdom with Testing Library. Find elements by role and accessible name. Which tier a test belongs in: [testing.md](testing.md).
- Vitest globals are off, so every file that imports `render` or `renderHook` has a top-level `afterEach(cleanup)` (Biome rule `scripts/biome/test-cleanup.grit`; one inside a `describe` does not count).
- Render a page with `renderAt(path, ui)` from `test/render.tsx` (a wouter memory router plus `ToastProvider`). Bare React Flow: `renderFlow` from `test/flow.tsx`. The event stream: `test/fakeEventStream.ts`. `test/setup.ts` gives jsdom the layout React Flow needs.
- Node definitions in tests come from `catalogFixture` / `nodesFixture` (`test/fixtures/catalog.ts`), never from `nodes.json` directly. `test/fixtures/nodes.json` is generated: `pnpm --filter @transcoda/server dump-nodes > apps/web/src/test/fixtures/nodes.json` (`apps/server/scripts/dump-nodes.ts`), then re-add the hand-written `test:unavailable` entry. `apps/server/src/nodes/web-fixture.test.ts` fails when the core nodes in it drift from the server.
- No `toMatchSnapshot` of component HTML. Assert what a user sees.
- A change to a page the browser tests cover: run `pnpm e2e:docker`, and update screenshot baselines with `pnpm e2e:update` when the change is on purpose (see [AGENTS.md](../../AGENTS.md)).

History: [M0 web scaffold, shell and Patchbay design](../decisions/2026-10-m0.md), [M2 editor](../decisions/2026-10-m2-editor.md), [M2 jobs, event stream and job pages](../decisions/2026-10-m2-jobs.md), [activation](../decisions/2026-10-activation-mcp.md), [editor patterns and UI rounds](../decisions/2026-10.md), [SI units, design audit, design rule checks, icon stroke](../decisions/2026-11.md).
