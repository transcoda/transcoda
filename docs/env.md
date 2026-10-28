# Environment variables

Defaults in the "Image default" column are what the Docker image sets; the "Server default" column is what the server uses when the variable is unset (for example in local development, where `pnpm dev` sets `TRANSCODA_CONFIG_DIR` and `TRANSCODA_WEB_DIR` for you).

## Container user (entrypoint)

Handled by `docker/entrypoint.sh`, linuxserver.io style. The container starts as root only to create directories and drop privileges. It starts the server with `setpriv` as `PUID:PGID` with exactly three capabilities (`CAP_SETUID`, `CAP_SETGID`, `CAP_KILL`; bounding, inheritable, ambient and effective all `00000000000000e0`) and no-new-privileges. The server uses them to start every plugin process as `PLUGIN_UID:PLUGIN_GID` with no capabilities at all. Ids are numeric and no user or group is created: there is no passwd entry, so `docker exec transcoda whoami` prints `whoami: cannot find name for user ID <PUID>` (`unknown uid`), and the root filesystem can stay read-only. `HOME` is set to `/config`.

`/config` and `/transcode` are chowned to `PUID:PGID` (non-recursive) and get `chmod o-rwx`, so the plugin user cannot read the database, the secret key or the installed bundles. The mode change persists on a host bind mount. Plugin bundles are copied to the staging directory `/run/transcoda/plugins` (a tmpfs, owner `PUID`, group `PLUGIN_GID`, mode `2710`), which the plugin user can read.

When the container is started with `--user` (or `user:` in compose) the user switch is skipped: `PUID`, `PGID`, `PLUGIN_UID`, `PLUGIN_GID`, the `chown`/`chmod` of `/config` and `/transcode`, `TRANSCODA_CHOWN_CONFIG` and the device groups have no effect, and the plugin user is not available: the image then refuses to start unless you opt out of isolation (give that user access to the volumes and devices yourself). `UMASK` still applies.

A change to `PUID`, `PGID`, `PLUGIN_UID` or `PLUGIN_GID` takes effect when the container restarts (the entrypoint runs on every start). After changing `PUID` or `PGID`, set `TRANSCODA_CHOWN_CONFIG=1` once to re-own existing files.

| Variable | Image default | Meaning |
| --- | --- | --- |
| `PUID` | `1000` | Numeric user id the server runs as (0, or 1 to 2147483647). The mounted `/config` and `/transcode` directories are chowned to it (non-recursive). The server also reads it, together with `PGID`: when both are set, the new file the engine installs in place of an original is owned by `PUID:PGID` (even if the original had another owner), and a dry run warns `owner would change` for an original owned by someone else. |
| `PGID` | `1000` | Numeric group id the server runs as; read by the server together with `PUID`. Empty or unset means "leave ownership alone"; anything but a non-negative integer stops the server at start. |
| `PLUGIN_UID` | `65001` | Numeric user id every plugin process runs as. Must differ from `PUID`, must not be 0. |
| `PLUGIN_GID` | `65001` | Numeric group id for plugin processes. Must differ from `PGID`, must not be 0 and must not be the group of a passed-in device. |
| `UMASK` | `022` | umask for files the server creates. |
| `TRANSCODA_CHOWN_CONFIG` | unset | `1` recursively re-owns everything in `/config` to `PUID:PGID` on start. Use once after changing `PUID`/`PGID`. |

Devices `/dev/dri/*` and `/dev/mpp_service` that are passed into the container add their owning group to the server process, so hardware transcoding works without extra configuration. Devices owned by group `root` are skipped. An Intel GPU is found by its render node (`/dev/dri/renderD*` whose PCI vendor is `0x8086`, read from `/sys/class/drm`), so passing `/dev/dri/renderD128:/dev/dri/renderD128` is enough; in a Proxmox LXC container pass it in first with `devN: /dev/dri/renderD128,gid=<the host's render gid>`.

