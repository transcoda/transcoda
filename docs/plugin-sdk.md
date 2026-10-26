# Writing a Transcoda plugin

For plugin authors. The SDK is `@transcoda/sdk` (version `1.0.1`; the surface is frozen for 1.0 and the full reference is [`packages/sdk/README.md`](../packages/sdk/README.md)). A plugin is one self-contained JavaScript file, built from TypeScript, that Transcoda installs into `/config/plugins` and runs in its own sandboxed process. Official plugins live in the separate `transcoda-plugins` repository; its `plugins/example` is the smallest working one. Install the SDK from npm with `npm install --save-dev @transcoda/sdk zod` (plugins bundle it, so it is a dev dependency).

## What a plugin is

`definePlugin` default-exports the plugin from the bundle:

```ts
import { defineNode, definePlugin } from '@transcoda/sdk';
import { z } from 'zod';

const extensionIs = defineNode({
  type: 'example:extension-is',        // always <plugin>:<node>; core's own types start with core:
  version: 1,
  kind: 'condition',
  title: 'Extension wanted?',
  description: 'Branches on the file extension.',
  icon: 'file',
  inputs: [{ id: 'file', label: 'File', type: 'file' }],
  outputs: [
    { id: 'pass', label: 'Yes', type: 'file' },
    { id: 'else', label: 'No', type: 'file' },
  ],
  settings: z.object({ extensions: z.array(z.string()).default(['mkv']) }),
  async decide(ctx, settings) {
    const extension = ctx.file.path.split('.').pop() ?? '';
    return settings.extensions.includes(extension.toLowerCase())
      ? { port: 'pass', reason: `.${extension} is wanted` }
      : { port: 'else', reason: `.${extension} is not wanted` };
  },
});

export default definePlugin({ name: 'example', version: '1.0.0', sdk: '^1', nodes: [extensionIs] });
```

**Two-way branches read Yes and No.** A condition has two outputs with the ids `pass` (the condition holds) and `else` (it does not). Keep these ids: they are stored in saved graphs, and `decide` returns one of them as `port`. What people read is the label: Transcoda shows a `pass` port as **Yes** and an `else` port as **No** (editor ports and tooltips, edge names, the Decisions list and validation messages), so title a condition like a question ("Extension wanted?", "Already HEVC?"). A port whose label is the generic "Pass" or "Else" (what older plugins declare) is shown as Yes or No too. A label you choose yourself ("Matches", "Other") is kept as you wrote it, in the editor and in messages; the Decisions list still words such a decision Yes or No from the port id.

A plugin provides nodes (`defineNode`), optionally one integration (`defineIntegration`: the settings form, the allowed network origins and a `test()`), triggers (`defineTrigger`, phase 3), hooks (`onJobDone`, `onJobFailed`, `afterReplace`) and a `setup(ctx)` that runs once when its process starts.

