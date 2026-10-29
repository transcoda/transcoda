# @transcoda/sdk

The plugin SDK (version `1.2.0`), on npm as [`@transcoda/sdk`](https://www.npmjs.com/package/@transcoda/sdk): `npm install --save-dev @transcoda/sdk zod`. Plugins bundle it, so it is a dev dependency; a bundle has no runtime `dependencies`. The author guide (manifest, limits, secrets, finish phases, dev mode, releasing, the security promise) is [`docs/plugin-sdk.md`](../../docs/plugin-sdk.md). `@transcoda/sdk/testing` holds the test helpers.

## Surface

- `definePlugin({ name, version, sdk, integration?, icon?, nodes, triggers?, hooks?, setup? })` — identity; throws `TypeError` when `sdk` is missing, `nodes` is not an array, `icon` is not SVG markup of at most 16 KiB, a node type does not start with `<name>:` (the bare plugin name, not the npm name), or a finish node uses phase `render`, `gate` or `write` (only core renders and writes files).
- `pluginManifest(plugin)` — name, version, sdk, node types, integration id or `null`, trigger ids, declared hook names.
- `defineNode({ type, version, kind, settings, decide | build | finish | data | run, finishPhase, ... })` and `nodeMetadata(def)`. A `finish` node must declare `finishPhase` (`library-manager`, `media-server` or `notify` for plugins); `damagedOnly: true` (finish nodes only) limits it to a Damaged side. An output port's optional `shownWhen: { setting, equals }` shows the port only while that setting deep-equals `equals` (`portShown` in `@transcoda/shared`). Node settings may not contain a secret (`format: 'password'`): secrets live in the integration settings.
- `defineIntegration({ id, title, settings, allowedOrigins, test, requires? })`. `test` returns `{ ok: true, message, version?, warnings?, roots? }` or `{ ok: false, kind, message }`; `roots` (since 1.2.0) lists the folders the service keeps media in, as it sees them, and Transcoda warns about any that its path mappings do not place inside a library. `allowedOrigins` entries are `'$settings.<field>'` (a setting of the schema) or an origin literal such as `'https://api.example.com'`. Setting helpers: `url()`, `secret()` (may be optional, never nullable), `pathMappings()`, `allowInsecureTls()`. `secretPaths(schema)` lists the top-level secret keys. Settings schemas are not recursive.
- `defineTrigger({ id, title, description, icon, settings, auth, handle })`; `handle` returns `files`, `ignore` or `test`.
- `PluginContext` (every hook gets it as `ctx.plugin`; integration `test`, hooks and `setup` get it directly): `settings` (decrypted integration settings), `fetch` (only to the integration's allowed origins; throws `FetchRefused`, `FetchTimeout`, `FetchRateLimited` or `FetchFailed`; classify with `fetchErrorKind(e)`, never `instanceof`, since the host and each bundle carry their own SDK copy), `paths` (`toRemote`/`toLocal`, longest segment-aware prefix of the user's path mappings), `cache` (`get`/`set` with a ttl, bounded), `lang`, `log`, `dryRun`, `job`.
- Finish nodes return `{ kind: 'plugin', description, required }` from `finish`; `run(ctx, settings)` does the work after the write and returns `{ ok: true, message }` or `{ ok: false, message, retryable? }`.
- Hooks (`onJobDone`, `onJobFailed`, `afterReplace`) are best effort and never change a job.

## Compatibility

A plugin declares the SDK majors it supports (`'^1'`, later `'^1 || ^2'`); core loads a plugin if `semver.satisfies(SDK_VERSION, range, { includePrerelease: true })`; a plugin bumps its own major when it drops an SDK major. Core bumps the SDK major only when a hook signature or context field changes incompatibly; additive fields are minors. The manifest (`definePlugin`'s `sdk`, `name`, `version`) is read from the bundle's default export and compared with the installed `.manifest.json` before `setup` runs.

## Limits

Each plugin runs in its own sandboxed process: call timeout 30 s (decide, build, finish, data), 5 min for a finish `run`, 20 s for `test()`, 5 s for a trigger `handle`, 60 s to start, 30 s for hooks; heap 128 MB, killed at 256 MB RSS; restart backoff 1 s doubling to 60 s, given up after 3 crashes in 10 min; IPC message cap 16 MB; fetch: default 15 s (cap 5 min), 2 concurrent, 10 requests/s, one honoured `Retry-After`, same-origin redirects only, response body cap 16 MB; bundle at most 32 MB.

## Testing helpers (`@transcoda/sdk/testing`)

- `fakePluginContext({ settings, responses, mappings, dryRun })` — `fetch` answers from a script (`match: { url: string | RegExp, method? }`, consumed in order); an unscripted call throws a `failed`-kind error (a plain `Error` with `name` and `kind`, like a bundle sees the host's). Exposes `calls` and `logs`.
- `fakeHookContext(partial?)` — a complete `DecideContext` (clock `now` included, so tests need not patch it): a probe with one hevc video and one aac `eng` audio stream, file `/media/a.mkv`. It is also a valid base for build, finish, data and run contexts.
- `runDecide`, `runBuild`, `runFinish`, `runData`, `runFinishRun(node, ctx, settings)` — parse the settings with the node's schema (throwing on failure) and call the hook. `runTrigger(trigger, ctx, request, settings)`, `runTest(integration, ctx)`.

## Dev mode

`TRANSCODA_DEV_PLUGINS=/abs/a.js,/abs/b.js` loads bundles from arbitrary paths (still sandboxed, read grant for that file); `TRANSCODA_PLUGIN_INSPECT=1` adds `--allow-inspector --inspect` to the host. Both are refused when `NODE_ENV=production`.
