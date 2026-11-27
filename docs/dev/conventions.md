# Code conventions

Today's rules for how code is written here. Most of them are checked by `pnpm check`; the rest are listed under "Not checked". Error and logging rules for the server are in [server-api.md](server-api.md), test tiers in [testing.md](testing.md), the design system in [DESIGN.md](../../DESIGN.md).

## TypeScript

- Strict mode with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax` (`@transcoda/dev-config/tsconfig.base.json`, the base the plugins repository extends too; every `tsconfig.json` here extends it). `pnpm typecheck` runs `tsc -b` over the solution file.
- Node runs `.ts` directly. Relative imports name the extension (`./x.ts`).
- Scripts in `scripts/` are TypeScript too (`node scripts/x.ts`), type-checked by `pnpm typecheck` through `scripts/tsconfig.json`. Node strips the types, so use only erasable syntax: no `enum`, no `namespace`, no constructor parameter properties. The types of `@transcoda/dev-config` (plain JavaScript) that the scripts use are declared in `scripts/dev-config.d.ts`.
- Packages depend one way, `shared <- sdk <- contract <- server/web`; no relative import from one workspace package into another. `pnpm check-deps` (`scripts/check-deps.ts`) enforces both.

## Checked by Biome

`biome.json` extends the shared base, `@transcoda/dev-config/biome` from the org's `.github` repository: the formatter, Biome's recommended preset and the rules below that both repositories share. `biome.json` adds this repository's files, its own rules (file names, CSS) and exceptions as `overrides`, and turns on the base's two GritQL rules for its paths. All are errors:

- **Imports:** extensions on relative imports (`useImportExtensions`); no import cycles (`noImportCycles`); no deprecated imports (`noDeprecatedImports`).
- **Exports:** no default exports (`noDefaultExport`). Exempt: tool config files (`*.config.{ts,mts,js,mjs}`, in the shared base), plugin fixtures (the plugin format is a default export) and Vitest's `globalSetup`.
- **Types:** no `any` (`noExplicitAny`), no non-null `!` (`noNonNullAssertion`), `T[]` rather than `Array<T>` (`useConsistentArrayType`).
- **Promises:** no floating promises, no `await` on a non-promise (`noFloatingPromises`, `useAwaitThenable`).
- **Console:** no `console` in app and package source (`noConsole`). The server logs through `apps/server/src/logger.ts`, the one exempt file.
- **Tests:** `it`, not `test`; hooks above the tests; never commit `.only` or `.skip` (`skipIf` is fine) (`useConsistentTestIt`, `useTestHooksOnTop`, `noFocusedTests`, `noSkippedTests`).
- **File names:** kebab-case in server, package, script and e2e code (`useFilenamingConvention`). Migrations are `NNNN_snake_case.ts`. Web file names are not checked yet: components are PascalCase (`JobPage.tsx`), and modules are a mix of camelCase and kebab-case; follow the folder you are in.
- **CSS:** no hex colours in the web stylesheets (`noHexColors`); colours come from the tokens.
- **UTC dates** (`utc-dates.grit` from the shared package): no local-time `Date` methods (`getHours`, `toLocaleDateString`, ...) in server or package code. Times are UTC. A place that really means local time has a `biome-ignore lint/plugin/utc-dates` with its reason (backup file names, the day in an "already processed" reason). GritQL has no types, so `toLocaleString` is flagged only on `new Date(...)` or a receiver named like a date (`d`, `*Date*`, `*Time*`, `*Now*`, `*When*`, `*Day*`, `*At`).
- **Web test cleanup** (`test-cleanup.grit` from the shared package): a web test file that imports `render` or `renderHook` has a top-level `afterEach(cleanup)`, or an `afterEach` whose callback calls `cleanup()`. Web tests run without Vitest globals, so Testing Library cannot clean up by itself.
- Formatting: two spaces, single quotes, 100 columns. `pnpm format` fixes it.
- A rule both repositories should follow goes in the shared base (`biome/base.json` in `transcoda/.github`), not here; a rule only this repository needs goes in `biome.json`'s `overrides`.
- A suppression (`biome-ignore`) always says why. Don't add one to get past a rule you could follow.

## Checked by tests

- **Migrations** (`apps/server/src/db/migration-conventions.test.ts`): named `NNNN_snake_case.ts`, numbered 1..N without gaps, registered in `apps/server/src/db/migrations/index.ts` in order with a matching `version` and `name`, each with its own test. The allowlist of old untested migrations may only shrink.
- **Design rules** (the guard tests in `apps/web/src/styles/`): spacing, radius, colour, focus, motion, z-index and icon rules from DESIGN.md, read from the stylesheets through `apps/web/src/styles/css-source.ts`. Every exception is in `apps/web/src/styles/design-exceptions.ts`, with its reason. Details in [web-ui.md](web-ui.md).
- **Licences** (`pnpm check-licences`): production dependencies must be under an allowed licence (`ALLOWED` in `scripts/third-party-notices.ts`); exceptions go in `scripts/licences/overrides.json` with a `reason`.
- **Docs in sync:** the node catalogue fixture, `docs/metrics.md`, DESIGN.md's quoted values and the release notes in `.changes/` (see [testing.md](testing.md#fixtures-that-are-checked)).

## Not checked

- **Words.** Every size a person reads or types is SI (1 kB = 1000 B), printed by `fmtBytes` from `@transcoda/shared`; binary units stay in internal byte math only. Times are stored and logged in UTC. UI text is short, plain and says what happened; match the words existing pages use (see [web-ui.md](web-ui.md)).
- **Names in public text.** Fixtures, tests, docs, screenshots and commit messages use invented titles (Otter and Finch, Harbor Lights, ...). Never a real show or film, a real person, an email address, a hostname or a private IP.
- **Comments** say why, not what. A comment that cites a decision points to the topic doc in `docs/dev/` or to the log entry by its heading (`docs/decisions/<file>.md`, "M1 engine Task 13: replace").
- **Biome warnings** do not fail CI yet. Don't add new ones.

History: [2026-11](../decisions/2026-11.md) ("Code consistency checks", "Design rule checks", "SI units everywhere"), [M0](../decisions/2026-10-m0.md) ("M0 tooling", "Task 5").
