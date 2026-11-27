# The plugin host

The rules in force today for how core runs, sandboxes, installs, verifies and calls plugins: `apps/server/src/plugins/`, `apps/server/src/plugin-host/`, `packages/shared/src/plugins/` and `packages/sdk/`. Plugin authors read [`plugin-sdk.md`](../plugin-sdk.md); users read [`plugins.md`](../plugins.md). History is in the decision files linked at the end; where they disagree with this page, the code wins.

## Overview

- **One process per enabled plugin**, never a shared host. A crash, timeout or memory kill of one plugin leaves the others' calls untouched.
- `forkHost` (`plugins/process.ts`) spawns the host entry (`plugin-host/main.ts`, built as `plugin-host.js`, path from `TRANSCODA_PLUGIN_HOST`) with the flags from `hostExecArgv` and the command from `hostSpawn` (both `packages/shared/src/plugins/host-flags.ts`): `--permission`, `--allow-fs-read` for the host file and the bundle only (the host drops both grants with `process.permission.drop` after the import), `--disallow-code-generation-from-strings`, `--max-old-space-size`. The environment is `HOST_ENV_KEYS` (`PATH`, `NODE_ENV`) and nothing else. Detached, killed as a process group.
- **The channel is framed by the server.** fd 3 is a plain pipe (never `'ipc'`, never `fork`), the host gets `NODE_CHANNEL_FD=3` with json serialization, and `plugins/channel.ts` reads newline-delimited JSON. A line that is not JSON or is longer than `MAX_FRAME_CHARS` (`MAX_MESSAGE_BYTES` + 64 KiB) is a bad frame: the plugin is stopped for good (exit reason `protocol`), not restarted. Do not hand fd 3 back to Node's own channel reader: a bad frame there throws inside the server.
- Modules: `supervisor.ts` (start, restart backoff, crash limits, slot cap, identity check), `service.ts` (`PluginService`: install, update, remove, settings, catalogs, blocklist, crash-loop guard), `installer.ts` (download, verify, store, stage), `catalog.ts`, `signed-fetch.ts`, `signature.ts`, `official-keys.ts`, `blocklist.ts`, `fetch-proxy.ts` with `address-policy.ts`, `settings.ts` and `crypto.ts`, `hooks.ts` (`PluginHooksRunner`), `restart-gate.ts` (`PluginRestartGate`), `isolation.ts`, `dev.ts`, `check-plugin.ts` (`--check-plugin`), `http-get.ts`.
- Installer, catalog and blocklist downloads go through `http-get.ts` (`node:http(s)`), not the global `fetch`. The catalog token goes only over https to `CATALOG_TOKEN_HOSTS` (`token-hosts.ts`), re-checked on every redirect hop.

## The security promise (binding)

The promise text lives in two places that a test pins equal: `SECURITY_PROMISE` in `apps/web/src/plugins/plugin-text.ts` and "What the sandbox does and does not do" in [`plugin-sdk.md`](../plugin-sdk.md) (`plugin-text.test.ts`). Change both or neither. What it binds core to:

