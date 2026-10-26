# Changelog

All notable changes to Transcoda, newest first. Generated from the notes in `.changes/` when a release is cut.

## 0.1.0 — 2026-10-25

### New

- The first release of Transcoda: build ffmpeg workflows in a visual editor, try them on one file with a dry run that writes nothing, then let them work through your library. Every result is checked before it replaces an original, and the original goes to a recycle folder.
- Three ready-made examples to start from: Save space, Play everywhere and Keep my languages. Each opens with a note that says what it does and what to change, and shared values let one list of languages feed every node that needs it.
- The Jobs page shows what is running, how much space you have saved, the last 7 days and a live graph of the encoder. Each job's page compares the file before and after and draws the path it took through the workflow.
- NVIDIA, Intel and AMD encoders are found and used automatically, with one CPU retry if a GPU encode fails. Settings → Queue and engine picks the encoding device; with several NVIDIA GPUs each one encodes a job of its own.
- Official plugins for Sonarr, Radarr, Jellyfin, Bazarr, Seerr, TMDB, ntfy and Discord install from the Plugins page. They are signed and each runs in its own sandbox. Plugin authors can install the SDK from npm as `@transcoda/sdk`.
- Scan a library in one click, let the queue run only in the hours you choose, or start a workflow from a webhook. A REST API and an MCP server let scripts and AI assistants check jobs and build workflows; activating a workflow always stays with a person.
- Transcoda has numbered releases. The Docker image is tagged `latest`, `0.1` and `0.1.0`; `main` is the newest unreleased build.
