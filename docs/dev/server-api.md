# Server: API, auth, database, MCP

Today's rules for the server outside the encode engine. The engine is in [engine.md](engine.md), the plugin host in [plugins-host.md](plugins-host.md), the web app in [web-ui.md](web-ui.md), tests in [testing.md](testing.md), code style in [conventions.md](conventions.md), CI and releases in [ci-release.md](ci-release.md).

## Layers

- Packages depend in one direction: `shared <- sdk <- contract <- server/web`. The web app depends on `shared` and `contract` only.
- `scripts/check-deps.ts` (run by `pnpm check-deps` and `pnpm check`) enforces it. It also refuses a relative import from one package into another (`../../server/src/...`).
- `packages/contract` holds every procedure's route, input, output and errors. The server implements it; the web app calls it. Neither side defines an API shape on its own.

## How a procedure flows

1. **Contract.** Add the procedure to its router in `packages/contract/src/routers/<area>.ts` with `oc.route({ method, path, tags, summary }).errors(...).input(...).output(...)`. Schemas go in `packages/contract/src/schemas/<area>.ts`. A new router is added to `contract` in `packages/contract/src/index.ts`. `packages/contract/src/contract.test.ts` pins each router's keys and some routes.
2. **Server.** Implement it in `apps/server/src/rpc/procedures/<area>.ts` as `os.<area>.<name>.use(<guard>).handler(...)`. `os` comes from `rpc/middleware.ts`. Register it in `createRouter()` in `apps/server/src/rpc/router.ts`.
3. **REST and RPC.** Nothing more to do. `rpc/handlers.ts` serves the same router on `/rpc` (browser, oRPC RPC protocol) and `/api/v1` (REST, from the contract's `method` and `path`). The OpenAPI document at `/api/openapi.json` is generated from the contract.
4. **MCP, only if an agent should have it.** Add a tool with `defineTool` (`mcp/tool.ts`) in `apps/server/src/mcp/tools/<group>.ts`, add it to `ALL_TOOLS` in `mcp/tools/index.ts`, and to `EXPECTED_TOOLS` in `mcp/never.test.ts`. Describe it in `docs/mcp.md` (tool count and table; `mcp/mcp-docs.test.ts` checks both and the scopes).
5. **Web.** Call it through `api` from `apps/web/src/api/client.ts` (a typed oRPC client over `/rpc`), usually from a hook in `apps/web/src/hooks/` or a page's own hook.

- Routes that stream a file or plain text are plain Hono routes beside the contract, in `apps/server/src/http/` and mounted in `app/app.ts`: backup download, test output, job log, job poster, `/metrics`. They are not in the OpenAPI document or the RPC client.
- A GET is a read. Any other method (or none) is a mutation and gets the CSRF check.
- Public operations in the OpenAPI document set `spec: publicSpec` (`packages/contract/src/openapi.ts`). The document's default security is `bearerAuth`.

## Auth

- Every procedure uses one guard from `rpc/middleware.ts`:
  - `requireScope(scope)` / `requireAnyScope(...)`: a session, or a token holding the scope.
  - `requireSession`: a browser session only (token management).
  - `requireHumanSessionWith(refusal)`: a session only. Every API token gets `FORBIDDEN` with the refusal text, whatever its scopes. Used for activation, settings changes, backups, plugin management, folder browsing, restore, process again, test outputs and password change.
  - `requireSameOrigin`: setup and login, which have no session yet.
  - `publicProcedure`: marks a procedure as public on purpose (`auth.me`).
- `resolveAuth` (`http/auth-context.ts`) resolves the caller once per request. A `Bearer` header is authoritative: an invalid bearer is unauthenticated and the cookie is not used.
- Sessions (`auth/sessions.ts`): cookie `tcd_session`, 30 days, sliding (renewed at most once an hour). `app/app.ts` re-sends or clears the cookie unless the procedure set it.
- CSRF (`auth/csrf.ts`): cookie mutations need an allowed Origin/Referer (or none plus `Sec-Fetch-Site: same-origin|none`) and the session-bound `X-CSRF-Token`. Bearer requests are exempt.
- Tokens (`auth/tokens.ts`): prefix `tcd_`, stored hashed. Scopes are `TOKEN_SCOPES` in `packages/shared/src/scopes.ts`. Scopes are exact and never imply each other; a session has every scope. `metrics` unlocks only `/metrics` and `system.status`. Unknown scopes are dropped on read.
- Host check (`auth/host-check.ts`, in `app/app.ts`): `/api`, `/rpc`, `/mcp` and `/metrics` answer 403 `HOST_NOT_ALLOWED` for a host that is not allowed. Allowed: the hosts recorded at setup, `TRANSCODA_ALLOWED_HOSTS`, and `localhost`, `127.0.0.1`, `::1`. The check is skipped until the first user exists.
- Proxies (`auth/request-info.ts`): `X-Forwarded-For`, `-Proto` and `-Host` are honoured only from a peer in `TRANSCODA_TRUSTED_PROXIES`.
- Login rate limit (`auth/rate-limit.ts`): in memory, keyed by client IP and by user name, 5 failures a minute, then growing lockouts up to 15 minutes. `RATE_LIMITED` carries `retryAfterSeconds`.
- The secret key (`auth/secret-key.ts`) comes from `TRANSCODA_SECRET_KEY` or `<config>/secret.key`. It signs CSRF tokens and encrypts plugin secrets.

## Errors

- Every error code is defined once in `errorDefs` (`packages/contract/src/errors.ts`). A procedure lists the codes it can raise with `pickErrors(...)`, `authedErrors` or `mutationErrors`.
- A handler throws `errors.CODE({ message, data })`. Map service exceptions to a defined code (for example `KindMismatchError` to `KIND_MISMATCH`). Add a new code rather than throw a generic one.
- `BAD_REQUEST` is left to oRPC for input that fails the schema. Do not throw it for domain failures.
- Defined errors are encoded by oRPC: `{ defined, code, status, message, data }` on REST, wrapped as `{ json, meta }` on `/rpc`. The host check and the 413 body limit (2 MB, `MAX_BODY_BYTES`) build the same shape by hand.
- An unexpected error is a 500. `rpc/handlers.ts` logs it once with the procedure path and the error name and message, never the input. `app.onError` answers `{ error: 'INTERNAL' }`.

## Database

- SQLite through better-sqlite3 (`db/open.ts`): WAL, `foreign_keys = ON`, `busy_timeout` 5 s. `durably()` commits with `synchronous = FULL` for writes that must survive power loss.
- SQL lives in repositories, `apps/server/src/db/repos/*.ts`. Services and procedures call them. IDs are `crypto.randomUUID()`; times are ISO-8601 UTC strings.
- Migrations:
  - One file per migration in `db/migrations/`, named `NNNN_snake_case.ts`, numbered 1..N with no gaps, exporting a `Migration` with a matching `version` and `name`.
  - Register it in order in `db/migrations/index.ts`, and give it its own `NNNN_snake_case.test.ts`. `db/migration-conventions.test.ts` checks all of this.
  - Write frozen SQL: literal names and values, no imports of application constants, so the file never changes after it ships. Never edit a shipped migration; write a new one.
  - Keep data. A table rebuild sets `foreignKeys: 'off'`; `migrate()` then refuses to commit while `foreign_key_check` reports a violation.
- `app/bootstrap.ts` runs `migrate()` at start. A schema newer than the build refuses to start (`SchemaTooNewError`) and names the backup to restore.
- Backups (`db/backup.ts`, `db/build-backup.ts`): a `VACUUM INTO` copy in `<config>/backups` before migrations, when the build changes, and on "Back up now" (`system.backups.create`, session only). Five are kept per reason. Restore steps are in `docs/env.md`.

## Settings and environment variables

- **Database settings** are things a person changes in the UI without a restart. Keys and defaults are `SETTING_KEYS` and `SETTING_DEFAULTS` in `db/repos/settings.ts`. `settings/service.ts` reads them; a row that fails its schema reads as the default. `settings.update` is session only and allow-lists its fields in `SettingsUpdateInputSchema`. No MCP tool reads or changes settings.
- **Environment variables** are deployment facts that need a restart. They are parsed only in `loadConfig()` (`apps/server/src/platform/config.ts`) into `Config`, with a `ConfigError` for a bad value. Document each in a table row in `docs/env.md`; `config.docs.test.ts` compares the rows with the variables `config.ts` reads.
- The Settings page shows some variables read-only (`source.kind: 'env'`) with their effective values from `Config`. The service learns which variables are set by name only (`transcodaEnvNames` in `app/deps.ts`), and `settings.get` never returns a secret.

## Workflows and activation

- `WorkflowService` (`workflows/service.ts`) owns workflows: list, get, save, validate (`workflows/validate/validate.ts`, its checks in the files beside it), node upgrades (`workflows/upgrade.ts`). `upgradeAll()` runs at start.
- A save always creates a new version. It never changes which version runs for real.
- Only `setActiveVersion` and `clearActiveVersion` (`db/repos/workflows.ts`) write the active version. `workflows.activate` and `deactivate` are human-only (`requireHumanSession`, refusal "Activation is a UI action").
- Webhook URLs are redacted in every output (`rpc/redact.ts`). A redacted URL sent back keeps the stored one.

## MCP server

- `/mcp` (`mcp/handler.ts`): stateless Streamable HTTP on `@modelcontextprotocol/sdk`, bearer tokens only. Cookies are never read. The host check, Origin check and body limit apply.
- Tools call the router in process (`ToolContext.api`), so scopes, validation, redaction and error codes are the REST ones. A tool adds input shapes, text and structured output only.
- A token sees only the tools its scopes allow (`toolsFor`). A hidden tool answers "not found".
- Never, and tested in `mcp/never.test.ts`: no tool activates, deactivates or queues a real run (`dry_run` always sends `dryRun: true`); no tool reads a secret or settings; no auth, token or events tool. A `metrics` token sees no tool (`mcp/metrics-scope.test.ts`).
- Logging: one `mcp tool call` line per call with tool, token id, ok and code. Never arguments or results.

## Metrics

- `METRICS` in `apps/server/src/metrics/catalog.ts` lists every metric `/metrics` serves. Labels come from small fixed sets only: never a path, job id or message.
- `metrics/service.ts` builds one snapshot (cached 5 s) from `db/repos/metrics.ts` and in-memory state; `metrics/exposition.ts` renders it. `system.status` serves the same snapshot as JSON.
- `metrics/catalog.sync.test.ts` checks that `docs/metrics.md` lists every metric with its type and labels in catalog order, and that `examples/grafana/transcoda-dashboard.json` queries only served metrics.
- `TRANSCODA_METRICS=false` turns `/metrics` and `system.status` off.

## Logging

- Log through the `Logger` from `apps/server/src/platform/logger.ts` (JSON lines in production, plain text otherwise). It is the only server file allowed to use `console`.
- Pass `{ msg, ...fields }`. Never log a secret, token, webhook URL, request body or procedure input.

History: [M0](../decisions/2026-10-m0.md), [M1 workflows](../decisions/2026-10-m1-workflows.md), [activation and MCP](../decisions/2026-10-activation-mcp.md), [October](../decisions/2026-10.md) (library trigger, backup on build change), [November](../decisions/2026-11.md) (metrics, failure codes, code consistency checks).