- **Accident protection, not a wall.** Plugins are trusted code. Never claim more than the promise says, and never weaken what it does claim.
- A plugin reads only its own bundle, writes no files, starts no programs, loads no native code, has no worker threads and sees no environment beyond `PATH` and `NODE_ENV`. It never touches media or the database: core does all file work and gives plugins data only. A plugin build hook may not add, remove or re-point an extra input file (the walk's guard fails closed), so a plugin can never make ffmpeg read a path of its choosing.
- **The plugin user.** In the image every host runs as `PLUGIN_UID:PLUGIN_GID` (default `65001:65001`, from `docker/entrypoint.sh`) through `setpriv --reuid --regid --clear-groups --inh-caps=-all --ambient-caps=-all --no-new-privs`, with no capabilities. The server keeps exactly `CAP_SETUID`, `CAP_SETGID` and `CAP_KILL`. Never add `--bounding-set` to the host argv (the server lacks `CAP_SETPCAP`, so the host would not start).
- **Identity check.** After the host reports ready, the supervisor reads `/proc/<pid>/status` (`processIdentity`) and stops the plugin with `plugin host is not isolated: …` when uid, gid, effective, permitted or ambient capabilities, or `NoNewPrivs` are wrong. An unreadable identity fails closed.
- **Staging.** Isolated hosts run a copy of the verified bytes in the run directory (`TRANSCODA_PLUGIN_RUN_DIR`, `/run/transcoda/plugins` in the image), never from `/config/plugins`. A staging failure is `stopped: cannot stage bundle: <reason>`, no restart loop.
- **Isolation never degrades silently.** Isolation that is configured but cannot work is an `IsolationError` at start (exit 2), never same-uid. In production on Linux without isolation the server refuses to start unless `TRANSCODA_PLUGIN_ISOLATION=off`. Dev plugins (`TRANSCODA_DEV_PLUGINS`) run as the server's user, are never staged, and are refused in production, like `TRANSCODA_PLUGIN_INSPECT`.
- **What is not covered**, and must stay documented as such: raw sockets (the network is outside Node's permission model), memory outside the V8 heap (only the RSS poll and the container limit catch it), signalling sibling hosts (all hosts share one uid), and `--disallow-code-generation-from-strings` (`vm` still runs strings; it is not a boundary).
- **Proof.** `sandbox.test.ts` runs the denial probes of `fixtures/denial.plugin.ts` in a real host and compares each answer with `sandbox-expectations.ts` (19 probes). The image CI runs `--check-plugin … --expect-denials` and asserts `probes == 19`, uid `65001` and zero capabilities. A Node upgrade that changes an answer must fail the suite, not be absorbed: update the table only when the new answer is still a denial. A new probe means updating the table, the CI count and the count in `plugin-sdk.md`.
- Plugin management (install, update, remove, enable, settings, catalogs) is a signed-in admin session only (`Plugin management is a UI action`). No token scope and no MCP tool may add it; `list_plugins` is the only plugin MCP tool.

## Secrets and the fetch proxy

- Settings secrets are sealed with AES-256-GCM under a key derived by HKDF from the instance secret (`crypto.ts`). The API never returns a stored secret. Losing `secret.key` loses every plugin's secrets.
- Nothing secret crosses the process boundary after `init` and `settings`, except inside a `fetch` message. The host turns each secret into a `__TRANSCODA_SECRET__<field>__<encoding>__` token; `fetch-proxy.ts` substitutes only that plugin's own secret fields, after the origin check, into the url, headers and body of that request. Never into a result, log, problem, trace, API answer or MCP answer.
- The allowed origins (from the integration's `allowedOrigins`) are the boundary. There are no wildcards.
- **Address pinning.** `FetchProxy.pin` resolves each hop once, checks every answer with `address-policy.ts` and connects to the checked address (the url keeps the name for Host, SNI and certificates). Loopback, link-local, cloud metadata, multicast and reserved addresses are always refused. Private ranges (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) are allowed only when the allow-listed host is itself private (a private literal, a single-label name, or a LAN suffix such as `.local`, `.lan`, `.home.arpa`). Each redirect hop and each 429 retry is pinned again.
- Redirects are same-origin only, at most 5 (`MAX_REDIRECTS`); `Retry-After` is capped at 60 s (`MAX_RETRY_AFTER_MS`). Network errors carry the error code, never the url.
- Plugin settings JSON Schemas never run their regexes on the server: `serverSettingsSchema` (`apps/server/src/nodes/plugin-settings-schema.ts`) drops `pattern`, `format` and `patternProperties` and caps strings at `MAX_SETTINGS_STRING` (64 KiB). No other server file may call `fromJSONSchema` (a test enforces it). The plugin's own zod, inside the host, stays authoritative.

## Catalog, signatures, blocklist, compatibility

- **Signatures.** ed25519 over the exact bytes, as a detached `<url>.sig` (`signature.ts`, `signed-fetch.ts`, at most `MAX_SIGNATURE_BYTES`). The official keys are pinned in `OFFICIAL_SIGNING_KEYS` (`official-keys.ts`); `TRANSCODA_PLUGIN_CATALOG_KEY` replaces them (`none` only outside production). A missing signature is never "unsigned": it is `catalog signature missing` or `bundle signature missing; reinstall`.
- Every start re-verifies the stored bundle's checksum and signature before the fork (`bundle changed on disk; reinstall`, `bundle signature invalid; reinstall`, `signed with an unknown key <id>; update the plugin`). An install recorded unsigned (`signed_by` null) is never checked later.
- **Catalog** (`catalog.ts`): body at most `MAX_CATALOG_BYTES` (4 MB), cached for an hour, stale cache served on error. For a signed catalog a verified index whose `generated` is older than the cached one is refused. Entry urls are https in production.
- **Installer** (`installer.ts`): manifest (at most 1 MB) before the bundle; bundle at most `MAX_BUNDLE_BYTES` (32 MB), hashed and refused on a checksum mismatch; names and versions validated against traversal; a manifest whose `network` differs from its catalog entry is refused.
- **Blocklist** (`blocklist.ts`): fails open on a fetch error, fails closed on a match. Checked at install, update and before every start. The cached list is in force before any plugin boots; the network fetch runs in the background (`BLOCKLIST_TIMEOUT_MS`, 3 s) and then hourly. `generated` only moves forward. A custom `TRANSCODA_PLUGIN_CATALOG_KEY` makes the official blocklist inert, and the server warns.
- **Compatibility** is `semver.satisfies(SDK_VERSION, range, { includePrerelease: true })` everywhere: catalog, installer, start, `--check-plugin`. Keep the option.
- **Hosts before install.** The manifest's `network` is derived by `pluginNetwork` in the SDK from `allowedOrigins`; authors never write it. The start check compares the bundle's own list with the manifest's. Both checks apply only when the catalog side carries the list.

## Limits

`DEFAULT_LIMITS` in `packages/shared/src/plugins/types.ts` holds the defaults; `LIMIT_BOUNDS` and `loadLimits` in `plugins/limits.ts` read overrides from `plugins.limits.<key>` settings rows, and a malformed or out-of-bound row falls back to the default. The ones that guard the server: `heapMb` 128 (bound 4096), `rssMb` 256 (bound 2048, polled every second), `maxHosts` 16 (bound 256; past it a start is `stopped`, not retried), `cancelGraceMs` 5 s, `callTimeoutMs` 30 s, `finishRunTimeoutMs` 5 min, `startTimeoutMs` 60 s, `fetchBodyBytes` 16 MB, crash restarts given up after `maxCrashes` 3 in `crashWindowMs` 10 min. One IPC message is at most `MAX_MESSAGE_BYTES` (16 MB, `packages/shared/src/plugins/protocol.ts`). Plugin stdout and stderr are forwarded at most 100 lines per second per process (`supervisor.ts`). The table authors see is in [`plugin-sdk.md`](../plugin-sdk.md), "Limits"; change both together.

Server-level backstops: `process-guards.ts` logs an unhandled rejection and keeps running; an uncaught exception exits 1. The crash-loop guard (`plugin_start_attempts`, migration 0012) disables every plugin counted in `maxCrashes` boots in a row that did not stay up `stableMs`.

## How the engine calls plugins

- Finish phases are `FINISH_PHASES` (`render → gate → write → library-manager → media-server → notify`, `packages/shared/src/plugins/types.ts`). Plugin finish nodes may use only the last three; `nodes/remote.ts` enforces it server-side, and the SDK refuses the others too.
- Plugin finish steps run after the write, in phase order, and never undo it. A failed required step is a problem on a `done` job; an optional one a warning. A step whose plugin is down is retried once after `PLUGIN_RETRY_MS` (10 s) in the engine's pipeline. The host checks a `run` answer with zod (message at most 2000 characters).
- A plugin node whose plugin is not running makes the workflow version invalid (`PLUGIN_UNAVAILABLE`). Before failing a job, `PluginRestartGate` waits for a plugin that is starting or restarting, never for one that is stopped, disabled or removed.
- Hooks (`plugins/hooks.ts`): `afterReplace` is awaited right after the write; `onJobDone` and `onJobFailed` are fire and forget. Hooks never change a job and are skipped on shutdown and in dry runs.
- A job's cancel reaches the plugin as a protocol `cancel`; a call that does not answer within `cancelGraceMs` kills the host.

## SDK versioning and publishing

- `@transcoda/sdk` has its own version: `packages/sdk/package.json` and `SDK_VERSION` in `packages/sdk/src/plugin.ts` (a test pins them equal), also named in `packages/sdk/README.md` and `plugin-sdk.md`.
- Additive changes (a new optional field, helper or manifest entry) are a minor. A changed hook signature or context field is a major. Core judges every plugin against its own `SDK_VERSION`, so a major bump makes plugins that declare only `^1` incompatible.
- `@transcoda/shared` is inlined into the published SDK, so a change to `packages/shared/src/plugins/` (protocol, limits, host flags) is an SDK change too.
- Publishing is a `sdk-v<version>` tag on `main` after the bump is merged; `sdk-publish.yml` publishes with provenance. Steps: [`releasing.md`](../releasing.md), "Releasing the plugin SDK".
- Release order for an SDK feature the plugins use: core first, then the plugins repository, then the catalog rebuild. New manifest or catalog fields stay optional so either order is safe.

## Tests

- Unit tests sit beside each module and use `fake-child.ts` instead of a real host. Tests that need a real host (`sandbox.test.ts`, `supervisor.real.test.ts`, `service.test.ts`, `plugin-host/host.test.ts`) use the host and the fixture plugins in `plugins/fixtures/`, built once per run by `plugins/testing/global-setup.ts` and started with `plugins/testing/spawn.ts`.
- `fetch-proxy.test.ts` stands a loopback server in for a LAN or public one through `FetchProxyDeps.classify` and `resolve`; production never sets them.
- `docker/entrypoint.test.sh` (run by `ci.yml` and `docker.yml`) checks the plugin user and the isolation-off paths; the image's `sandbox` and `hardening` jobs check the built image (see [`ci-release.md`](ci-release.md)).
- The plugins repository runs every bundle through core's real host with `scripts/host-check.mjs` (`--check-plugin` against a core checkout) in its CI and release workflows. A change to the host, the protocol or the SDK should keep those bundles passing.

History: [M3 plugins and security hardening](../decisions/2026-10-m3-plugins.md), [integrations, the sandbox review and finish-step ordering](../decisions/2026-10.md), [plugin hosts before install](../decisions/2026-11.md).
