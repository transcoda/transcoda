# Plugins: user guide

Plugins add nodes, integrations and finish steps to Transcoda. Six official ones ship with M3: **Sonarr**, **Radarr**, **Jellyfin**, **TMDB**, **ntfy** and **Discord**; **Bazarr** and **Seerr** (Jellyseerr, Overseerr) follow. This page is for people who run Transcoda; to write a plugin, read [`plugin-sdk.md`](plugin-sdk.md). Variables mentioned here are listed in [`env.md`](env.md).

## Installing

Open **Plugins** in the side navigation. The catalog lists every plugin the configured catalogs offer, grouped by what it is for (media managers, media servers, metadata, notifications), each card with its latest version and the nodes it adds; a search box and **All / Installed / Updates** narrow the page. When your workflows use nodes of a plugin that is not installed, a card at the top names those plugins and the workflows, with one button that installs them one confirmation after the other. **Install** opens a dialog that shows where the build came from (built by CI or from a custom catalog, signed or unsigned, its checksum and, when there is one, a link to its build attestation) and the security promise below. Installing downloads one JavaScript file, verifies its checksum and signature, and starts it in its own process; only an admin session can install, update or remove a plugin (never an API token, never MCP).

**The official catalog** is built into Transcoda. It only lists builds made by our CI from the public source, signed with a key this version of Transcoda knows. The line next to the search says when it was last read and how many builds the blocklist names; **Refresh** reads it again. **Catalog details** at the end of the page shows the full addresses, how each catalog is signed and the blocklist; a blocklist we publish stops known-bad builds within an hour.

**Custom catalogs** (a URL to an `index.json`, optionally with the signing key `<keyId>:<64 hex>` that pins who may sign it) are added under **Catalog details** at the end of the Plugins page. A custom catalog is unsigned unless you enter its key, and the page shows this warning:

> Plugins are code that runs inside Transcoda. Only install from sources you trust. The sandbox stops file writes and new processes, not the network; an unsigned catalog is only as trustworthy as whoever controls its URL.

