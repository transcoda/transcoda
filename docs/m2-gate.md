# M2 gate: Tigger & Pooh from an empty instance

The manual run that closes M2 (editor and job screens): the Tigger & Pooh cleanup built and run from the browser, end to end, from an empty instance. Performed on 2026-10-17 on branch `m2-editor`. Decisions and the findings list are in [`decisions.md`](decisions.md) under "M2 Phase B: jobs" and "M2 gate".

## Setup

- `pnpm check` and `pnpm build` passed before the run (web bundle 778 kB JS / 117 kB CSS, Vite's > 500 kB chunk warning; server `dist/main.js` 424 kB).
- A throwaway instance: `TRANSCODA_CONFIG_DIR` and `TRANSCODA_TRANSCODE_DIR` in a temporary folder, the API (`tsx src/main.ts`) on 127.0.0.1:18727, Vite on 127.0.0.1:18728 proxying to it, the browser on `http://t27.localhost:18728` (listed in `TRANSCODA_ALLOWED_HOSTS`) so the session cookie stayed separate. Viewport 1440 × 900.
- Media: `pnpm fixtures tigger-pooh h264-big`, with `tigger-pooh.mp4` copied into an empty temporary folder (`…/m2gate/media/fixtures`). Never real media. 379,411 bytes before the run.
- `/setup` completed with a generated throwaway admin.

Everything below was done in the UI; nothing was created through the API by hand.

## Steps and outcomes

| # | Step | Outcome |
| --- | --- | --- |
| 1 | `/` on the empty instance | Empty state "Start with where files come from" (screenshot 01). |
| 2 | `/libraries` → "New library": name "Fixtures", the temporary folder, recycle folder default | Row with "default (.transcoda-recycle in the library)", no default workflow, and the new "Scan now" action (02). |
| 3 | "New sub-workflow" "Language cleanup": Start → Keep languages (en, de; original on; untagged on) → Set default track (audio en; subtitles none) → Reorder tracks (en, de) → End; save | Built with "c" (connect from the selected node) and the inspector; the Reorder → End edge by dragging a port. Saved v2, no issues (03). |
| 4 | "New workflow" "TV cleanup": Manual input → Video is (codecs hevc) → pass: Run "Language cleanup" (override Languages to keep = en, de, tr) → Cover and attachments → Size gate 0 → Replace original; else: Encode video → Run "Language cleanup" (same override) → Replace original; both Run nodes grouped "Cleanup"; save | Saved v2, "No issues", no banner error (04). |
| 5 | "Try on a file" → `tigger-pooh.mp4` | Job page with the plan: "DRY RUN · NOTHING ON DISK CHANGED", WOULD DO "Rewrite once". Audio "3 of 20 tracks kept": English (default no → yes), German, Turkish (yes → no); "Drop 17 more in 17 languages". Subtitles "4 of 21 kept": English, German, Turkish, Untagged. Video and cover kept, container MP4 (05). Decisions: Video is → pass (codec hevc, height 180, 206 kb/s); "Run sub-workflow · enters sub-workflow Language cleanup v2"; Keep languages "… → kept eng, deu, tur; subtitles … → kept eng, deu, tur, und" (the override's en, de, tr, in the engine's three-letter codes; original language unknown, as Manual input gives none); Set default track, Reorder, Cover, Size gate, Replace original. "Open" on the Run node showed the sub-workflow's canvas with its path lit (06). The ffmpeg command was non-empty (9 maps, all `-c copy`). The file on disk: still 379,411 bytes, mtime unchanged. |
| 6 | "Enable TV cleanup…" → tick "I've checked the dry run on at least one file" → Enable | Toast "TV cleanup is enabled"; the workflow list shows ENABLED (07, 08). |
| 7 | `/libraries` → "Scan now" | First attempt: error toast "Fixtures has no default workflow. Edit the library to pick one." Edit → Default workflow "TV cleanup" → Save; "Scan now" again opened `/runs/<id>` with "1 file queued · 1 accounted for", In progress 1 (09). |
| 8 | Wait for the run | Run summary: Replaced 1, "1 file queued · 1 accounted for", "379 kB → 133 kB, saved 246 kB"; the row "Replaced · original in recycle folder · 379 kB → 133 kB" (10). Job page: RESULT Replaced, SIZE 379 kB → 133 kB, −65 %, "original in recycle folder" (11). On disk: `tigger-pooh.mp4` 133,331 bytes, `.transcoda-recycle/tigger-pooh.mp4` 379,411 bytes. ffprobe of the new file: video, audio eng (default) / deu / tur, subtitles eng (default) / deu / tur / und, cover. |
| 9 | "Scan now" a second time | Run summary "1 file queued · 1 accounted for", Nothing to do 1 (13; after the fix, reason "already complies with every rule", 18). Jobs page lists all three jobs (12). |
| 10 | Live view: `h264-big.mkv` copied in, "Pause queue", "Scan now", open the queued job, "Resume queue" | The first scan of the fresh copy was "Skipped · still growing" (settle window); after aging its mtime, the scan queued it (tigger-pooh: "Already processed"). With the queue paused the Jobs page showed "Queue paused — running jobs are frozen, nothing new starts" (15). After resuming, the job page showed "Encoding" with the else branch lit (Video is → Encode video → Run sub-workflow, the Run node highlighted as current) and the decisions filling in (14). It ended Replaced, 1.25 MB → 297 kB, original in the recycle folder; the run summary reconciled ("2 files queued · 2 accounted for", Replaced 1, Already processed 1) (19). |

## Deviations

- The library needed its default workflow set before "Scan now" (the brief's step 3 created it without one); the refusal toast says so.
- The second scan ended "Nothing to do" (the replaced file is a new file to the history check); a third scan ended "Already processed".
- Keep languages' reason names the override as "eng, deu, tur", not "en, de, tr" (engine wording).
- The subtitle default changed to English although Set default track had no subtitle language: mp4 cannot have no default subtitle (engine rule). The plan now says so.

## Bugs found

Fixed in this task, with tests: decisions listed in trace order instead of walk order (else branch); raw "already nothing_to_do on <ISO time>" reasons; "—" for nothing-to-do rows; the size tile showing the original size as the estimate when there is none ("no estimate yet"); the unexplained mp4 default subtitle; the enable dialog's "kept for 14 days" (the engine keeps 7 days at most). Left for later, listed in `decisions.md`: the job detail's probe is the file's latest one (old plans show the new file's track numbers), plus smaller editor and job-page items.

## Screenshots

Saved outside the repository (git-ignored) as `docs/design/screenshots/2026-10-16-m2/gate-*.png`:

- `gate-01-empty-instance` — the empty workflow list after setup.
- `gate-02-library-created` — the Fixtures library row with Scan now, Edit, Delete.
- `gate-03-subworkflow-language-cleanup` — the sub-workflow saved as v2.
- `gate-04-workflow-tv-cleanup-saved` — TV cleanup with the Cleanup group, saved, no issues.
- `gate-05-dry-run-plan` — the plan's top: eyebrow, tiles, audio table (before the estimate fix).
- `gate-06-dry-run-trace-subworkflow` — the trace with the Run node opened and the decisions.
- `gate-07-enable-dialog` — the enable confirmation (old 14-day copy).
- `gate-08-workflows-enabled` — the list with TV cleanup ENABLED and the sub-workflow "Used by 1".
- `gate-09-run-in-progress` — the run summary right after Scan now.
- `gate-10-run-summary-replaced` — Replaced 1, counts reconciled, bytes saved.
- `gate-11-job-replaced` — the job page result: Replaced, −65 %, original in recycle folder.
- `gate-12-jobs-page` — the Jobs page with the dry run, the replace and the nothing-to-do job.
- `gate-13-second-run-nothing-to-do` — the second scan (reason "—", before the fix).
- `gate-14-job-live-encoding` — the live job page during the encode, path lit.
- `gate-15-jobs-queue-paused` — the Jobs page with the queue paused and the job queued.
- `gate-16-plan-after-fixes` — the plan with "no estimate yet" and the mp4 default note.
- `gate-17-job-else-branch-decisions` — decisions in walk order on the else branch.
- `gate-18-second-run-after-fix` — the second scan's reason after the fix.
- `gate-19-run-already-processed-after-fix` — the third scan: Replaced (h264-big) and "processed on …: nothing to do".