The compose file in `docker/docker-compose.yml` adds `cap_drop: [ALL]` with only the capabilities the root entrypoint needs (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETUID`, `SETGID`, `SETPCAP`, `KILL`), `no-new-privileges`, `read_only: true`, tmpfs mounts at `/tmp` and `/run/transcoda`, `pids_limit: 1024` and `mem_limit: 4g` (the only hard ceiling on total memory; size it as server ~512 MB + 256 MB per enabled plugin + what your ffmpeg settings need). Keep them: the plugin isolation needs the tmpfs at `/run/transcoda` and the three capabilities; the image CI job checks all of it.

## Image layout

`/app/server/main.js` is the server; `plugin-host.js` sits beside it (the sandboxed process every plugin runs in; it is found relative to `main.js`). `/app/server/fixtures/denial.js` is a plugin that probes the sandbox, used by the image's CI check (`node /app/server/main.js --check-plugin /app/server/fixtures/denial.js --expect-denials --other-bundle /app/server/main.js`); its JSON result has an `isolation` field with what the OS reported for the plugin process (`uid`, `gid`, `capEff`, `capPrm`, `capAmb`, `noNewPrivs`), which the CI job asserts (`65001`, all capability sets `0000000000000000`, `noNewPrivs` 1). `/config/plugins` (installed bundles) is created by the server on first use, mode 0700. `/run/transcoda/plugins` is the staging directory for plugin bundles (see above); it must be writable, so the root filesystem can be read-only only with a tmpfs there. `/app/third-party.json` and `/app/THIRD_PARTY_NOTICES.txt` list every third-party component in the image (the npm packages of web and server, jellyfin-ffmpeg with its source location, Node.js, the Debian base, vendored icons) with its licence and full text; they are generated at build time by `pnpm notices`, and the server reads the JSON for Settings → About → Open-source licences.

## Server

| Variable | Server default | Image default | Meaning |
| --- | --- | --- | --- |
| `TZ` | system zone | unset (UTC) | Time zone (IANA name such as `America/New_York`) for scheduled run hours and the Jobs page's days and Saved today. UTC when unset in the image. |
| `TRANSCODA_PORT` | `8080` | `8080` | Listen port (1-65535). UI, RPC and REST share it. |
| `TRANSCODA_HOST` | `0.0.0.0` | `0.0.0.0` | Listen address. |
| `TRANSCODA_CONFIG_DIR` | `/config` | `/config` | Database (`transcoda.sqlite`), `backups/` and the generated `secret.key`. |
| `TRANSCODA_BUILD_ID` | a hash of the running server file | the `TRANSCODA_BUILD_ID` build-arg, empty by default (then the hash) | Identifies the build for the [backups](#database-backups): when it differs from the one stored at the last start, the database is backed up before anything else writes. Up to 64 letters, digits, `.`, `-` or `_`; anything else stops the server at start. Unset or empty: the first 12 hex characters of the sha256 of the server bundle (`/app/server/main.js` in the image), so every image with different server code counts as a new build. |
| `TRANSCODA_TRANSCODE_DIR` | `/transcode` | `/transcode` | Scratch space for transcodes. Put it on a fast disk. |
| `TRANSCODA_FFMPEG_PATH` | `ffmpeg` (from `PATH`) | `/usr/lib/jellyfin-ffmpeg/ffmpeg` | ffmpeg binary used for the capability probe and for every job. |
| `TRANSCODA_FFPROBE_PATH` | `ffprobe` beside `TRANSCODA_FFMPEG_PATH` when that contains a `/`, else `ffprobe` from `PATH` | `/usr/lib/jellyfin-ffmpeg/ffprobe` | ffprobe binary used to probe source files and verify outputs. |
| `TRANSCODA_OUTPUT_ROOTS` | none | unset | Comma-separated absolute paths the `core:move-copy` node may write to (the output goes to `<root>/<path relative to the library root>`). A relative entry stops the server at start. With none set, `core:move-copy` is unavailable and workflows that use it do not validate. |
| `TRANSCODA_WEB_DIR` | none (UI not served) | `/app/web` | Directory with the built web UI, served at `/`. |
| `TRANSCODA_SECRET_KEY` | generated | unset | Exactly 64 hex characters. If unset, a key is generated once and stored in `$TRANSCODA_CONFIG_DIR/secret.key` (mode 0600). Back it up with `/config`; losing it signs everyone out **and loses every plugin's integration secrets** (API keys and tokens are stored encrypted with a key derived from it; after a loss the plugins' settings must be entered again). |
| `TRANSCODA_ALLOWED_HOSTS` | none | unset | Comma-separated host names (no port) the UI may be reached by, in addition to the host recorded at setup and `localhost`/`127.0.0.1`/`::1`. Host checks are off until setup is done. |
| `TRANSCODA_PUBLIC_URL` | none | `https://transcoda.example.net` | The origin (scheme, host, optional port; no path) users reach the UI by. Plugins use it to link to a job's page (`<origin>/jobs/<id>`), for example in ntfy and Discord notifications. Unset: notifications carry no link. A trailing slash and a default port (`:80` for http, `:443` for https) are dropped. An invalid value stops the server at start. |
| `TRANSCODA_TRUSTED_PROXIES` | none | unset | Comma-separated IPs or CIDRs of reverse proxies. `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` are honoured only from these peers. With none set they are ignored: HTTPS is not detected behind a proxy (cookies lose the `Secure` flag), a proxy that rewrites `Host` breaks the host check, and every client behind the proxy shares the proxy's address, so they all share one per-IP login limit (5 failed logins a minute locks everyone out for a while). See [Reverse proxies](#reverse-proxies). |
| `TRANSCODA_ENCODE_STALL_MINUTES` | `60` | unset | An encode whose ffmpeg writes no more output (its reported output time and size stop growing) for this many minutes is stopped, and the job fails with a reason that says so; it is not retried. Time the job or the queue is paused does not count. It guards against an ffmpeg that keeps reading the source while holding all output back in memory; a slow encode still writes output every few seconds and is never stopped. `0` turns the guard off. A positive number or `0`; invalid stops the server at start. |
| `TRANSCODA_HEALTH_STALL_HOURS` | `6` | unset | Deep health (`?deep=1`, see [Monitoring](#monitoring)): a running job (`probing`, `deciding`, `building`, `encoding`, `verifying`, `replacing`) whose last update is older than this many hours fails the `queue` check. A positive number; invalid stops the server at start. |
| `TRANSCODA_HEALTH_MIN_FREE_GIB` | `5` | unset | Deep health: the `scratchSpace` check needs at least `max(5, this)` GiB free on `TRANSCODA_TRANSCODE_DIR`. A positive number; invalid stops the server at start. The same margin guards kept test-encode outputs: one that would leave less free is deleted at once (`not kept: scratch space low`), and before a real job encodes the oldest kept outputs are deleted while less is free. |

## Plugins

Plugins are installed from the Plugins page into `$TRANSCODA_CONFIG_DIR/plugins` (created by the server on first use, mode 0700). Back that folder up with `/config`. Each enabled plugin runs in its own sandboxed process; see [`plugin-sdk.md`](plugin-sdk.md) for the limits and the security promise. Everything Transcoda downloads from the official catalog is verified with ed25519 signatures: the catalog index, each bundle (checked at install and again before every start) and the blocklist. The public keys are pinned in the server build (`apps/server/src/plugins/official-keys.ts`) and can be replaced with `TRANSCODA_PLUGIN_CATALOG_KEY`. A build with no key pinned refuses the official catalog and logs `official plugin catalog is refused: no signing key is pinned in this build` once at start. A custom catalog is unsigned unless you enter its key when adding it, as `<keyId>:<64 hex characters>` (several keys comma-separated; same format as `TRANSCODA_PLUGIN_CATALOG_KEY`); a signed custom catalog's bundles are checked against those keys before every start, and removing the catalog makes its plugins stop at their next start with `signed with an unknown key <id>; update the plugin`. A plugin installed without a signature stays unchecked (reinstall it from a signed catalog). The signed blocklist (`TRANSCODA_PLUGIN_BLOCKLIST_URL`) is fetched at start and then hourly: a fetch or verification problem blocks nothing and keeps the last good list, a match always blocks (install, update and every start; an installed plugin it names is stopped with `blocklisted: <reason>`). The blocklist uses the same keys as the official catalog, so it does nothing until a key is pinned (or `TRANSCODA_PLUGIN_CATALOG_KEY` names one).

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRANSCODA_PLUGIN_CATALOG_URL` | `https://raw.githubusercontent.com/transcoda/transcoda-plugins/catalog/index.json` | The official catalog (shown first, cannot be removed). Must be `https` in production; outside production `http:` and `file:` are accepted too (for a local catalog, see `examples/plugins/local-catalog.json`). Entries inside a catalog index are always `http(s)` urls, `https` in production. A self-hosted catalog placed in this slot is **official** for Transcoda: it is verified with the pinned keys (or `TRANSCODA_PLUGIN_CATALOG_KEY` when that is set), so it must be signed with them; a local unsigned catalog needs `TRANSCODA_PLUGIN_CATALOG_KEY=none`. An invalid value stops the server at start. |
| `TRANSCODA_CATALOG_TOKEN` | unset | A token sent as a bearer credential to the catalog and release hosts only (`github.com`, `api.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`, over https, re-checked on every redirect), for a private catalog repository. Never sent anywhere else. |
| `TRANSCODA_PLUGIN_HOST` | `plugin-host.js` beside the running `main.js` | Absolute path of the plugin host entry. The image and `pnpm dev` set this up; you normally never set it. |
| `TRANSCODA_DEV_PLUGINS` | unset | Comma-separated absolute paths of plugin bundles to load directly (still sandboxed, never persisted). Refused (the server stops at start) when `NODE_ENV=production`. |
| `TRANSCODA_PLUGIN_INSPECT` | unset | `1` starts plugin hosts with the Node inspector enabled. Refused when `NODE_ENV=production`. |
| `TRANSCODA_PLUGIN_UID`, `TRANSCODA_PLUGIN_GID`, `TRANSCODA_PLUGIN_RUN_DIR`, `TRANSCODA_SETPRIV` | unset | The entrypoint sets the first three from `PLUGIN_UID`, `PLUGIN_GID` and the staging directory (`/run/transcoda/plugins`); `TRANSCODA_SETPRIV` defaults to `/usr/bin/setpriv` (the entrypoint does not set it). You normally never set any of them. |
| `TRANSCODA_PLUGIN_CATALOG_KEY` | the pinned official key | The keys the official slot (the catalog at `TRANSCODA_PLUGIN_CATALOG_URL`, its bundles and the blocklist) is verified with. Unset, empty or only whitespace: the keys pinned in the build. `<id>:<64 lowercase hex characters>`, comma-separated for several: **replaces** the pinned set, also in production (whoever sets the environment controls the server anyway); the id must match the `keyId` in the signature files. `none`: no signature checks, accepted outside production only (with `NODE_ENV=production` the server stops at start); installs made while it is set are recorded unsigned, and switching to real keys later does not check them: reinstall them. A malformed value stops the server at start (`TRANSCODA_PLUGIN_CATALOG_KEY: <entry>: expected <id>:<64 hex>`). |
| `TRANSCODA_PLUGIN_BLOCKLIST_URL` | `https://raw.githubusercontent.com/transcoda/transcoda-plugins/catalog/blocklist.json` | The signed blocklist of plugin builds that must not be installed or run; its signature is `<url>.sig`, verified with the same keys as the official catalog (with `TRANSCODA_PLUGIN_CATALOG_KEY=none` it is read unsigned). Same url rules as the catalog url. Cached under `$TRANSCODA_CONFIG_DIR/plugins/.catalog`. |
| `TRANSCODA_PLUGIN_ISOLATION` | unset | Unset or `off` (anything else stops the server at start). With `NODE_ENV=production` on Linux the server refuses to start when plugin isolation is not configured (the container was started with `--user`, or the entrypoint could not prepare `/run/transcoda/plugins`: it then logs `plugin isolation is off` and exports no plugin user), unless this is `off`; the server then runs plugins as its own user (same uid) and logs `plugin hosts run as the server's user`. `off` means exactly that: same uid, and no capabilities. The entrypoint starts the server without any (`CapEff`, `CapPrm`, `CapAmb` 0, no-new-privileges) because it will not need to switch users, and a server that still carries ambient capabilities starts plugin hosts, ffmpeg and ffprobe through `setpriv --inh-caps=-all --ambient-caps=-all --no-new-privs`. Under `off` a plugin can still signal Transcoda's process and read `/config`. In the image the entrypoint honours it too: with `off` it exports no plugin user, leaves `/run/transcoda` alone and starts the server without capabilities. Run directly (outside the entrypoint) with a plugin user configured, the server ignores `off`. Outside production nothing is required. |

Plugin limits (timeouts, memory, restart backoff, fetch limits) are settings rows named `plugins.limits.<key>` in the database (for example `plugins.limits.finishRunTimeoutMs`), default as listed in [`plugin-sdk.md`](plugin-sdk.md); a value that is not a positive integer within a sane bound is ignored. The call timeout (`plugins.limits.callTimeoutMs`) is editable in Settings → Plugins and applies to the next call; the other limits stay rows read at start.

The plugin and catalog processes need the network only as far as the plugins' own integrations do: Transcoda fetches the catalog index (cached for an hour) and the bundles you install.

## Database backups

Backups are `VACUUM INTO` copies of `transcoda.sqlite` in `$TRANSCODA_CONFIG_DIR/backups/`, named `transcoda-<YYYYMMDD-HHmmss>-v<schema>[-build|-manual].sqlite` (local time; a second backup within the same second gets `-2`, `-3`, …). One is taken:

- before pending migrations are applied to an existing database (no suffix; `v` is the schema version before the migration);
- at start, after the migrations and before anything else writes (plugins, workflow upgrades, the engine), when the build differs from the one stored at the last start in the `app.lastBuildId` settings row, or when none is stored and the database already existed (`-build`; not when a migration backup was just taken; see `TRANSCODA_BUILD_ID`);
- by **Back up now** under Settings → About (`-manual`; a signed-in browser session only, never an API token or MCP).

The 5 newest of each reason are kept (migration, build change, manual), so build-change and manual backups never evict the copy taken before a migration. A backup is written to `<name>.part`, fsynced and renamed into place, so a failed one never shows up as a backup; a failed migration or build-change backup stops the start (as with any startup error, the container exits), so a full or read-only config disk blocks the start until it is fixed. **Back up now** is refused for 30 seconds after the last one (HTTP 429). Settings → About lists them by file name, size, time and reason (`GET /api/v1/system/backups`, a session or a token with `read`), each with a **Download** link: `GET /api/v1/system/backups/<name>/download` streams the file as an attachment (`application/vnd.sqlite3`, `Cache-Control: no-store`). The download is for a signed-in browser session only: every API token is refused (403), there is no MCP tool, a cross-site request is refused (the session cookie is `SameSite=Lax`, and `Sec-Fetch-Site: cross-site` or a foreign `Origin` gets 403), and a name that is not a listed backup (a `.part` file, a path, `..`, a symlink, anything else) gets 404. It is not in the OpenAPI spec.

A backup holds what the database holds: the users' argon2id password hashes, the SHA-256 hashes of API tokens and sessions, and the plugins' integration secrets. Keep downloaded backups private. Plugin secrets are encrypted (AES-256-GCM) with a key derived from `secret.key`, which is not in the backup, so a backup alone does not reveal them; with `secret.key` (or `TRANSCODA_SECRET_KEY`) it does.

To restore one: stop Transcoda (the container), copy the backup over `transcoda.sqlite` in the config folder, delete `transcoda.sqlite-wal` and `transcoda.sqlite-shm` if they exist, then start it again. An older backup is migrated again at start (and backed up first); a database newer than the server is refused (exit code 3). Restore next to the same `secret.key` (or `TRANSCODA_SECRET_KEY`): with another key the plugin secrets cannot be decrypted and have to be entered again.

## Settings in the database

A few settings are rows in the database (`settings` table), not environment variables. They have defaults and are changed in the UI under **Settings** (a signed-in browser session only: the API refuses every API token for a change, whatever its scopes, and no MCP tool reads or changes them). A change applies without a restart. A row that is not valid reads as the default.

| Key | Default | Changed in | Meaning |
| --- | --- | --- | --- |
| `server.name` | none | Settings → General | A name shown in the top bar and the browser tab title (at most 64 characters; empty removes it). Shown to signed-in people only. |
| `ui.theme` | `system` | Settings → General | `system` (follows the browser), `dark` or `light`, for every browser of this server; applied on the sign-in page too. |
| `recycle.retentionDays` | `7` | Settings → Recycle | Recycled originals older than this many days are removed (checked at start and every 10 minutes). |
| `recycle.maxFreePercent` | `25` | Settings → Recycle | Per library, the oldest recycled originals are removed while they take more than this percentage of the free space plus their own size on that filesystem. |
| `plugins.limits.callTimeoutMs` | `30000` | Settings → Plugins | How long a plugin's `decide`, `build`, `finish` or `data` call may take (1 s to 1 h); applies to the next call. |
| `queue.paused` | `false` | Pause / Resume | Whether the queue is paused. Written by the pause and resume actions and read at start, so a pause survives a restart. |

Settings also shows the environment variables that matter there (`TRANSCODA_PUBLIC_URL`, `TRANSCODA_ALLOWED_HOSTS`, `TRANSCODA_HEALTH_STALL_HOURS`, `TRANSCODA_HEALTH_MIN_FREE_GIB`, `TRANSCODA_PLUGIN_ISOLATION`) read-only, with their names and effective values; they are changed in the environment and need a restart. `GET /api/v1/settings` (a session, or a token with `read`) answers the same values; it never returns a secret.

Per-library options (`recycleFolder`, `processHardlinked`, `verifyFullDecode`) are set through the libraries API, not the environment.

The folder picker in the New library dialog (a signed-in browser session only, never an API token or MCP) lists only folders Transcoda can read and greys out ones it cannot write to. It never shows or enters `.`-named folders, `/proc`, `/sys`, `/dev`, `/run`, `/etc`, `/boot`, `/root`, the config folder (`TRANSCODA_CONFIG_DIR`), the transcode folder (`TRANSCODA_TRANSCODE_DIR`), the plugin run folder (`TRANSCODA_PLUGIN_RUN_DIR`), Transcoda's own install folder, or anything under them. This holds for the path as typed, for its real path (a symlink into one is hidden, and a symlink inside one that points out is still refused) and, on Linux, for a bind mount of one of them (matched by device and inode on the folder and each parent). It reads at most 20,000 entries of a folder and lists at most 500; beyond either the list says it is cut off. Every refusal has the same response body, so the answer does not say whether a folder is hidden, missing or unreadable; response time is not made uniform. A path can still be typed; the server validates it as before.

## Monitoring

- **Liveness:** `GET /api/v1/system/health` answers `200 {"status":"ok","version":"..."}` while the web server answers. It touches nothing else.
- **Deep:** `GET /api/v1/system/health?deep=1` answers `200` with a `checks` object when everything is fine and `503` (error code `UNHEALTHY`) when a check fails. It runs at most one real check per 10 seconds; callers in between get the last answer. It is public (no sign-in) but still behind the host check. The checks:
  - `database`: a settings row can be written and read back in one transaction.
  - `ffmpeg`: the startup ffmpeg probe found a working ffmpeg.
  - `scratchSpace`: `TRANSCODA_TRANSCODE_DIR` has at least `max(5, TRANSCODA_HEALTH_MIN_FREE_GIB)` GiB free.
  - `queue`: no job's replace is waiting for free space on the media filesystem (a replace needs the replacement's size plus 5 GiB free there and waits until it has it; the log line names the job, the space it needs and the space free), and no running job has gone `TRANSCODA_HEALTH_STALL_HOURS` hours without progress. Queued jobs waiting do not count, nor do paused jobs or a paused queue. Each check is cut off after 5 seconds and counts as failed.

  The body carries check names and `ok`/`fail` only, never a path or an error message. To see why a check failed, read the server log for `deep health check failed`. That log line carries the error message of a check that threw, which can include the transcode path: keep that in mind when forwarding logs.
- **Uptime Kuma:** add an HTTP(s) monitor on `http://transcoda:8080/api/v1/system/health?deep=1`, interval 30 seconds or more, accepted status `200`.
- **Healthchecks.io** is push-based: run a cron job next to Transcoda, for example `curl -fsS --max-time 30 "http://transcoda:8080/api/v1/system/health?deep=1" && curl -fsS https://hc-ping.com/<uuid>`. The ping is only sent when the deep check passes.
- **The monitor's host name must be allowed.** Add it to `TRANSCODA_ALLOWED_HOSTS` (for example `transcoda` when it calls `http://transcoda:8080`), otherwise the monitor gets `403`.

## Reverse proxies

Put the proxy in front of port 8080 and tell Transcoda to trust it:

1. Set `TRANSCODA_TRUSTED_PROXIES` to the proxy's address as Transcoda sees it, for example the Docker network range (`172.16.0.0/12`) when the proxy runs in another container, or the proxy host's IP. Only then are the forwarded headers used: the client's IP for the login limit, HTTPS for the `Secure` cookie flag, and the public host name for the host check.
2. Pass the original host name. The host check and the setup and sign-in requests compare it with the browser's `Origin`, and setup records it as an allowed host.
   - nginx rewrites `Host` to the `proxy_pass` target by default, so forward the original:

     ```nginx
     location / {
       proxy_pass http://transcoda:8080;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_set_header X-Forwarded-Host $host;
     }
     ```

   - Caddy (`reverse_proxy`), Traefik and Nginx Proxy Manager pass `Host` through unchanged and set `X-Forwarded-For` and `X-Forwarded-Proto` themselves; nothing extra is needed.
3. If the proxy rewrites `Host` and cannot send `X-Forwarded-Host`, or it is not in `TRANSCODA_TRUSTED_PROXIES`, add the public host name to `TRANSCODA_ALLOWED_HOSTS`. Otherwise the UI shows "This host name isn't allowed" once setup is done.

## Build and development only

| Variable | Used by | Meaning |
| --- | --- | --- |
| `TRANSCODA_VERSION` | server | Build time, not a runtime setting: `tsdown` replaces it with the version from `apps/server/package.json` when bundling, so setting it on a container or `node dist/main.js` has no effect. Only when running from source with `tsx` (`pnpm dev`) is it read from the environment, falling back to `0.0.0-dev`. |
| `TRANSCODA_BUILD_FIXTURES` | server build | Build time only: `1` makes `pnpm build` also bundle the sandbox denial fixture plugin (`fixtures/denial-0.1.0.js`). The Docker image build sets it so CI can run `--check-plugin denial --expect-denials` against the image; leave it unset otherwise. |
| `TRANSCODA_API_URL` | `pnpm --filter @transcoda/web dev` | Where the Vite dev server proxies `/api` and `/rpc` (default `http://localhost:8080`). |
