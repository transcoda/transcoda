# M3 phase-1 gate

The manual run that closes phase 1 of M3 (plugins): the example plugin installed from a local catalog, run in a workflow, a plugin crash, the crash loop and the sandbox suite. Performed on 2026-10-17 on branch `m3-plugins` (core) with the plugins repo's `m3-plugins` branch. Rulings and the open findings are in [`decisions.md`](decisions.md) under "M3 plugins (phase 1)". The security hardening that followed (plugin user, signatures, blocklist) is under "M3 security hardening" there; this record is the state before it, so its 17 probes are 19 today.

## Setup

- `pnpm build` in the core repo (web bundle, `apps/server/dist/main.js` 653 kB and `plugin-host.js` 244 kB) and `pnpm bundle` in the plugins repo: `plugins/example/dist/example-1.0.0.js`, 382,635 bytes, sha256 `549f96130a…113240f`, identical to the checksum in `examples/plugins/local-catalog.json` (the build is reproducible).
- A throwaway instance: `TRANSCODA_CONFIG_DIR` and `TRANSCODA_TRANSCODE_DIR` in a temporary folder, the production bundle (`node apps/server/dist/main.js`) on `127.0.0.1:18930`, `NODE_ENV=development` (a local catalog and dev plugins are refused in production), `TRANSCODA_PLUGIN_CATALOG_URL=file://…/examples/plugins/local-catalog.json` and `TRANSCODA_PLUGIN_CATALOG_KEY=none` (that run predates signing; today the unsigned local catalog needs `none`).
- The catalog's bundle urls point at `http://127.0.0.1:18931/`, served from the plugin's `dist` folder by a 12-line Node `http` server (HTTP/1.1 with `Content-Length`). **Not** `python3 -m http.server`: see finding 2.
- Media: a 3-second 320×180 h264/aac `.mkv` generated with ffmpeg in a temporary library folder (never real media), mtime aged past the settle window.
- A generated throwaway admin through `/auth/setup`. The Plugins page was not driven for this run; every step used the same procedures through the REST API with the session cookie and CSRF token (the UI is covered by Task 13's browser check). No token or key value appears here.

## Steps and outcomes

| # | Step | Outcome |
| --- | --- | --- |
| 1 | `GET /plugins/catalog` | One catalog (the configured one, marked official) listing `example` 1.0.0, `compatible: true`, `installed: null`. |
| 2 | Install `example` 1.0.0 (`POST /plugins`) | State `running`, nodes `["example:extension-is"]`, provenance sha256 as in the catalog. `/config/plugins` holds `example-1.0.0.js` and `.manifest.json` (mode 0600, directory 0700). |
| 3 | Workflow "Gate A": Manual input → `example:extension-is` (mkv) → Encode video (hevc, ultrafast) → Replace original; saved v1 | Valid; one warning (`NO_WRITE_PATH`, the unconnected else port). |
| 4 | Dry run (`dryRun: true`) | Job `dry_run`. Trace: `input pass core`, `ext decide plugin "extension mkv is one of mkv"`, `encode build core`, `replace finish core`. The decide entry carries `source: "plugin"` (the plug icon in the UI). |
| 5 | Activate v1, real run on the file | Job `done`, attempt 1, 40,975 → 41,376 bytes (a 3-second clip grows when re-encoded), original in the recycle folder; same trace. |
| 6 | Disable the plugin | State `disabled`; the active version reports `runnable: false` with `PLUGIN_UNAVAILABLE` "Extension is can't run: plugin example is disabled"; `jobs.queue` for real is refused `WORKFLOW_INVALID` with that issue. Enable: `running`, runnable again. |
| 7 | `kill -9` the plugin process, then queue at once | The queue is refused `WORKFLOW_INVALID` / `PLUGIN_UNAVAILABLE` while the plugin restarts (about 1 s); a later job runs normally (`done`). |
| 8 | `SIGSTOP` the plugin, queue a real job (it sits in `deciding`), then `kill -9` it | **Not the expected outcome.** Attempt 1 is aborted and requeued as attempt 2 at once, whose start-of-run validation sees the restarting plugin and ends the job `failed: workflow invalid: Extension is can't run: plugin example is not running: was killed`. The plugin itself came back running. The brief expected "retries (attempt 2) and ends `done`"; see finding 1. |
| 9 | Remove `example` (`DELETE /plugins/example`, `confirm: true`), restart with `TRANSCODA_DEV_PLUGINS` = the fixture bundles `example` 0.1.0 (has `example:note`, a `notify` finish node) and `crash` 0.1.0 | Both `running`. The active workflow "Gate A" is runnable again against the dev `example`. |
| 10 | Workflow "Gate B": Manual input → `example:extension-is` → Encode video → Replace original → `example:note` (required); activate; real run on a second copy | Job `done`; trace `note finish plugin "note queued"`; the file is replaced before the step. The step's own success message (`noted <path>`) is a `plugin finish step` log line: in this development-mode run the logger prints only `msg`, so the line shows without its fields (production's JSON logs carry them). |
| 11 | Edit the note (`fail: true`), save v2, activate, real run on a third copy | Job `done`, problems `["note failed on purpose"]` (the step ran after the write; a failed required step is a problem, the job stays `done`). |
| 12 | `crash` plugin, setting `mode: exit`, Restart | `stopped`, "exited with code 3" at once (a failed first start is not retried). |
| 13 | `mode: timer` (throws 20 ms after start), Restart | `running` → `restarting` ("crashed: crash from a timer", next restart time shown) → after 3 crashes in 10 min `stopped: crashed: crash from a timer (3 crashes in 10 min)`. `example` stayed `running` throughout; `GET /plugins` showed exactly one `stopped`. |
| 14 | `mode: none`, Enable on the stopped plugin | `running`. |
| 15 | `pnpm exec vitest run apps/server/src/plugins/sandbox.test.ts` | 6 passed (17 probes, the `envKeys` probe filters macOS's `__CF_USER_TEXT_ENCODING`). |
| 16 | `node apps/server/dist/main.js --check-plugin <denial fixture> --expect-denials --other-bundle apps/server/dist/main.js` | Exit 0, `ok: true`, `probes: 17`. `--check-plugin` on the built example bundle: exit 0, `compatible: true`. |
| 17 | `pnpm check` in both repos | Run at the end of the task; results in the task report. |

Not run here: the image-level sandbox job (Task 14) runs in CI on the built image; no Docker was used for this record.

Stopped afterwards by pid: the server (and with it the plugin processes) and the catalog file server; nothing listens on 18930/18931 and no `plugin-host` process remains.

## Findings

1. **Kill during decide fails the job (step 8). Fixed.** `prepare` now waits for a plugin that is starting or restarting (up to its next restart plus the start timeout) before it validates; a stopped, disabled or removed plugin still fails the job at once. Test: kill -9 of the real example plugin during decide ends the job `done` (attempt 2).
2. **A Node 24.21 `fetch` crash (undici, HTTP/1.0 host). Fixed.** Installer and catalog downloads use `node:http(s)` (`plugins/http-get.ts`); an HTTP/1.0 or malformed host is a normal `network` failure and the server survives. `.tmp-*` files are removed on every failure path and by the startup audit. Test: raw TCP HTTP/1.0 server.
3. **Dev-mode logs are terse. Fixed.** Outside production the logger prints `msg key=value ...` (plugin, jobId, nodeId, reason, ...); production JSON is unchanged.
4. **Docs:** `/config/plugins` is created by the server with mode 0700 (confirmed in the installer), as `env.md` says.

## Hardening check (2026-10-18)

Run at core `9c5c042` (`m3-plugins`) and plugins `a6e9c97` (`m3-plugins`) on macOS arm64 with Docker Desktop (single-arch local image `transcoda:hardening-t11`, removed afterwards). Dev signing key from `sign.mjs keygen` in a temporary folder, deleted at the end; no real key or secret was used. The signed catalog, `.js.sig`, `index.json.sig` and `blocklist.json.sig` were served by a small Node HTTP/1.1 server and reached from the container as `host.docker.internal`.

| # | Step | Outcome |
| --- | --- | --- |
| 1 | Core `pnpm check && pnpm build` | Pass. |
| 2 | `pnpm --filter @transcoda/server exec vitest run src/plugins` | 19 files, 368 tests passed (`probes: 19` asserted in `check-plugin.test.ts`). |
| 3 | Plugins `pnpm check && pnpm bundle && node scripts/host-check.mjs` | Pass; `example-1.0.0.js` 382,657 bytes, sha256 `72493f18…c04017a`; host-check OK (same-uid on the developer machine). |
| 4 | `docker build -f docker/Dockerfile -t transcoda:hardening-t11 .` | Built. |
| 5 | `--check-plugin /app/server/fixtures/denial.js --expect-denials --other-bundle /app/server/main.js` under the compose caps (FSETID included), `--read-only`, tmpfs | `ok: true`, `probes: 19`, `isolation: { uid: 65001, gid: 65001, capEff/capPrm/capAmb: 0000000000000000, noNewPrivs: 1 }`. |
| 6 | `docker/entrypoint.test.sh` in `node:24.22.1-bookworm-slim` with the real `setpriv` | `all entrypoint checks passed` (no `not ok`). |
| 7 | Compose file (`docker compose config` valid), the seven checks, local image, named volumes | Healthy; check 1: `CapPrm/CapEff/CapBnd/CapAmb 00000000000000e0`, `NoNewPrivs 1`; 3: `kill: Operation not permitted`; 4: `touch /app/x` read-only file system, `/run/transcoda/plugins` `2710 1000:65001`; 5: ffmpeg smoke exit 0; 6: no `plugin hosts run as the server's user`, no `transcoda-entrypoint: warning`, no `could not create`; 7: `down -v`. Check 2 (plugin user cannot read `/config`, `/transcode`): see finding 1. Children setpriv line: `CapPrm/CapEff/CapInh/CapAmb 0000000000000000`, `NoNewPrivs 1`. |
| 8 | B4: signed custom catalog added with `dev:<hex>`, `example` installed (`running`, `signedBy dev`), catalog removed, plugin restarted | `stopped`, reason `signed with an unknown key dev; update the plugin`. |
| 9 | Signed local catalog end to end (`NODE_ENV=development`, `TRANSCODA_PLUGIN_CATALOG_URL`, `TRANSCODA_PLUGIN_BLOCKLIST_URL`, `TRANSCODA_PLUGIN_CATALOG_KEY=dev:<hex>`) | `GET /plugins/catalog`: signed, `keyIds ["dev"]`, no error. Install `running`; `provenance.signedBy "dev"`. `/config/plugins` holds `example-1.0.0.js`, `.js.sig`, `.manifest.json` (all 0600, folder 0700). `ps -eo uid,pid,args`: server uid 1000, `node --permission … plugin-host.js` uid 65001. |
| 10 | Bundle sha added to the blocklist (newer `generated`), re-signed, `GET /plugins/catalog?refresh=true` | `GET /plugins` shows `blocked: { reason: "hardening T11 verification entry" }`; `list_plugins` over MCP: `example 1.0.0 — running, …, BLOCKLISTED: hardening T11 verification entry`. The plugin kept running until restarted (finding 2); after `POST /plugins/example/restart`: `stopped`, `blocklisted: hardening T11 verification entry`, no host process. |

Not run: the GitHub jobs (`ci.yml`, `docker.yml`, plugins `ci.yml`, `release.yml`, `catalog.yml`).

## Findings

1. **Docker Desktop bind mounts do not enforce uid permissions.** With `./config:/config` as a host bind mount (virtiofs), the plugin user (65001) could `ls /config` although the entrypoint had set mode 750, so check 2 failed. With named volumes (ext4-like semantics, as on the CI runner) the same check passes: `Permission denied` for `/config`, `/config/secret.key` and `/transcode`. Local macOS runs of check 2 need named volumes; CT 111 (Linux bind mounts) is unaffected.
2. **A catalog refresh does not stop a running blocklisted plugin.** `service.catalog(refresh)` refreshes the list (so `blocked` shows on the card and in `list_plugins`), but only start, the hourly recheck and the next start of the plugin call `recheckBlocklist()`; the doc comment on `recheckBlocklist` says "whenever a catalog refresh is asked for". The plan's Task 11 wording (card shows `stopped: blocklisted` after the refresh) does not match Task 5's spec or code. Effect: up to an hour (the recheck interval) of a flagged plugin running after the server has the list. Suggested fix: `catalog(true)` also awaits `recheckBlocklist()`.