Plugins do the thinking, Transcoda does the file work. A node receives data (the probe, the file's path, size and mtime, the values on its input data ports) and returns a decision or a plan; it never opens, writes or deletes a media file, and it has no access to the database. Decisions are `decide` (a branch), `build` (a change to the stream plan), `finish` (what to do after the file is ready) and `data` (a value on a data port). A finish node returns `{ kind: 'plugin', description, required }` and does its work in `run(ctx, settings)`, which Transcoda calls **after** the file has been written.

## The manifest and compatibility

The manifest is read from the bundle itself (the default export's `name`, `version`, `sdk`, node types, integration id, trigger ids, hook names; `pluginManifest(plugin)` prints it). In the plugins repository the build also writes `<name>-<version>.manifest.json` next to the bundle and fails when it differs from the package.

- `name` is lowercase kebab-case; `catalog` and `catalogs` are reserved. Every node type starts with `<name>:`. A node type that core or another installed plugin already provides is refused at install (`node type X is already provided by core`).
- `sdk` is a semver range of SDK majors the plugin supports (`'^1'`, later `'^1 || ^2'`). Transcoda loads a plugin when `semver.satisfies(SDK_VERSION, range, { includePrerelease: true })`. The option matters: without it a release candidate such as `1.0.0-rc.1` would not satisfy `^1`. The same check runs in the catalog (the `compatible` flag), the installer, `--check-plugin` and the plugins repo's `host-check`.
- A plugin bumps its own major when it drops an SDK major. Core bumps the SDK major only when a hook signature or context field changes incompatibly; additive fields are minors.
- A bundle whose default export is not a `definePlugin` object (built against SDK 0.x, or a module with only named exports) is refused: the install is rolled back with `plugin crashed on start: crashed: bundle has no plugin default export` and nothing is registered.
- The manifest also lists each node's kind and title (`nodeInfo`), so the Plugins page can show what a plugin adds before it is installed; manifests built before that show the bare node types.
- `icon` (optional) is the plugin's own mark as SVG markup, at most 16 KiB, starting with `<svg` (an XML declaration before it is fine). The Plugins page shows it in a 40px tile, as an image only (it is never inserted into the page, so scripts and external references in it do nothing); without one the tile shows a monogram. Ship only a mark you may use: a product's logo is its owner's trademark, and an open-source licence for the code does not cover it.

## Node versions and migrations

A node bumps `version` when its settings shape or behaviour changes. `migrations` must link every version the plugin shipped to the current one within a plugin major (`from → to` steps, each with a `risk` and a `note`). The manifest announces each node's version and its links (`nodeVersions`), so the catalog and the Plugins page can reason without starting a bundle.

The plugin host migrates settings at call time: a call carries the pinned `nodeVersion`, and the host walks the `migrations` chain to the current version before the hook runs (a chain that is missing, ambiguous or overshoots fails the call with `no migration path from v1 to v3 for <type>`, and the hook does not run). Steps must be synchronous and their result must validate against the current settings. The host also answers a `migrate` message (`nodeType`, `from`, `settings`) with the migrated, validated settings (at most 256 KB). Migration code never runs in core. A workflow pinned to an older node version keeps running when the path to the current version has only `safe` steps: core cannot validate those settings (it only knows the new schema), so it passes them as stored, the call carries the pinned version and the host migrates and validates them at call time. A path with a `behaviour` step is held like a core node's: the version reads `plugin update changes behaviour of <node>; review and activate a new version`, is not runnable, and nothing runs it until a person activates the new version the update wrote. After an install, update, enable or server start, core asks the host to `migrate` the plugin's nodes in each workflow's newest version and saves the result as a new version (the active version is never touched); the Update dialog (`plugins.updateCheck`) lists beforehand the workflows an update would break or give a version to review.

`risk: 'behaviour'` makes Transcoda write a new workflow version that a person must activate. Dropping a version from `migrations` is a plugin major bump: active versions that pin it cannot run until a person activates a newer workflow version (the Plugins page lists them before the update).

## Limits

Each plugin has its own process. Transcoda applies these limits (defaults; stored overrides exist as `plugins.limits.<key>` rows in the `settings` table). The call timeout for `decide`, `build`, `finish` and `data` is changed under Settings → Plugins and applies to the next call; the others have no UI:

| What | Limit |
| --- | --- |
| A `decide`, `build`, `finish` or `data` call | 30 s |
| A finish `run` | 5 min |
| `test()` of the integration | 20 s |
| A trigger `handle` | 5 s |
| Process start (import, `setup`) | 60 s |
| A hook (`onJobDone`, `onJobFailed`, `afterReplace`) | 30 s |
| Heap | 128 MB (`--max-old-space-size`); the process is killed at 256 MB RSS (`rssMb`, at most 2048) |
| Plugins running at once | 16 (`maxHosts`, at most 256); a plugin started past it is `stopped` with `too many plugins running (at most 16); …` and is not retried until someone enables or restarts it |
| A cancelled call (a job was cancelled) | the host gets 5 s (`cancelGraceMs`, never past the call's own timeout) to stop; a call still running then kills the process, which restarts |
| Restart after a crash | 1 s, doubling to 60 s, back to 1 s after 5 min stable; given up (state `stopped`) after 3 crashes in 10 min |
| One IPC message | 16 MB |
| Bundle | 32 MB |
| `ctx.plugin.fetch` | default 15 s per request (at most 5 min), 2 requests at a time, 10 requests per second, one honoured `Retry-After`, same-origin redirects only, response body at most 16 MB |

A call that exceeds its limit kills the process; the call fails (retryable once for a job's decide, build and finish) and the supervisor restarts the plugin. A `stopped` plugin stays stopped until someone presses Enable (or Restart) on its card; its nodes show "plugin not running" in the editor, and a workflow whose **active** version uses one cannot run until the plugin is back (`jobs.queue` is refused with `PLUGIN_UNAVAILABLE`, a queued job fails at start naming the plugin).

## `ctx.plugin`

Every hook receives the plugin's context as `ctx.plugin`; the integration `test`, the hooks and `setup` receive it directly.

- `settings`: the integration settings, with secrets already decrypted (this is the only place a secret exists inside the process). If the stored settings no longer parse against the plugin's schema, the raw object, so `test()` and `setup` can report it.
- `fetch(input)`: the only way out. It reaches only the integration's `allowedOrigins`; failures throw `FetchRefused`, `FetchTimeout`, `FetchRateLimited` or `FetchFailed`; classify them with `fetchErrorKind(e)` (returns `'refused' | 'timeout' | 'rate-limited' | 'failed'`, or `null` for any other error), never with `instanceof` (the host and each bundle inline their own copy of the SDK, so the classes differ). See "Secrets and `fetch`" below.
- `paths.toRemote(localPath)` / `paths.toLocal(remotePath)`: the user's path mappings (for example `/data/shows` in Sonarr is `/shows` here), longest segment-aware prefix wins.
- `cache.get(key)` / `cache.set(key, value, ttlMs)`: a small in-process cache, at most 1,000 entries and 8 MB; a value over the byte cap is silently not stored.
- `lang`: language-name normalisation (`'Japanese'` to `'ja'`).
- `log(level, message)`: forwarded to Transcoda's log tagged with the plugin name (secrets redacted); the process's stdout and stderr are forwarded too, at most 100 lines per second.
- `dryRun`: true when the job is a dry run. A finish `run` is never called for a dry run; hooks never fire for one.
- `job`: `{ id, attempt }` where there is a job.

## Secrets and `fetch`

Integration settings can hold secrets (`secret()` fields, stored encrypted with a key derived from `secret.key`). Rules the host and the server apply:

- A secret reaches the plugin process once, at `init` and when settings change. After that nothing secret crosses the process boundary, with one exception: inside a `fetch` message. Inside the process the host replaces every secret in a `fetch` input by a placeholder token, and Transcoda's own fetch proxy substitutes the real value of **that plugin's own** secret fields, after the origin check, into the url, headers and body of that request (and into same-origin redirect re-sends), and nowhere else. A token naming a field that is not a secret field of the plugin refuses the request. The proxy treats the substituted request as secret material: it never appears in a log, a trace reason, a finding, a problem, an API response or an MCP answer.
- For authentication use the structured `auth` of `fetch` (`{ basic }`, `{ bearer }`, `{ header }`, `{ query }`); the server encodes it after substitution. A `:` in a Basic username is refused.
- Secrets are redacted by value from everything a plugin reports back (log lines, error text, test results, failure reasons): the exact string is replaced by `[redacted]`.

What this does **not** protect, so write plugins accordingly:

- Responses are not scanned for echoed secrets. A service that reflects the key in a body or header hands it to the plugin as plain data.
- A non-ASCII secret cannot be placed in a header value directly (Node sends header values as latin1); use the `b64`/`url` encodings or `auth`.
- A secret used as a header **name** or as a JSON object **key** is not protected: only string values are substituted and redacted.
- Secrets shorter than 4 characters are not redacted by value (they would blank ordinary text).
- A plugin's own error text is shown as written; only secrets are redacted from it, so do not put anything private in an error message.
- The origin allow-list is the boundary for *where* a plugin may fetch. On top of it, the server resolves each request's host once per hop and connects to exactly the address it checked (so DNS rebinding cannot swap it): loopback, link-local, cloud-metadata and reserved addresses are always refused; a private (LAN, Docker, Tailscale, ULA) address is allowed only when the configured origin is itself private: a private IP, a single-label name such as `sonarr`, or a LAN suffix (`.lan`, `.local`, `.home.arpa`, `.internal`, `.ts.net`, …). A public name that resolves into the LAN is refused; configure the service by its LAN name or IP instead. Sonarr on the server's own host must be reached by its LAN address, not `localhost`.
- Prefixed-base64 or JSON-pre-serialised secret forms cannot be tokenised: build the value with `auth` or a structured JSON body instead.

## Finish steps and phases

Finish nodes run after the write, in phases: `gate`, `write` (core only), `library-manager`, `media-server`, `notify`. Plugins use the last three. The validator enforces the order along every path (`FINISH_ORDER`): a phase may not come after a later one, and only finish nodes may follow a finish node. A plugin finish node has no outputs, so it ends a path; several finish nodes on one output (Replace original's, say) run one after the other in phase order; within a phase, left to right on the canvas, then top to bottom. Only finish nodes may share an output (`OUTPUT_MULTIPLE_EDGES`). In particular a workflow that notifies **before** the write is invalid; an existing workflow that did so has an active version that cannot run until the notify node is moved after `core:replace-original` (the editor shows the issue).

`run(ctx, settings)` gets `{ originalPath, newPath, replacedTo, beforeBytes, afterBytes, outcome, containerChanged, problemsSoFar, gate, jobUrl, workflowName, ... }` (`jobUrl` is the job's page, `<TRANSCODA_PUBLIC_URL>/jobs/<id>`, or `null` when that variable is not set; send no link then; `workflowName` is the job's workflow name as the job page shows it) and returns `{ ok: true, message }` or `{ ok: false, message, retryable? }`. The file is already replaced when it runs, so a failure never undoes the write:

- `required: false` (a warning): the failure message is recorded as a warning on the job.
- `required: true`: the failure is a **problem** on the job. The job still ends `done`; the Jobs page lists it as "needs attention".
- The plugin being down at that moment is retried once after 10 s; if it is still down the step fails the same way.
- If the server is stopped or the job is cancelled during the steps, the remaining ones are skipped with the problem `the server stopped before the remaining finish actions`; the next start does not re-run the write.

(`renameOutputs` on a node migration, which re-keys edges, is read for core nodes only; a plugin's migrations cannot rename ports and the field is ignored.)

A step wired to the **No** (`else`) output of `core:size-gate` runs when the gate failed and nothing was written: `outcome` is `'kept'`, `newPath` equals `originalPath`, `replacedTo` is `null`, `afterBytes` is the size of the discarded result, `containerChanged` is `false`, and `gate` is `{ savedPercent, minSavingPercent }`. On every other path `gate` is `null` and `outcome` is `'replaced'`, `'moved'` or `'copied'`. Only the `notify`, `media-server` and `library-manager` phases may follow else; the same failure rules apply, except that a required step's failure is recorded as a warning (the job is `kept_original`, not `done`).

Hook payloads (`HookJob`) carry the same `jobUrl` (`string | null`) and `workflowName` (`string`).

Hooks are best effort and never change a job: `afterReplace` runs after the write and before the plugin steps; `onJobDone` and `onJobFailed` run after the result is stored and do not hold a worker lane. Hooks are skipped on shutdown and are not replayed on the next start.

## Data nodes with several outputs

A data node with one `data:*` output returns that port's value as `value`. With several outputs, `value` must be an object whose keys are the output ids, for example `{ language, title, ids }`: each port gets `value[id]`. A missing key gives `'unknown'` on that port; a `value` that is not an object gives `'unknown'` on every port, and the trace reason gets the suffix ` (expected an object keyed by output id)`.

## Extra input files in the build model

`BuildModel.extraInputs` lists files ffmpeg reads besides the source (today: subtitle sidecars that core's `core:embed-sidecar-subtitles` found next to the video). A `StreamPlan` with `input ≥ 1` comes from `extraInputs[input - 1]`; its `sourceIndex` is `-input`. A plugin build hook may read both (to look at what was added, or to change such a stream's language or flags), but must not add, remove or change an extra input, or add or re-point a stream's `input`: the walk fails the node with `plugin build hooks cannot change input files` and renders nothing. Both fields are optional, so plugins built against an earlier 1.x SDK stay compatible.

## Testing helpers (`@transcoda/sdk/testing`)

- `fakePluginContext({ settings, responses, mappings, dryRun })`: a `ctx.plugin` whose `fetch` answers from a script (`match: { url: string | RegExp, method? }`, consumed in order); an unscripted call throws a `failed`-kind error. Its fetch errors are plain `Error`s with `name` and `kind`, not instances of the SDK classes, exactly as a bundle sees the host's, so `instanceof` misuse fails in your tests. It records `calls` and `logs`.
- `fakeHookContext(partial?)`: a complete `DecideContext`, clock (`now`) included, so a plugin test does not patch it: one hevc video and one aac `eng` audio stream, file `/media/a.mkv`. It also serves as the base for build, finish, data and run contexts.
- `runDecide`, `runBuild`, `runFinish`, `runData`, `runFinishRun(node, ctx, settings)`: parse `settings` with the node's schema (throwing on failure) and call the hook. `runTrigger(trigger, ctx, request, settings)`, `runTest(integration, ctx)`.

Run a plugin's tests with Vitest as usual; nothing needs a network, ffmpeg or Transcoda.

## Dev mode

`TRANSCODA_DEV_PLUGINS=/abs/a.js,/abs/b.js` loads bundles from arbitrary absolute paths, still sandboxed (the read grant is for that file). Dev plugins are never persisted and never come from a catalog; their enabled state and their settings live in memory for the life of the process. A dev bundle with the name of an installed plugin, a second bundle of one name, or a bundle that does not start is refused and logged as an error. `TRANSCODA_PLUGIN_INSPECT=1` starts the hosts with `--allow-inspector --inspect`. Both variables stop the server when `NODE_ENV=production`.

Outside production the logger prints each line's message followed by its structured fields as `key=value` pairs (a plugin's name, a finish step's text, the job id); production writes the same fields as JSON lines.

## `--check-plugin`

```sh
node apps/server/dist/main.js --check-plugin path/to/bundle.js
# {"ok":true,"name":"example","version":"1.0.0","sdk":"^1","compatible":true,"nodes":[...],"integration":null,"triggers":[],"hooks":[]}
```

Starts the bundle once in a sandboxed host with empty settings, prints one JSON line and exits 0 (`ok: true`) or 1. It touches no database, config directory or ffmpeg. The plugins repo's `scripts/host-check.mjs` runs it over every built bundle; it fails when a bundle does not start or its `sdk` range is not satisfied by this core. `--expect-denials --other-bundle <file>` is the image's sandbox check (see below).

## Releasing from the plugins repository

Each plugin is versioned on its own (`plugins/<name>/package.json`, `"transcoda": { "sdk": "^1" }`, no runtime `dependencies`; everything is inlined by tsdown). To release: bump `version`, merge to `main`, tag the merge `<name>-v<version>` (for example `sonarr-v1.2.0`) and push the tag. The release workflow checks the tag against the manifest, runs the checks, builds `<name>-<version>.js` and its `.sha256`, signs the bundle (`<name>-<version>.js.sig`, see below), and attaches them to a GitHub release (a `-beta.1` suffix marks a pre-release). The official catalog (`index.json` on the repository's `catalog` branch) is built from those releases: per version the bundle, manifest and signature URLs, `sha256`, `size`, the SDK range and the core versions it was tested against. Transcoda checks the checksum and the signature before it runs a single line of the bundle, and refuses a bundle whose manifest disagrees with the catalog. The index's `latest` hint is authoritative: when it names a listed, compatible version it wins over the newest compatible one for update checks, so the index generator must keep `latest` pointing at the newest stable release or installed plugins will not be offered the update.

To try the whole path on one machine, `examples/plugins/local-catalog.json` is an index for the built example plugin. Entry urls must be `http(s)`: serve the plugin's `dist` folder over plain HTTP (use a real HTTP/1.1 server with `Content-Length`; see `docs/m3-gate.md` for a note on `python3 -m http.server`) and start the server with `TRANSCODA_PLUGIN_CATALOG_URL=file:///…/examples/plugins/local-catalog.json` and `TRANSCODA_PLUGIN_CATALOG_KEY=none` (a `file:` or `http:` catalog is accepted outside production only). The example index is **unsigned**, and the official slot verifies signatures with the pinned keys, so without `TRANSCODA_PLUGIN_CATALOG_KEY=none` the catalog is refused with `catalog signature missing`; `none` is refused when `NODE_ENV=production`. It also makes the blocklist (below) be read unsigned. Regenerate the `sha256` and `size` in the file when you rebuild the bundle.

## What the sandbox does and does not do

> Plugins are code that runs inside Transcoda. Treat installing one like installing software on the server. Each plugin runs in its own process under Node's permission model: it can read only its own bundle, cannot write files, start programs, load native code or read other plugins' settings, and it never touches your media or the database — Transcoda does all file work and gives plugins data only. Its memory and the time each call may take are limited, and a plugin that crashes is restarted and, if it keeps crashing, stopped, with its nodes marked in the editor.
>
> This is accident protection, not a wall. A malicious plugin could still use the network freely (Transcoda offers a controlled HTTP client, but cannot block raw sockets: the network is outside Node's permission model) or exhaust memory the heap limit does not count. In the Docker image every plugin process runs as a separate unprivileged user, shared by all plugins, so it cannot signal Transcoda's own process or read `/config` (plugins can still signal each other); outside the image, when the container is started with `--user`, or with `TRANSCODA_PLUGIN_ISOLATION=off`, plugins share Transcoda's user and can do both. The official catalog only lists builds made by our CI from the public source, signed with a key this version of Transcoda knows; the signature and checksum are verified before every start, and a blocklist we publish stops known-bad builds within an hour. Custom catalogs are unsigned unless you pin their key, and show a warning for this reason. Install only what you would run on the server yourself.

How it is enforced, so you can check it: the host is forked with `--permission`, `--allow-fs-read` for the host file and the plugin's bundle only (both grants are dropped with `process.permission.drop` after the import), `--disallow-code-generation-from-strings`, `--max-old-space-size`, an environment of just `PATH` and `NODE_ENV`, and no stdin. `apps/server/src/plugins/sandbox.test.ts` runs 19 probes (reading another file, writing, spawning, loading an addon, reading the environment, signalling the server, which user the host is, and so on) inside a real host and compares every answer with `sandbox-expectations.ts`; the image CI runs the same check against the built image (`--check-plugin … --expect-denials`, exit 0 when every probe is denied as expected, and the result must report uid `65001`, no capabilities and `NoNewPrivs 1`). A new Node release that changes an answer fails the suite instead of weakening the promise unnoticed.

**The plugin user.** In the Docker image the entrypoint starts as root only to prepare ids and directories, then runs the server as `PUID:PGID`. It exports `TRANSCODA_PLUGIN_UID` and `TRANSCODA_PLUGIN_GID` (from `PLUGIN_UID` and `PLUGIN_GID`, default `65001:65001`, never equal to the server's and never 0) and the staging directory. The server starts every host through `setpriv --reuid --regid --clear-groups --inh-caps=-all --ambient-caps=-all --no-new-privs`, so a host has no permitted, effective, inheritable or ambient capability and `NoNewPrivs 1`. (The host's bounding set stays at the server's; dropping it needs `CAP_SETPCAP`, which the server deliberately lacks, and with an empty permitted set and no-new-privs it cannot be used.) After the host reports ready, the server reads `/proc/<pid>/status` and stops the plugin with `plugin host is not isolated: <field> expected <x>, got <y>` if the uid, gid, capabilities or `NoNewPrivs` are not what was asked for; this check runs after the host has evaluated the bundle's module code, so it proves what runs from then on, not what the first lines of the bundle could do. The bundle a host runs is a copy staged in `/run/transcoda/plugins` (a tmpfs the plugin group can read: mode `0640` files in a `2710` directory): `/config` has no access for others, and making `/config/plugins` group-readable would also expose every `0644` file under `/config`. The copy is written from the bytes that were just verified, so what runs is what was checked; if the staging directory is missing or not writable the plugin is `stopped: cannot stage bundle: <reason>` (no restart loop, other plugins unaffected). Dev plugins (`TRANSCODA_DEV_PLUGINS`) are **not isolated**: they run from their own path as the server's user (and are refused in production anyway). On Linux in production the server refuses to start without isolation (a container started with `--user`, or a staging directory that cannot be prepared) unless `TRANSCODA_PLUGIN_ISOLATION=off` says that is intended; with it off, plugins run as the server's user as the promise says.

**What the server itself is granted.** The server process keeps exactly three capabilities, nothing else (bounding, inheritable, ambient and effective set `00000000000000e0`, plus no-new-privileges): `CAP_SETUID` and `CAP_SETGID` to start each host as the plugin user, and `CAP_KILL` because signalling another user's process needs it (the supervisor kills a spinning host and its process group). The root entrypoint also needs `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID` and `SETPCAP`, which it drops before the server starts; `docker/docker-compose.yml` lists them with `cap_drop: [ALL]`, `no-new-privileges`, a read-only root filesystem and `pids_limit`, and the `hardening` job of the image CI checks the shipped compose file (the server's capability sets, a host that cannot signal the server, `/config` unreadable for the plugin user). ffmpeg and ffprobe, which the server starts, are also started through `setpriv` with their capabilities dropped. Never mount `docker.sock` or run the container privileged.

**Signatures.** Every official bundle, the catalog index and the blocklist are signed by one ed25519 key held in the plugins repository's CI. The signature is a detached file `<url>.sig` beside the document: `{ "schema": 1, "alg": "ed25519", "keyId": "<id>", "signature": "<base64 of the 64-byte signature over the exact bytes of the file>" }`. The signature covers the bytes, not the checksum: Transcoda verifies the downloaded bundle before it writes it, stores `<name>-<version>.js.sig` beside it, and verifies the checksum and the signature again before **every** start; a signed plugin whose `.sig` is gone is `bundle signature missing; reinstall` (never started on the checksum alone), a changed one `bundle signature invalid; reinstall`, and a bundle whose key is no longer known `signed with an unknown key <id>; update the plugin`. A catalog whose `.sig` answers 404 is `catalog signature missing`, never "unsigned, carry on". The public keys are pinned in `apps/server/src/plugins/official-keys.ts` (`OFFICIAL_SIGNING_KEYS`); a build with no key pinned refuses the official catalog and logs one warning at start. `TRANSCODA_PLUGIN_CATALOG_KEY` replaces the pinned list with `<id>:<64 hex>` keys (or `none`, outside production only; see `env.md`). Rotating the key: add the new public key to `official-keys.ts` and release core, switch the CI secret, and remove the old key two core releases later (a bundle signed with a removed key then stops at its next start, with the message above). If the key is compromised, in this order: generate a new key, pin it and drop the compromised one in a core release, re-sign the index and the blocklist with the new key, then add the sha256 entries for the affected builds. A server on an older core has no protection until it updates. A custom catalog is unsigned unless the admin enters its key (`<keyId>:<64 hex>`, comma-separated for several) when adding it; its index and bundles must then be signed with a key of that id, and removing such a catalog makes its plugins stop at their next start with `signed with an unknown key <id>`. A plugin recorded as installed without a signature (from an unsigned catalog, or with `none`) is never signature-checked later, even after a key is pinned: reinstall it from a signed catalog. Signed documents have no freshness: a validly signed older index could be replayed by whoever controls the network path to the catalog, which can hide an update or offer an older signed build (the blocklist is the answer to a known-bad one), but cannot make Transcoda run an unsigned build.

**The blocklist.** `blocklist.json` and its `.sig` sit beside `index.json` on the plugins repository's `catalog` branch (`TRANSCODA_PLUGIN_BLOCKLIST_URL`), signed with the same key. An entry names a build by `sha256`, or by `name` with an optional `versions` range, plus a `reason` and an optional advisory `url`. An entry that has both `sha256` and `name` matches either one (OR): the hash alone is enough to block that build, and the name (within the range) alone is enough to block any build of that name. It is fetched at start, hourly and when the catalog is refreshed, cached on disk, and read at start from the cache without the network. It **fails open on a fetch error and fails closed on a positive match**: a list that cannot be fetched or verified blocks nothing new and the last good list stays in force, one entry that does not parse makes the whole document invalid (the previous list stays), and an older signed list never replaces a newer one (`generated` only moves forward). A match is checked at install and update and before every start; an installed plugin it names is stopped with `blocklisted: <reason>` within the hour. The card shows `Blocklisted: <reason>` (with an advisory link), a catalog entry shows `blocklisted: <reason>` and cannot be installed, `list_plugins` appends `BLOCKLISTED: <reason>`, and the catalog view reports when the list was last checked or why it is unavailable. Dev plugins are never blocklisted. Until a production key is pinned the blocklist cannot be verified and does nothing.

**Known limits, not fixable in-process.**

- `--disallow-code-generation-from-strings` is **not a boundary**. `vm.runInNewContext`, `vm.compileFunction` and similar run strings regardless of it. They gain no privilege (the permission model and the plugin user still apply), but do not rely on the flag.
- The fetch proxy is a convenience, not a network policy. It has no private-address filter and the allowed origins come from the admin's settings. A plugin that opens raw sockets can reach the LAN, the server's own API on `127.0.0.1` and anything else the container can reach, which is why `docker.sock` must never be mounted. Closing this needs a network namespace per plugin, which means running plugins in a separate container.
- All plugin hosts share one uid and one gid. The isolation separates plugins from the server, not from each other at the operating-system level: a plugin can signal another plugin's host and, because the staged bundles share the plugin group, read their bundles through the filesystem. Node's permission model is what keeps them apart (a plugin's read grant names its own bundle only), and bundles are public code.
- Memory outside the V8 heap (buffers, native memory) is caught only by the RSS poll once a second and by the container's memory limit (`mem_limit` in compose).
- The build attestation shown in the install dialog is a link to check by hand; Transcoda does not verify it yet.

Install, update, remove, enable, disable, settings and catalogs are admin-session actions only: no API token scope and no MCP tool reaches them (`plugins.list` is readable with the `read` scope and never includes settings).
