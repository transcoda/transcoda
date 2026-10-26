# Copy run: proving the engine on copies, with NVENC

This is the playbook for the M1 gate. You run the engine against **copies** of your media on the home server, with the GPU, and check that nothing is lost.

The M1 engine has no job screens (they arrive with the M2 editor track), so everything here goes through the REST API under `/api/v1`: the libraries, jobs, runs, queue and events routes. `GET /api/openapi.json` on your server describes every route and field.

## 1. Purpose

- Prove the engine on 20 copies of real files: a dry run first, then a real run, with the originals of the *copies* kept intact and a second run that does nothing. Then keep running copies until 500 files have gone through without a single loss.
- Use the real GPU path: NVENC H.264/HEVC on your GPU. AV1 targets are out of scope here.
- FileFlows keeps running on the real library the whole time. Transcoda never sees the real library, only the copy folder.

Never point a Transcoda library at the real media. Everything below uses the copy folder.

## 2. Prepare

### Make the copies

Pick about 20 files that cover your mix (H.264 and HEVC, several audio and subtitle tracks, an `.mp4` or two, one with a cover image, one you know is already small). Copy them with `rsync` into a dedicated folder with room to spare (the engine needs the output size plus 5 GiB free on that filesystem). The folder must be owned by the user the container runs as.

```sh
# Replace SRC with the folder that holds the files you picked (read-only use).
SRC=/path/to/your/library
DEST=/mnt/copyrun/media

sudo mkdir -p "$DEST"
rsync -a --info=progress2 --files-from=picked.txt "$SRC"/ "$DEST"/
sudo chown -R 1000:1000 "$DEST"        # PUID:PGID of the container
find "$DEST" -type f | wc -l            # expect 20
```

`picked.txt` is one path per line, relative to `SRC`. `rsync -a` keeps modification times; the engine will not touch a file modified in the last three minutes, so wait that long after copying before you queue anything.

Keep a checksum list of the copies. You will compare against it after the real run:

```sh
cd "$DEST" && find . -type f -print0 | sort -z | xargs -0 sha256sum > /mnt/copyrun/before.sha256
```

Also keep a second pristine set of the same 20 files somewhere else (for example `/mnt/copyrun/pristine`). The engine keeps its own originals in the recycle folder, but a copy the engine never saw is the check that does not trust the engine.

### Temp space

The engine writes the encoded output into `/transcode/<job id>/` and only then replaces the file. Put it on the SSD: `/mnt/ssd/transcode`.

### Compose file

Recycled originals stay on the library's own filesystem (`.transcoda-recycle` inside the library root, see section 6), so no extra mount is needed.

```yaml
services:
  transcoda:
    image: ghcr.io/transcoda/transcoda:main
    ports:
      - "8080:8080"
    environment:
      PUID: "1000"
      PGID: "1000"
      NVIDIA_DRIVER_CAPABILITIES: "video,compute,utility"
      NVIDIA_VISIBLE_DEVICES: "all"
      # TRANSCODA_OUTPUT_ROOTS is left unset on purpose: no move-copy output,
      # every example replaces in place.
    volumes:
      - ./config:/config
      - /mnt/ssd/transcode:/transcode
      - /mnt/copyrun/media:/media
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    restart: unless-stopped
```

With plain `docker run` the equivalent of the `deploy` block is `--gpus all`. The NVIDIA Container Toolkit must be installed on the host.

Library paths in API calls are paths **inside the container**: `/media`.

### Check the GPU is seen

Create the admin account in the browser (`http://<host>:8080`), then create an API token on the Tokens page with scopes `read`, `plan`, `jobs:create`, `jobs:manage` and `workflows:write`. It is shown once. Use it from a shell:

```sh
export TCD=http://<host>:8080
export TOKEN=tcd_...                    # the token you just created
tcd() { curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }

tcd $TCD/api/v1/system/capabilities | jq '{encoders: [.encoders[]? | select(test("nvenc"))], hwaccels}'
```

The output must list `h264_nvenc` and `hevc_nvenc` among the encoders and `cuda` among the hwaccels. If either is missing, stop: `encoder: auto` would silently fall back to the CPU encoder (`libx265`), which is not what you are testing. Check `nvidia-smi` inside the container (`docker compose exec transcoda nvidia-smi`) and the toolkit setup.