After installing, the plugin appears under **Installed**: its name and version, the workflows that use it, and a status (**Connected**, **Can't reach server** and the like, from its last connection test; **Stopped** or **Disabled** when it does not run). **Settings** opens below the row: for a plugin with an integration (all official ones have one) fill in the URL and key and use **Save and test**, or **Test connection** to check values without saving. The last test is shown with what a failure costs (for a media server: files are still replaced, only the library refresh is skipped). Settings also hold **Disable**, **Restart**, **Remove plugin**, the nodes it adds and the other catalog versions it can switch to. Secrets are stored encrypted and never shown again: a saved one reads "Stored, ends in 4f2a" (the last four characters, only for a token-like secret of 20 characters or more; a passphrase reads just "Stored") with **Replace**, and is never written to a log.

## What the sandbox does and does not do

> Plugins are code that runs inside Transcoda. Treat installing one like installing software on the server. Each plugin runs in its own process under Node's permission model: it can read only its own bundle, cannot write files, start programs, load native code or read other plugins' settings, and it never touches your media or the database — Transcoda does all file work and gives plugins data only. Its memory and the time each call may take are limited, and a plugin that crashes is restarted and, if it keeps crashing, stopped, with its nodes marked in the editor.
>
> This is accident protection, not a wall. A malicious plugin could still use the network freely (Transcoda offers a controlled HTTP client, but cannot block raw sockets: the network is outside Node's permission model) or exhaust memory the heap limit does not count. In the Docker image every plugin process runs as a separate unprivileged user, shared by all plugins, so it cannot signal Transcoda's own process or read `/config` (plugins can still signal each other); outside the image, when the container is started with `--user`, or with `TRANSCODA_PLUGIN_ISOLATION=off`, plugins share Transcoda's user and can do both. The official catalog only lists builds made by our CI from the public source, signed with a key this version of Transcoda knows; the signature and checksum are verified before every start, and a blocklist we publish stops known-bad builds within an hour. Custom catalogs are unsigned unless you pin their key, and show a warning for this reason. Install only what you would run on the server yourself.

## Updating

When a catalog has a newer version the plugin's row says so and offers **Update**. Before anything changes, the Update dialog asks the server what the update would do to your workflows and answers in one of four ways:

- **No workflow is affected.** Update runs as soon as you confirm.
- **Unknown.** The release does not say which node versions it serves, so the dialog warns that workflows pinned to older versions may stop running.
- **Review needed.** The newest version of some workflows uses nodes the update changes. Transcoda writes a new version of each for you to review where an upgrade exists. The versions that are active now are not touched, and they keep running. This applies to a safe-only update too: when a safe migration changes the newest saved settings, Transcoda may write a new workflow version with them, while the active version stays as it is and keeps running.
- **Would stop running.** An active workflow version pins a node version that the update either no longer provides (reason: dropped) or changes in a way that alters what the node does (reason: behaviour). The dialog names each workflow and its active version, and the Update button turns red.

Plugin nodes carry a version, and a workflow version remembers the node version it was saved with. When an update only adds a setting or makes another change that cannot alter results (a *safe* migration), a workflow pinned to the older node version keeps running: the plugin migrates its settings every time the node runs. When a migration changes behaviour, Transcoda does not guess. The active version that uses the node is held: it shows `plugin update changes behaviour of <title>; review and activate a new version` and does not run (no job starts, so nothing runs with the wrong settings). The update also wrote a new version of that workflow with the migrated settings; open it, check it, and activate it. A dropped node version has no migration path, so the active version reads "no upgrade path" and does not run until you activate a version without it. Disabling or removing a plugin has a similar confirmation that names the workflows it affects.

## Official plugins

### Sonarr

Nodes: **Original language (Sonarr)** (`sonarr:original-language`, a data node) and **Rescan in Sonarr** (`sonarr:rescan`, a finish step). Needs Sonarr 4.0 or newer.

Settings:

| Setting | What it is |
| --- | --- |
| URL | For example `http://sonarr:8989`. |
| API key | Sonarr → Settings → General. A secret. |
| Path mappings | Pairs of **remote** (the path as Sonarr sees it) and **local** (the path as Transcoda sees it). Leave empty when both see the same folders. |
| Accept a self-signed certificate | For an https URL with a self-signed certificate. |

On a server where Sonarr and Transcoda both see the library at `/data/shows` there is nothing to map. If Sonarr saw `/tv` while Transcoda sees `/data/shows`, add one mapping, remote `/tv`, local `/data/shows`. A mapping row has a **Test mapping** button that checks the local side is a directory Transcoda can read.

**The "unmonitor deleted" warning.** Sonarr has the setting "Unmonitor Deleted Episodes" (Settings → Media Management; `autoUnmonitorPreviouslyDownloadedEpisodes`). When it is on, an episode whose file disappears is marked unmonitored. Transcoda replaces a file in one step, but a rescan after a container change (for example an `.mp4` that becomes `.mkv`) can see the old file as gone first, and Sonarr then stops monitoring that episode, so it will never be upgraded or re-downloaded. **Test connection** shows this as a warning (`Sonarr unmonitors deleted episodes: …`) when the setting is on. Turn the setting off, or accept that episodes can end up unmonitored. If the setting is not found in this Sonarr version, no warning is shown.

**Original language.** The node looks the file up by path (a series whose folder contains the file; `/data/shows/Show 2/S01E01.mkv` belongs to `Show 2`, never to `Show`) and outputs `language` (the series' original language), `title` and `ids` (tvdb, tmdb, imdb). Connect `language` to a language input such as the one on **Keep languages** with "keep original" on. When Sonarr does not know the file, or cannot be reached, the outputs are `unknown` and the node says why, so a tag-based filter is never fed a guess.

**Rescan.** After `core:replace-original` has written the file, the node asks Sonarr to rescan the series and waits for the command to finish (**timeoutSeconds**, 30 to 600, default 240). It then reads the series' episode files and checks that the new path is listed (paths compared after mapping, trailing slashes ignored, case-sensitive). Several files of one series finishing within about 5 seconds of each other share one rescan, even when they come from different jobs and lanes; the verification afterwards still checks each file's own path, so a file written just after the shared rescan began can fail it and needs attention. The step is *required*, and a rescan that times out gets one more try after 10 seconds. If Sonarr does not know the file, the rescan fails or times out, or the file is not listed afterwards, the step fails with a plain message (`Sonarr does not list /data/shows/Show/S01E01.mkv after rescan; episode S01E01 may show as missing`) and the job is **done, needs attention**. The file itself has been replaced and stays replaced.

**Import trigger.** Starting jobs when Sonarr imports a file (a webhook) is coming in phase 3. For now start runs by hand, from a library or the API.

### Radarr

Nodes: **Original language (Radarr)** (`radarr:original-language`) and **Rescan in Radarr** (`radarr:rescan`). Settings, path mappings and the warning work exactly as for Sonarr, with `http://radarr:7878` as the example URL, Radarr's own API key (Settings → General) and Radarr 4.0 or newer. Radarr's setting is "Unmonitor Deleted Movies" (`autoUnmonitorPreviouslyDownloadedMovies`). The node finds the movie whose file has this path, outputs `language`, `title` and `ids`, and rescans the movie after the write, verifying that the new path is listed. A failed verification is the same "needs attention" problem. The webhook trigger for imports is also coming in phase 3.

### Jellyfin

Node: **Refresh in Jellyfin** (`jellyfin:refresh`, a finish step). Needs Jellyfin 10.8 or newer.

| Setting | What it is |
| --- | --- |
| URL | For example `http://jellyfin:8096`. |
| API key | Dashboard → API Keys. A secret. |
| Path mappings | Here the pair reads **Transcoda's path → Jellyfin's path**. The default is `/data/shows → /shows` and `/data/movies → /movies`, which is right when Jellyfin mounts the same folders as `/shows` and `/movies`. Change it to match your mounts. |
| Accept a self-signed certificate | As above. |

The node has one setting, **scope**: `file` (default) tells Jellyfin that this file changed (and, after a container change, that the old path is gone); `library` asks Jellyfin to rescan every library. Jellyfin collects such notices and acts on them after about 60 seconds, so a new file shows up a minute later, not instantly. The step is optional: when Jellyfin is down or answers with an error, the job still ends **done** with a warning.

**Watched state.** Jellyfin keeps who watched what by item. When a file changes container (for example `.mp4` to `.mkv`), Jellyfin may see a new item instead of the same one. After your first run on a series you care about, check that one watched episode still shows as watched before you let a workflow loose on the whole library.

Newer Jellyfin servers take the API key in the `Authorization` header; some only accept the older `X-Emby-Token`. Transcoda tries the first and falls back, and **Test connection** warns when only the legacy header works.

### TMDB

Node: **Original language (TMDB)** (`tmdb:original-language`, a data node). You need your own TMDB API key: create a free account on themoviedb.org and copy either the API key (v3) or the API read access token from Settings → API.

| Setting | What it is |
| --- | --- |
| Credential | The key or token. A secret. |
| Language | For titles in messages; default `en-US`. |

The node has optional inputs `ids` (from a Sonarr or Radarr node) and `title`, and a setting **kind** (`auto`, `movie` or `tv`). It looks the title up by id when it has one, otherwise by title, otherwise by parsing the file name, and outputs the original language. When it cannot tell (no match, or several equally good matches) it outputs `unknown` with the reason instead of picking one. Prefer a Sonarr or Radarr node when you run them: they know the exact series or movie.

**Attribution.** TMDB's terms require this notice, which Transcoda shows in the TMDB plugin's settings and in the footer while the plugin is installed:

> This product uses the TMDB API but is not endorsed or certified by TMDB.

The logo (`apps/web/src/assets/tmdb.svg`) is TMDB's official logo from their brand page (https://www.themoviedb.org/about/logos-attribution), used unaltered and only to attribute the data; it remains TMDB's property and is not covered by Transcoda's licence.

### ntfy

Node: **Notify (ntfy)** (`ntfy:notify`, a finish step). Sends a push through ntfy.sh or your own ntfy server.

| Setting | What it is |
| --- | --- |
| URL | The ntfy server; default `https://ntfy.sh`. |
| Token | Access token (`tk_…`) for a protected topic. A secret; optional for public topics. |
| Also notify when a job fails | Off by default. When on, any workflow's failed job is announced. |
| Topic for failed jobs | Empty by default, which keeps failed-job pushes off even when the option above is on. Set a private topic (see below) to receive them. |

Node settings: **topic** (required), **title** (default `Transcoda: {{workflow}}`; `{{workflow}}`, `{{file}}` and `{{outcome}}` are replaced), **priority** 1 to 5 (default 3), **tags** and **events**: `done` sends for every finished job, `problems-only` only when the job needs attention. A job with a problem from an earlier required step always shows it in the message, whichever setting you chose. The title names the workflow; the message names the file, the outcome and the size change.

**Choose a private topic.** On the public ntfy.sh anyone who knows or guesses a topic name can subscribe to it, and the messages carry file names, sizes and problems. Pick an unguessable topic (a long random string), or use a self-hosted or token-protected ntfy server. The topic is a setting of the workflow's node, so anyone who can read workflows or jobs (the web UI, the API, or the MCP read tools) can see it; do not treat it as a secret from them. The example's `transcoda-CHANGE-ME` is a reminder to change it.

**The click link.** A notification opens the job's page when Transcoda knows its public address: set `TRANSCODA_PUBLIC_URL` (for example `https://transcoda.example.net`, no path). Unset, the notification has no link.

Failure handling: a token ntfy rejects, a message the server refuses as too large (413) or a rate limit (429) ends the step with a readable message and the job stays **done** with a warning. The token never appears in the message.

### Discord

Node: **Notify (Discord)** (`discord:notify`, a finish step). Posts an embed to a channel through a webhook.

| Setting | What it is |
| --- | --- |
| Webhook URL | Server settings → Integrations → Webhooks. **The whole URL is the secret**: anyone who has it can post to the channel. It must look like `https://discord.com/api/webhooks/<id>/<token>`. |
| Also notify when a job fails | Off by default. |
| Username | The name messages are posted as; default `Transcoda`. |

Node settings: **events** (`done` or `problems-only`, as for ntfy) and **mentionRoleId**. Mentions are off by default: a message never pings anyone, not even when its text contains an `@`. If you set a role id, that role (and only that role) is mentioned when the job needs attention, never for a clean job. To get a role id, turn on Discord's developer mode and copy the id from the role's menu.

Discord's rate limit is handled by Transcoda: it waits and retries once, and a second 429 ends the step with `Discord rate limit; try again later` (job **done** with a warning). The webhook URL never appears in a message.

### Bazarr

Nodes: **Subtitles in Bazarr** (`bazarr:has-subtitles`, a data node), **Has subtitles (Bazarr)** (`bazarr:subtitles-present`, a condition), **Get subtitles now (Bazarr)** (`bazarr:get-subtitles-now`, an action) and **Rescan in Bazarr** (`bazarr:rescan`, a finish step). Needs Bazarr 1.4.0 or newer.

| Setting | What it is |
| --- | --- |
| URL | For example `http://bazarr:6767`. |
| API key | Bazarr → Settings → General → Security. A secret; sent in the `X-API-KEY` header only. |
| Path mappings | Pairs of **remote** (the path as Bazarr sees it) and **local** (the path as Transcoda sees it), as for Sonarr. Empty by default: Bazarr usually mounts the library where Sonarr and Radarr do, so when they all see `/data/shows` and `/data/movies` there is nothing to map. |
| Timeout | Per request to Bazarr, 5 to 120 seconds, default 30. |
| Accept a self-signed certificate | As above. |

Every node finds the file the same way: it looks for an episode first (the series whose folder holds the file, then that series' episode with this exact path) and then for a movie with this path. A node setting **kind** (`auto`, `series`, `movie`) skips the guess. Bazarr's series and movie lists are kept for 10 minutes, so a series added to Bazarr a moment ago can read as unknown until then; the subtitle list of the episode or movie itself is always read fresh. Bazarr only knows a file once it has synced with Sonarr or Radarr.

**Subtitles in Bazarr** outputs `languages` (ISO 639-2, for example `deu, eng`), `forced` and `sdh` (yes when any counted subtitle is forced or for the hearing impaired). The setting **include** picks what counts: `all` (default), `external` (subtitle files next to the video) or `embedded` (tracks inside it). A file Bazarr does not know, or a Bazarr that cannot be reached, gives `unknown` with the reason, never an empty list.

**Has subtitles (Bazarr)** is the same lookup as a two-way condition: **Yes** when Bazarr lists a subtitle for every language in **languages** (three-letter codes, `eng`, `deu`; `ger` counts as `deu`), **No** otherwise (`Bazarr has no fra, spa subtitle`). A file Bazarr does not know, or an unreachable Bazarr, goes to **No** with the reason. Use it where a branch should depend on subtitles, since core conditions do not read data values.

**Get subtitles now (Bazarr)** asks Bazarr to search its providers for each missing language and waits for the files to appear, so that **Embed subtitle files** after it can add them. Settings: **languages** (Bazarr's two-letter codes, `en`, `de`), **forced** and **hi** (hearing impaired; both off by default), **waitSeconds** (5 to 25, default 25) and **kind**. Only a subtitle *file* Bazarr lists counts as present: a language that is only embedded is asked for again. The node never changes the plan itself, and Bazarr never fails the job: when Bazarr does not know the file, finds nothing in time or cannot be reached, the job goes on without new subtitles and the reason says so (`Bazarr downloaded de; Bazarr found no fr subtitle within 25 s; continuing without`). A dry run sends nothing to Bazarr (`dry run: would ask Bazarr for en, de`), so its plan shows only the subtitle files already there.

**The 25-second limit.** A plugin call may take 30 seconds (`plugins.limits.callTimeoutMs`), and the lookups and the last check count against the wait, so **waitSeconds** stops at 25. Bazarr's providers can be slower than that; a subtitle that arrives later stays next to the video and is embedded the next time the file runs through the workflow. Raising the call limit does not lengthen the wait; the node stops at 25 seconds either way.

**Rescan in Bazarr.** After the write, asks Bazarr to rescan the subtitles of the series or movie and checks that Bazarr lists the new path. Place it after **Rescan in Sonarr** or **Rescan in Radarr**: Bazarr learns a changed path (for example `.mp4` that became `.mkv`) from Sonarr or Radarr, not from its own rescan, so it looks under the new path first and then the old one. When Bazarr still lists the old path the step says so (`asked Bazarr to rescan Example Show S01E03, but it still lists …; it updates after its next sync with Sonarr or Radarr`). Several files of one series finishing within about 5 seconds share one rescan. The step is optional: a failure is a warning, the job stays **done**.

### Seerr

Nodes: **Request (Seerr)** (`seerr:request`, a data node) and **Was requested (Seerr)** (`seerr:is-requested`, a condition). Works with Jellyseerr and Overseerr, which share one API.

| Setting | What it is |
| --- | --- |
| URL | For example `http://jellyseerr:5055`. |
| API key | Settings → General. A secret; sent in the `X-Api-Key` header only. |
| Accept a self-signed certificate | As above. |

There are no path mappings: Seerr does not know files, so the nodes look titles up by id or by name. Both nodes have optional inputs `ids` (connect the `ids` output of a Sonarr, Radarr or TMDB node) and `title`, and a setting **kind** (`auto`, `movie`, `tv`). With a TMDB id Seerr is asked directly (Sonarr's ids mean a show, a bare TMDB id with `auto` means a movie, checked against the title when one is connected). Without one the title is searched (`Example Movie (2001)` also uses the year) and exactly one match is needed. Seerr has no TVDB lookup, so a TVDB id alone needs a title as well.

**Request (Seerr)** outputs `requested` (yes or no), `requestedBy` and `requestedAt` (the earliest request that was not declined). Not requested gives `requested` no and both texts empty; when Seerr cannot tell (no ids or title, no match, several matches, an unknown id, Seerr unreachable) all three are `unknown` and the reason says why, never a guess. **Was requested (Seerr)** branches on the same answer: **Yes** when requested, **No** when not, and the setting **whenUnknown** (default `no`) decides where unknown goes.

**Email addresses are never shown.** A Seerr user without a user name has their email address as display name. Such a name is replaced by `user #<id>` (`Example Movie: requested by user #3 on 2026-09-01`), so an address never reaches a job's trace, a notification or the API.

**No "notify the requester" node.** Seerr's API cannot send a message to a chosen user. The only thing a client can write that users see is an issue (or an issue comment), which opens a problem report in Seerr and notifies the admins: not a clean "your title was optimised" message. Use ntfy or Discord to tell people instead.

## The Keep my languages example with plugins

`examples/workflows/keep-my-languages-plugins.json` is the **Keep my languages** workflow from [`examples/workflows/`](../examples/workflows/README.md) with a language lookup in front and three finish steps after the write. Node by node:

1. **Manual input** starts a run on the files you choose.
2. **Original language (Sonarr)** looks the file up in Sonarr and sends the series' original language to the language input of the next node.
3. **Keep languages** keeps the languages of the shared value **Languages** (English as shipped; change it on the Shared values card) plus untagged tracks and, because the original language is connected, the original one too. **Remove duplicate audio** drops identical audio tracks.
4. **Set default track**, **Reorder tracks** and **Cover and attachments** follow the same **Languages** value: your first language becomes the default and leads the order, and the cover stays.
5. **Replace original** writes the file. Nothing is changed in the library before this point.
6. **Rescan in Sonarr** (timeout 240 s) tells Sonarr the file changed and checks that Sonarr lists it.
7. **Refresh in Jellyfin** (scope `file`) tells Jellyfin.
8. **Notify (ntfy)** sends a push to the topic `transcoda-CHANGE-ME`; change it to your own (see below).

The three finish nodes all hang off Replace original. The order they run in is fixed by their phases, not by the lines: *library manager* (Sonarr, Radarr, Bazarr) before *media server* (Jellyfin) before *notify* (ntfy, Discord), all after the write. That order is deliberate: the library manager learns about the new file first, the media server is asked next, and the notification goes last so it can report what the earlier steps found (a later step sees the earlier steps' problems, exactly as if they were chained). Finish steps always run after the write, in phase order. Two steps of the same phase on one output run left to right as placed on the canvas, top to bottom when they share a column; a step wired behind another always runs after it.

Only finish steps can share an output. A file follows one path, so an output wired to two actions or conditions (or to an action and a finish step) is an error when you save (`OUTPUT_MULTIPLE_EDGES`, "only finish steps can share an output"), and the editor draws the offending lines broken. Two more rules apply to a shared output: the **Size gate** must be the only step on its output (`SIZE_GATE_SHARED_OUTPUT`; put the other steps after its Yes or No, because it decides only for the steps wired after it), and only one step that writes the result (Replace original or Move or copy) can be on it (`OUTPUT_MULTIPLE_WRITES`). Data outputs, such as Sonarr's original language, can feed any number of nodes.

To use it, install and configure Sonarr, Jellyfin and ntfy, create a workflow, save this file as its graph, set the Sonarr and ntfy values to yours, try a dry run, then activate it. With Jellyfin seeing `/shows` and Sonarr and Transcoda seeing `/data/shows`, the path mappings need no changes for that layout.

## Subtitles from Bazarr into the file

Bazarr downloads subtitles as files next to the video (`Example Show S01E03.de.srt`). Some players and media servers miss them, and moving or renaming the video leaves them behind. This chain puts them into the video as tracks and tidies up afterwards:

*Library input → Get subtitles now (Bazarr) → Embed subtitle files → Replace original → Rescan in Sonarr → Rescan in Bazarr → Refresh in Jellyfin*

1. **Get subtitles now (Bazarr)** asks Bazarr for the languages the file lacks and waits up to 25 seconds (see [Bazarr](#bazarr)). Optional: without it the chain embeds whatever Bazarr already downloaded.
2. **Embed subtitle files** (`core:embed-sidecar-subtitles`, a core node) finds the `.srt`, `.ass`, `.ssa`, `.vtt` and `.sup` files whose names start with the video's name and adds each as a subtitle track. The parts of the name between the video's name and the extension set the track: a language code (`de`, `deu`, `ger`, `pt-BR`), `forced`, `sdh` or `cc` (for the hearing impaired), `default`; `hi` after a language means hearing impaired, alone it is Hindi; anything else becomes the track title. When two videos share a prefix (`Example Show S01E03.mkv` and `Example Show S01E03.Part2.mkv`), a file belongs to the video with the longest matching name. Files that would break the encode or are not the video's are skipped with the reason in the trace: empty, over 8 MiB, text that is not UTF-8 (or UTF-16 with a byte-order mark), a symbolic link, a file outside the video's folder, or two languages in one name. Settings: **languages** (empty: all), **skipExisting** (default on: a file whose language, forced and SDH flags match a track the video already has is skipped, so a second run ends **nothing to do**) and **afterEmbed** (below). The dry-run plan lists each subtitle file with what will happen to it.
3. **Replace original** writes the file. Nothing in the library changes before this point.
4. **afterEmbed: recycle** (the default) moves each subtitle file that is now a track in the new file into the library's recycle folder, in the same layout as the recycled original, right after the replace; it is kept there as long as originals are (see [`env.md`](env.md#settings-in-the-database)) and never deleted by the job. A file that was planned but did not end up in the output (see mp4 below), or one that was skipped, stays where it is. With **keep** every subtitle file stays next to the video.
5. **Rescan in Sonarr** (or Radarr) tells the library manager about the new file, **Rescan in Bazarr** makes Bazarr look at the subtitles again, and **Refresh in Jellyfin** tells the media server. All three hang off Replace original and run in phase order (see [the Keep my languages example](#the-keep-my-languages-example-with-plugins)). Sonarr and Bazarr are both *library manager* steps, so between them their place on the canvas decides: place Rescan in Sonarr (or Radarr) left of Rescan in Bazarr, or above it when they are in the same column, because Bazarr learns a changed path from Sonarr or Radarr.

After the rescan Bazarr lists the languages as embedded instead of as files, provided its setting to use embedded subtitles is on (Bazarr → Settings → Subtitles); with it off, Bazarr may count the recycled languages as missing and download them again.

**mp4 cannot carry `.sup`.** mkv takes every format as it is. In an mp4 text subtitles are converted to `mov_text`, and image subtitles (`.sup`, PGS) are not possible: the embed node skips them with `mp4 cannot hold PGS (.sup) subtitles`. If **Remux** to mp4 comes after the embed node, the plan lists the `.sup` track as dropped. Either way the `.sup` file is not recycled. Use mkv when you want PGS subtitles in the file.

**Running the chain again.** **Get subtitles now** treats a language the video already holds as a track (with the same forced and SDH flags) as present, so a re-run on a file whose subtitles were embedded asks Bazarr for nothing.

## When the size gate keeps the original

The **Size gate** asks "Saved at least n%?" and has two outputs. **Yes**: the result saves at least the minimum, and the finish steps wired to it run as usual (Replace original, then notifications). **No**: the result does not save enough, so the original is kept, the job ends **kept original**, and only the finish steps wired to **No** run. Only steps that write nothing may follow No (notifications, Sonarr, Radarr, Jellyfin and other plugin finish steps); Replace original and Move or copy cannot, and the editor says so. Several steps can hang off No (or Yes) at once; they run in phase order, like the steps after Replace original. Steps wired only to Yes are skipped on No and the other way round. The job's Decisions list says which branch was taken ("No, kept original: saved 2.9%, below 20%") and dims the other; a dry run cannot know and shows both as possible. Every two-way condition reads the same way: **Yes** and **No** on the node, "Yes: video is hevc" in the Decisions list. Under the names the stored port ids are still `pass` and `else`, so saved workflows, the API and plugin manifests are unchanged.

Example: wire **Notify (ntfy)** to the gate's No output with the title `Kept original`, and a second one to Replace original as before. A file the gate refuses then sends a push saying how little it saved. A plugin step on No gets `outcome: 'kept'` and `gate: { savedPercent, minSavingPercent }` in its context; `afterBytes` is the size of the result that was thrown away. Workflows saved before this change keep working: their gate's single output became **Yes** (`pass`).

## If a step fails

A finish step runs after the file is replaced, so a failure never undoes the replacement and never loses the file. What the job shows depends on whether the step is required:

- **Required** steps (the Sonarr and Radarr rescans) turn a failure into a **problem**: the job ends **done**, the Jobs page counts it under **Needs attention**, and the job page shows "Finished with a problem" with the step's own text, for example `Sonarr does not know /data/shows/Show/S01E01.mkv; nothing was rescanned`.
- **Optional** steps (Jellyfin, Bazarr, ntfy, Discord) record a warning on the job and the job stays plainly done.
- A required step (Sonarr, Radarr) that fails in a way that may pass on a second try (a timeout, a server error, the service unreachable) is retried once after 10 seconds before it counts as a problem. Optional steps (Jellyfin, Bazarr, ntfy, Discord) are not retried.

To fix it, read the text, correct the cause (the API key, a path mapping, a service that was down), use **Test connection** on the Plugins page, and run the file again. To repeat only a failed rescan, use the **Rescan** action in Sonarr or Radarr itself. Plugin crashes are visible on the Plugins page (`restarting in 12 s`, `stopped: …`), and the nodes of a plugin that is not running are marked in the editor.
