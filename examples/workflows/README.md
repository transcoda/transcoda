# Example workflows

Three ready-made workflows for a new library, plus one that adds plugins (`WorkflowGraph`, format
version 1). Each starts at `core:input-manual`, ends at `core:replace-original` and opens with a
**Start here** note that says what it does and what to change. Video encoders are `auto`, which
picks a hardware encoder when the server has one (`hevc_nvenc` or `h264_nvenc` on an NVIDIA box)
and `libx265` or `libx264` otherwise. Create a workflow from one in the Workflows page's
**Examples** menu (or save the file as a workflow's graph), try it with a dry run, then activate
the version.

`apps/server/src/engine/examples.test.ts` runs the three core examples over the test fixtures
(`pnpm fixtures`) with real ffmpeg: a first run, the same folder again (every job must be
`nothing_to_do` or `already_processed`), and a dry run over fresh copies (nothing on disk changes).

| File | What it does |
| --- | --- |
| `save-space.json` | **Save space.** Already HEVC → nothing. Otherwise: video → HEVC (`auto`, CRF 23, `medium`), audio copied, kept only when at least 15 % smaller, then replaces the original. |
| `play-everywhere.json` | **Play everywhere.** Video is encoded to H.264 (CRF 22) only when it does not play on every device in the shared value **Devices**; audio is copied, with a stereo AAC default added when the default track cannot play there. Ships with `android-tv`; adding `chrome` re-encodes HEVC to H.264 too, because browsers can't play HEVC everywhere. No size gate: a fix may grow the file and must still replace it. |
| `keep-my-languages.json` | **Keep my languages.** Keeps the languages in the shared value **Languages** (`en` as shipped) plus the original language and untagged tracks, removes duplicate audio, makes the first language the default audio and subtitle and orders tracks by **Languages**, keeps the cover, drops attachments (fonts stay while ASS subtitles need them), then replaces the original. No re-encoding. |
| `keep-my-languages-plugins.json` | **Keep my languages with plugins.** The above, plus **Original language (Sonarr)** feeding Keep languages, and after the write **Rescan in Sonarr**, **Refresh in Jellyfin** and **Notify (ntfy)** (topic `transcoda-CHANGE-ME`: change it to a private one). Needs the Sonarr, Jellyfin and ntfy plugins installed and configured; walked through in [`docs/plugins.md`](../../docs/plugins.md). Not run by `examples.test.ts` (core has no plugin bundles); `apps/server/src/workflows/examples-plugins.test.ts` validates it against stub node definitions. |

## Notes and shared values

- **Notes** are frames (`groups`) with a Markdown `note`. A frame with no nodes in it is a sticky
  note; the editor adds one from the palette's **Note** item.
- **Shared values** (`values.entries`) are named values that node settings follow through the
  node's `links` (setting key → value name). Every setting keeps a copy of its value, so the engine
  never looks at `values`; the editor and the server's save copy each value into the settings that
  follow it. A link to a value that does not exist is the warning `VALUE_MISSING`.

## Notes on the graphs

- **Open Yes port (Save space).** The `Already HEVC?` condition's **Yes** output (port id `pass`) is
  deliberately left unconnected: an HEVC file ends its walk there with no finish action. For mkv
  and mp4 inputs that is `nothing_to_do`; for other containers (ts, avi, …) the engine would have
  to remux, which this path never writes, so those end `kept_original: path never writes the
  result`. Validation reports the expected warning `NO_WRITE_PATH` on that node ("output "Yes" is
  unconnected"), and a note on the canvas says why.
- **Second runs.** A replaced file is a new file (new inode, size and mtime), so it is walked again
  and must come out `nothing_to_do`; a file the first run left untouched keeps its fingerprint and
  is `already_processed`.
- **Default tracks.** Before a changed file is written, the engine leaves exactly one default audio
  track (the first flagged one, else the first audio track) and, for mp4, one default subtitle
  (mp4 cannot have none). So Save space also fixes a file with no or two default audio tracks.