When ffmpeg could not be probed at all, the answer has `"available": false` and an `error` instead of the lists; fix that first.

### Check the Matroska muxer keeps default flags as given

The engine sets exactly one default audio track (and, for mp4, one default subtitle) before it writes a file, and verify compares the output's flags with that plan. That relies on the image's ffmpeg writing Matroska flags as given:

```sh
docker compose exec transcoda sh -c '"${TRANSCODA_FFMPEG_PATH:-ffmpeg}" -hide_banner -h muxer=matroska' | grep -A4 default_mode
```

The `default_mode` line must say `(default passthrough)`. If it says `infer` or `infer_no_subs`, stop and report it: files without a default subtitle would then fail verify on every attempt.

## 3. Import the example workflows

The three example graphs are in [`examples/workflows/`](../examples/workflows/) (see its README for what each does and which warnings are expected). Their encoders stay on `auto`: with the GPU present, `auto` resolves to `hevc_nvenc` (HEVC) or `h264_nvenc`; it prefers hardware, then falls back to `libx265`/`libx264`.

Create, save and activate each one. The `save` call needs the version you are building on (a new workflow is at version 1):

```sh
for f in save-space play-everywhere keep-my-languages; do
  id=$(tcd -X POST $TCD/api/v1/workflows -d "{\"name\":\"$f\",\"kind\":\"workflow\"}" | jq -r .id)
  jq -c --arg id "$id" '{id: $id, baseVersion: 1, graph: .}' examples/workflows/$f.json \
    | tcd -X PUT $TCD/api/v1/workflows/$id -d @- | jq '{version, valid, issues}'
  echo "$f = $id"
done
```

Each file is a plain workflow graph, passed as `graph` unchanged. Write down the three ids.

Read the `issues` of each save. Warnings the README calls out (for example `NO_WRITE_PATH` on the "already HEVC" branch) are expected; **errors are not**. A workflow with errors cannot be activated or run; fix it first.

A new workflow has no active version: every real request runs as a dry run of its newest version until a version is activated in the UI (activation is a session action; API tokens cannot do it). Start with one workflow (Save space is the main one) and add the others later.

## 4. Run

### Create the library

```sh
LIB=$(tcd -X POST $TCD/api/v1/libraries -d '{
  "name": "copyrun",
  "path": "/media",
  "recycleFolder": ".transcoda-recycle",
  "verifyFullDecode": true
}' | jq -r .id)
```

A library has no workflow setting. A workflow takes files from a library through its Library input: to have "Scan now" and requests without a `workflowId` use Save space, replace its first node with a Library input (`core:input-library`) whose `libraryId` is `$LIB`, save, and activate that version in the UI. Only one active workflow can feed a library; the requests below name the workflow, so this step is optional for the copy run.

`path` must exist and be a directory inside the container; a path that overlaps another library is refused. The recycle folder is set on the library: `.transcoda-recycle` (relative, so `/media/.transcoda-recycle`) is also what you get when you leave it out, and recycling cannot be switched off. Two more library options matter for this run:

- `verifyFullDecode: true` (set above) decodes the whole output before replacing it, instead of the start, the end and ten sampled spots: slower, and the strictest check for the copy run.
- `processHardlinked` stays off: hardlinked files are skipped (replacing one would break the link).

### Dry run first

```sh
RUN=$(tcd -X POST $TCD/api/v1/jobs -d '{"path":"/media","workflowId":"<id>","dryRun":true}' | jq -r .runId)
```

A folder path queues every media file under it (`.mkv .mp4 .m4v .mov .avi .ts .m2ts .webm .wmv .flv`). A dry run writes nothing (not even temp files). For each file it records the plan, the exact ffmpeg command and an estimated size. Read the run and then a few jobs:

```sh
tcd $TCD/api/v1/runs/$RUN | jq '{counts, files: [.files[] | {fileName, state, reason}]}'
tcd $TCD/api/v1/jobs/<job id> | jq '{state, reason, plan, result: {command: .result.command, estimatedBytes: .result.estimatedBytes}, trace}'
```

Check that:

