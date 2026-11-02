# Changelog

All notable changes to Transcoda, newest first. Generated from the notes in `.changes/` when a release is cut.

## 0.3.0 — 2026-11-02

### New

- The new Already processed step checks whether a file has already been through a workflow, this one or another, in any version or a specific one. It recognises the files Transcoda wrote, even after they replaced the original, and also identical copies of a file, for example one that was moved to another drive or downloaded again. Transcoda writes its files exactly as before; nothing is added to them.
- Transcoda tells you when a new version is out: Settings gets a badge in the menu, and Settings → About shows what the new version brings and the command to update. It checks GitHub every 6 hours and never updates on its own; set `TRANSCODA_UPDATE_CHECK=false` to turn the check off.
- Damaged downloads can now be handled in the workflow. Every workflow gets a Render step; turn on its Quality check and a file whose source turns out to be damaged takes a new Damaged output instead of failing, where Sonarr or Radarr can replace it. The new Check source step reads a file once and sends damaged files the same way before any time is spent encoding.
- The Jobs page has a Cancel all button next to Pause queue. After you confirm, it cancels every queued, running and paused job, in the chosen library or in all of them. Running encodes stop and their partial output is deleted, so their originals stay untouched. Jobs already replacing their file finish.
- Libraries now watch their folder, so a new video is queued as soon as it has finished copying instead of at the next 15-minute check. You can turn this off per library under Advanced. A network share (NFS or SMB) that another machine writes to sends no notice of new files, so those libraries still rely on the 15-minute check.
- Transcoda now checks for plugin updates in the background and shows how many are waiting next to Plugins in the menu. An update that doesn't affect any workflow installs with one click, and the Updates tab has an Update all button.

### Improved

- In the editor, a step with more than one file output, such as Check source with OK and Damaged, now names each output instead of showing "file" twice. The search for adding a step shows a short description under each step and marks the text you typed.
- An encode that stops writing output is now stopped after an hour instead of running on and using more and more memory. If it never wrote anything, the job fails with a reason that explains why; if it stopped partway (for example a network share that hung), the job is tried again, on another GPU or in software when the GPU was encoding. Slow encodes keep writing output and are not affected; the limit can be changed or turned off with `TRANSCODA_ENCODE_STALL_MINUTES`.
- Every Docker image now comes with a signed record of how it was built and a list of its packages, so you can check that it really came from the Transcoda repository: `gh attestation verify oci://ghcr.io/transcoda/transcoda:latest --repo transcoda/transcoda`. Release pages carry both as files too.
- Testing a Radarr or Sonarr connection now warns when one of its root folders isn't inside any of your libraries, and suggests the path mapping to add, so lookups that would fail show up at setup.
- A step can now be reached from several branches: connect more than one line into its file input, for example one Replace damaged file step after both Damaged outputs, instead of adding the step once per branch. Saved workflows that showed an error for a file input with several connections are now valid.
- The Plugins page matches the rest of Transcoda: the same status chips and headings, and empty tabs and a blocked count of 0 are left out.
- Pages look and read more alike: one chip style where "Kept original" and other no-change outcomes are a quiet grey outline, one heading style, plain stat tiles, and dates like "8 min ago" or "Oct 25". The Jobs page fits the list above the fold, with the 7-day charts and the encoder's last hour side by side and the queue controls in the header; every row opens its job with one click. A run's page leads with what it saved and lists its files without the extra columns, as cards on a phone. The job page shows the result right under the header: what changed, or why the file failed or was left alone, in plain words, with the raw command and log one click away. Empty sections are gone. The workflow editor's top bar is calmer: Save is the one lime button, and Run on a file, Activate and Save with a note live in the ⋯ menu. The version pill says whether that version is active, and the right panel shows only the issues list until you select a node. New workflow shows the chosen kind with a lime outline and puts Create on the right. Libraries keep the path on one line, show recycle and hardlink settings only when changed, and show each library's workflow with the same Active pill as the Workflows page. Settings show one heading and only the values you've changed, with server-set values tucked away. Sign in names the server once.
- The Workflows list is easier to scan: active workflows come first, each row shows which library it processes, and a warning appears next to the name only when a workflow has errors, can't run or uses an outdated sub-workflow. A newer version that isn't active yet shows as "v3 not activated", which you can click to activate it.

### Fixed

- A cover image stored as a video track (for example one an earlier conversion turned from an attachment into a one-frame video) is now copied instead of encoded. Encoding it held back the whole output, so a job could run for hours with an empty output file while ffmpeg used more and more memory. Turning off "Keep cover images" now removes all cover images and poster tracks: these image tracks, and also plain JPEG or PNG poster tracks next to the video, which it used to keep.
- Decode errors in a file's DTS audio are now recognised as a damaged source, so the original is kept and the job says why, instead of failing with raw ffmpeg output.
- Libraries now pick up new videos on their own: a minute after Transcoda starts and then every 15 minutes, each library with an active workflow queues the files it hasn't seen yet, so you no longer need to press Scan now. Files still being copied wait for the next check, and files Transcoda already processed are never queued again. The first check after updating also queues the files in a library that was never scanned, except files you already ran a dry run on; Scan now queues those.
- A scan no longer queues the files Transcoda itself wrote. A file a workflow already replaced is now marked Already processed for that workflow version, like the original was, instead of being queued and checked again. Run with force to process it anyway.

## 0.2.1 — 2026-10-29

### Fixed

- After an update, the browser now loads the new version of Transcoda right away instead of sometimes running the previous one from its cache until a hard reload.
- Security fixes in two libraries the server uses to read requests (body-parser and fast-uri).

## 0.2.0 — 2026-10-26

### New

- Transcoda can now encode on Intel Arc and other Intel GPUs with Quick Sync next to NVIDIA ones. Set the order in Settings → Queue: a job goes to the first free GPU, so the second card only works when the first is busy.

## 0.1.0 — 2026-10-25

### New

- The first release of Transcoda: build ffmpeg workflows in a visual editor, try them on one file with a dry run that writes nothing, then let them work through your library. Every result is checked before it replaces an original, and the original goes to a recycle folder.
- Three ready-made examples to start from: Save space, Play everywhere and Keep my languages. Each opens with a note that says what it does and what to change, and shared values let one list of languages feed every node that needs it.
- The Jobs page shows what is running, how much space you have saved, the last 7 days and a live graph of the encoder. Each job's page compares the file before and after and draws the path it took through the workflow.
- NVIDIA, Intel and AMD encoders are found and used automatically, with one CPU retry if a GPU encode fails. Settings → Queue and engine picks the encoding device; with several NVIDIA GPUs each one encodes a job of its own.
- Official plugins for Sonarr, Radarr, Jellyfin, Bazarr, Seerr, TMDB, ntfy and Discord install from the Plugins page. They are signed and each runs in its own sandbox. Plugin authors can install the SDK from npm as `@transcoda/sdk`.
- Scan a library in one click, let the queue run only in the hours you choose, or start a workflow from a webhook. A REST API and an MCP server let scripts and AI assistants check jobs and build workflows; activating a workflow always stays with a person.
- Transcoda has numbered releases. The Docker image is tagged `latest`, `0.1` and `0.1.0`; `main` is the newest unreleased build.
