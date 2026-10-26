# Test media fixtures

`generate.mjs` builds tiny (3 s, 320×180 — `h264-big.mkv` 640×360 — `testsrc2` + `sine`)
media files for the engine tests into `.local/fixtures/` (git-ignored — never commit media),
verifies each with `ffprobe` and writes `.local/fixtures/manifest.json` with what it found.

```sh
pnpm fixtures                      # generate all, verify, write manifest
pnpm fixtures tigger-pooh compliant  # regenerate only these (other manifest entries are kept)
pnpm fixtures --check              # verify existing files only; exit 1 on mismatch or missing file
```

Needs `ffmpeg` and `ffprobe` on `PATH` (developed against ffmpeg 9.0.2). The whole run takes about
a second.

| File | What it is | Engine should |
| --- | --- | --- |
| `tigger-pooh.mp4` | The reference problem file: HEVC (`hvc1`), 20 AAC tracks and 21 `mov_text` subs, original language (eng) first, **Turkish default** in both, one untagged sub, PNG cover as an `attached_pic` video stream | keep eng, deu, original and untagged tracks with exactly one default per type |
| `compliant.mkv` | HEVC, eng (default) + deu audio, eng (default) + deu SRT | do nothing |
| `untagged.mkv` | two untagged audio (first default), two untagged SRT | keep untagged tracks |
| `pgs-subs.mkv` | PGS sub (eng, default) + DVD sub (deu) | refuse remux to MP4 |
| `ass-fonts.mkv` | ASS sub (eng, default) + attached TrueType font | keep the attachment with the ASS track |
| `two-defaults.mkv` | eng and deu audio, both flagged default | leave exactly one default |
| `h264-big.mkv` | 640×360 H.264 (`libx264 -crf 10`, oversized, ~1.2 MB), eng (default) + deu AAC, eng SRT (default) | shrink below 80 % as HEVC |
| `no-default-audio.mkv` | 320×180 H.264 (`libx264 -crf 10`), eng + deu AAC and an eng SRT, **no stream flagged default** | flag one default audio when it rewrites |
| `two-defaults-h264.mkv` | 320×180 H.264 (`libx264 -crf 10`), eng and deu AAC **both flagged default** | leave exactly one default audio when it rewrites |
| `no-default-sub.mkv` | 320×180 H.264, eng AAC (default), eng + deu SRT with **no default subtitle** | flag the first subtitle default when remuxed to MP4 (the muxer would) |

## Notes

- **Untagged.** The manifest reports `language: null` for both a missing tag and `und` — MP4 cannot
  store "no language", so `tigger-pooh.mp4`'s untagged sub is written as `und`.
- **PGS.** ffmpeg has no PGS encoder and cannot render text to bitmaps, so the script writes a
  minimal valid `.sup` by hand (one 64×16 box shown from 0.5 s, cleared at 2.5 s) and
  stream-copies it; the DVD track is transcoded from that (bitmap → bitmap). ffmpeg shifts the
  subtitle start to 0 s.
- **H.264.** `h264-big.mkv`, `no-default-audio.mkv`, `two-defaults-h264.mkv` and `no-default-sub.mkv` are always `libx264` (the manifest's `hevcEncoder` field is the encoder
  picked for the run, not used by this file).
- **HEVC encoder.** `libx265` if available, else `hevc_videotoolbox`; force one with
  `TRANSCODA_FIXTURE_HEVC=libx265|hevc_videotoolbox`. The manifest records which one was used per
  file. Bytes and hashes differ between encoders and ffmpeg versions, so tests should assert stream
  properties, not hashes.
- **Font.** The first of Arial/Verdana (macOS) or DejaVu Sans (Linux) that exists is attached;
  override with `TRANSCODA_FIXTURE_FONT=/path/to/font.ttf`. Its mimetype is
  `application/x-truetype-font` so ffprobe reports codec `ttf`.
- **Dispositions** are set explicitly on every stream (Matroska muxer `default_mode` is
  `passthrough` in ffmpeg 9), so nothing is inferred.