- the files you expect to shrink are `dry_run` with a command that contains `hevc_nvenc`;
- files that are already HEVC (Save space) are `nothing_to_do` when they are mkv or mp4, and `kept_original` with the reason `path never writes the result` in any other container (ts, avi, …: they would need a remux, and the "already HEVC" path writes nothing);
- every job has a reason you understand; the `trace` shows each node, its decision and why.

Then verify the dry run touched nothing:

```sh
cd /mnt/copyrun/media && find . -type f -print0 | sort -z | xargs -0 sha256sum | diff - /mnt/copyrun/before.sha256 && echo untouched
ls -a /mnt/copyrun/media | grep transcoda    # expect nothing
```

### Activate the version

Only now, with the dry run checked, activate the version in the UI (Workflows → the workflow → Activate vN; a version with errors is refused), then check with:

```sh
tcd $TCD/api/v1/workflows/$id | jq '{name, active, valid}'
```

`active.version` must be the version you checked and `active.runnable` true; otherwise the real run below is a dry run again (`note: "no active version"`) or refused.

### Real run

```sh
RUN=$(tcd -X POST $TCD/api/v1/jobs -d '{"path":"/media","workflowId":"<id>"}' | jq -r .runId)
```

You can watch it live. `GET /api/v1/events` is a stream of server-sent events: first a `queue.changed` snapshot (queue paused or not, the job in each lane), then `job.changed` (state, paused, progress, lane, the node the job is at and its reason, which says what a running job waits for, e.g. `waiting for 5.4 GB free on /media (5.1 GB free)`), `job.trace` (each node's decision as it is made), `run.changed`, `queue.changed`, a `ping` every 30 s, and `resync` when the stream fell behind and dropped events (refetch the run then):

```sh
curl -sN -H "Authorization: Bearer $TOKEN" -H "Accept: text/event-stream" $TCD/api/v1/events
```

and poll the summary until `in_progress` is 0:

```sh
watch -n 10 "curl -sS -H 'Authorization: Bearer $TOKEN' $TCD/api/v1/runs/$RUN | jq .counts"
```

How the engine behaves, so nothing surprises you:

- Two lanes: one `encode` job (a video conversion, on the GPU) and one `quick` job (remux, track changes) run at the same time; everything else waits in the queue.
- Pause a job or the whole queue with `POST /api/v1/jobs/{id}/pause` / `resume` and `POST /api/v1/queue/pause` / `resume`; `POST /api/v1/jobs/{id}/cancel` stops one. A paused job frees its lane. The queue pause survives a restart.
- Before a file is replaced the output is verified: ffmpeg's own error lines and frame count while encoding, then a probe of every stream, per-stream end times, decode of the start, the end and ten sampled spots (the whole file when the library has `verifyFullDecode`), and any device targets. A file that fails is not replaced and the failure reason is on the job. A source that itself has decode errors ends `kept_original` and is never retried; other failures are retried once.
- The replace is crash-safe: the original is moved to the recycle folder, the new file is installed beside it and renamed into place, with every step journaled. If the server stops mid-way, the startup sweep finishes or undoes it from what is on disk. A running job interrupted by a restart is requeued once.
- The size gate in the examples keeps the original when the saving is too small (its **No** output, port id `else`, which the examples leave unconnected, can notify you).

If you want to test a crash: stop the container during a job (`docker stop`), start it again, and check the job ends `done` or is requeued and finishes, with the original or its replacement in place and no `.transcoda-*.tmp` files left.

## 5. Check

Do all of these before you count the run.

1. **The summary reconciles.**
   ```sh
   tcd $TCD/api/v1/runs/$RUN | jq '.counts'
   ```
   `total` equals the sum of `done`, `nothing_to_do`, `kept_original`, `failed`, `cancelled`, `dry_run`, `skipped`, `already_processed` and `in_progress`, and `total` equals the number of media files in the folder. `failed` should be 0. If it is not, read each failed job's `reason` and log (`GET /api/v1/jobs/{id}/log`) and keep the run result: a failure with the original intact is fine for the gate; a lost or damaged file is not.
2. **Originals are intact.** Replaced files have their originals in `/mnt/copyrun/media/.transcoda-recycle/` (same relative path). Compare those with the pristine set:
   ```sh
   cd /mnt/copyrun/pristine && find . -type f -print0 | sort -z | xargs -0 sha256sum > /tmp/pristine.sha256
   cd /mnt/copyrun/media/.transcoda-recycle && sha256sum -c /tmp/pristine.sha256 --ignore-missing
   ```
   Every recycled file must say `OK`. Files the engine did not change (`nothing_to_do`, `kept_original`, `skipped`) must still match `before.sha256` in the media folder itself.
3. **Nothing stray is left.** No `.transcoda-*.tmp` or `*.transcoda-*.orig` files under `/mnt/copyrun/media`, and `/mnt/ssd/transcode` is empty once the run is over.
4. **Replaced files play.** Add `/mnt/copyrun/media` as a throwaway library in Jellyfin (or open the files in your player) and spot-check a few replaced files: video and audio play, the right audio and subtitle tracks are listed and the default is right, and seeking works. Remove the throwaway library afterwards.
5. **Ownership and times.** Replaced files belong to `PUID:PGID` and keep the original's permissions and modification time (`ls -l`, `stat`).
6. **A second run does nothing.** Queue the same folder again with the same workflow:
   ```sh
   RUN2=$(tcd -X POST $TCD/api/v1/jobs -d '{"path":"/media","workflowId":"<id>"}' | jq -r .runId)
   tcd $TCD/api/v1/runs/$RUN2 | jq .counts
   ```
   Poll until `in_progress` is 0. No job may be `done`. A file replaced in the first run is a new file (new fingerprint), so it is walked again; it is HEVC now and ends `nothing_to_do` when it is mkv or mp4, or `kept_original` with `path never writes the result` in another container. A file the first run left alone (`nothing_to_do`, `kept_original` or `failed`) keeps its fingerprint and is `already_processed` (`force: true` queues it again). `already_processed` is not "processed successfully": a file that `failed` in the first run shows up here too (its `reason` says `already failed on <date>`), so compare with the first run's `failed` list rather than counting it as done. Recycled originals are inside the library root but are never queued.
7. **Dry runs over copies** of the other workflows behave the same way (a dry run never counts as "already processed").

The recycle folder keeps originals for 7 days, and also stops short of using more than 25 % of the free space of its filesystem (oldest originals are removed first). Those are database settings (`recycle.retentionDays`, `recycle.maxFreePercent`, see [`env.md`](env.md#settings-in-the-database)); change them under Settings → Recycle.

## 6. Roll back

Originals of replaced files are kept in the recycle folder, in the same relative layout as the library: `<library root>/.transcoda-recycle/<relative path>`. (A library can set another recycle folder; a relative one is resolved under the root. If a name was taken, a `.1`, `.2` suffix is appended.)

To put one back, move it over the replaced file (same filesystem, so it is instant):

```sh
cd /mnt/copyrun/media
mv -f ".transcoda-recycle/Shows/Example/episode.mkv" "Shows/Example/episode.mkv"
```

A restored file keeps the fingerprint it had before the run (`mv` keeps its inode, size and mtime), so the next run over that folder leaves it alone: it ends `already_processed` with `already done on <date>; this file is the original from before then (moved back from the recycle folder?); run with force to process it again`. Queue it with `force: true` to process it again; its earlier recycle entry is then replaced by the new one. To undo a whole run, restore every file listed under `done` in `GET /api/v1/runs/{id}`.

If a job reports `failed: replace left two copies` or `original missing`, nothing was deleted: the original is at the path named in the reason. Move it back by hand.

## 7. Record

Keep a ledger (a text file or spreadsheet, outside the repo) with one line per run:

| Date | Workflow | Run id | Files | done | nothing_to_do | kept_original | failed | skipped | Bytes before | Bytes after | Originals verified | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

Paste the `counts` and byte totals from `GET /api/v1/runs/{id}`. The 500-file target accrues across runs: add up the files each real run processed (`done` + `nothing_to_do` + `kept_original`), refresh the copies between runs so a file is not counted twice, and stop and report the moment a single file is lost or damaged.

The M1 gate is met when a dry run and a real run over the 20 copies finish with the numbers above, the originals match, and the second run does nothing.
