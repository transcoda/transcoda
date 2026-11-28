# The encode engine

The rules in force today for `apps/server/src/engine/`, `apps/server/src/capabilities/` and the core nodes in `apps/server/src/nodes/core/`. Where this page and the code disagree, the code wins.

## A job's path

1. **Queue** (`queue/queue-service.ts`, `files/paths.ts`). A scan, the catch-up watcher (`queue/catch-up.ts`) or a person queues a path. `checkPath` resolves it by realpath under a live library root; only `MEDIA_EXTENSIONS` are listed, the recycle folder and `.transcoda-<job>.tmp` files never are. `skipReasonFor` skips files that are still growing (`SETTLE_MINUTES`, 3), hardlinked or unreadable. `resolveWorkflow` pins the active version (a real run with nothing active becomes a dry run of the newest version). One transaction per run.
2. **Schedule** (`queue/scheduler.ts`). Probe, decide and build run outside the lanes, at most `prepWorkers` (2) at once and at most `MAX_READY` (4) jobs preparing or ready. Then a job waits for its lane: `encode` (one slot per usable GPU, see below) or `quick` (one job).
3. **Prepare.** The path is checked again, a real job re-pins to the version active now (`loadWorkflowForJob` in `walk/load-workflow.ts`) and re-checks history, the file is probed (`media/probe.ts`) and fingerprinted (`files/fingerprint.ts`, plus a sampled `media/content-hash.ts`). The walk (`walk/walk.ts`: `walkDecide`, then `walkBuild`) runs each node's hook and records a trace entry per node; Build gives a `BuildModel` (`model/model.ts`, `normalizeDefaults`), which `model/render.ts` turns into an ffmpeg argv (`renderArgs`). An identity model is `nothing_to_do`; a plan-only dry run ends here as `dry_run`.
4. **Execute.** The pipeline (the `Pipeline` class and its phase modules under `apps/server/src/engine/pipeline/`) re-renders for the granted slot's device, extracts covers, runs ffmpeg (`encode/process.ts`, progress from `encode/progress.ts`), then verifies (`verify/verify.ts`), then runs the finish steps in order: size gate, the write (`files/replace.ts` or move-copy), plugin steps, notify. Results go to `job_results`.
5. **Start-up** (`engine.ts`, `files/sweep.ts`). `startupSweep` settles every job with a replace or restore journal from what is on disk, fails the jobs whose result waited for approval ([Approval](#approval)), kills stale ffmpeg groups by their `ffmpeg.pid`, empties the transcode dir (except `<transcodeDir>/test-outputs/`), then `pruneRecycle` runs and the scheduler starts.

## Safety rules that must hold

- **Nothing rewrites media without a passing verify.** The only writers are Replace original and Move or copy, and only after verify. The pipeline copies the output beside the original as `.transcoda-<job>.tmp`; it never moves it.
- **Every replace recycles.** The original moves to the recycle folder (`<root>/.transcoda-recycle` by default; a configured folder must be strictly inside the library root and on the same filesystem; there is no copy-and-unlink fallback). `replaceOriginal` writes an intent journal (`checking` → `writing_tmp` → `moving_original` → `installing_tmp` → `cleaning`) before each step, committed with `durableReplaceWrites` (`synchronous = FULL`).
- **Never rename over an existing path.** Every rename in replace, sweep and restore goes through `renameNoClobber`. A taken recycle path gets `.1`, `.2`, ….
- **The disk decides recovery.** The sweep reads O/T/C (original, tmp, copy) and settles a job as completed, rolled back or a conflict; it decides nothing while the library root or the file's folder is unreachable. A replace that fails past `checking` is settled at once with the same rules (`settleReplaceNow`). Every case is in [Settling an interrupted replace](#settling-an-interrupted-replace).
- **An older `.orig` journal is left for the user.** Before 2026-11-27 the journal carried `recycling`, and `false` meant a replace that kept the original as `<file>.transcoda-<job>.orig` and deleted it at the end. That path is gone. The sweep never settles such a journal: it touches no file, fails the job with the three paths in its reason, and keeps the journal (so the tmp is not taken for a stray) until neither the `.orig` nor the tmp is left. New journals have no `recycling` field. Job results with `replacedTo: 'deleted'` stay valid history and the Jobs page still shows them.
- **Free space.** A replace waits, cancellable, until the original's filesystem has the output size plus `FREE_SPACE_MARGIN_BYTES` (5 GB) free; the job's reason says so. The encode slot is already free by then; a quick-lane job keeps its lane while it waits.
- **Done after any write.** Once a replace installed the result or a move-copy finished, the job ends `done` whatever happens next (`finished with a problem: …`). Never retry after a write.
- **Fingerprint checks.** The original's fingerprint is checked after any space wait and right before it moves; a change discards the output and requeues once (`requeueOnce`), then fails with `source_changed`.
- **Dry runs change nothing in the library.** A plan-only dry run writes nothing at all. A test-encode dry run encodes and verifies for real into the transcode dir, stops at the first write step, and may keep the output in `<transcodeDir>/test-outputs/` (`files/test-outputs.ts`). `apps/server/src/mcp/never.test.ts` pins that the library stays byte-identical. Dry-run results never count as history.
- **Never re-run a processed file.** `findPriorRun` makes a file `already_processed` when a real job of the same workflow, at any version, ended `done`, `nothing_to_do` or `kept_original` with it as source or as output. A `failed` result counts for its own version only. Only Process again (`force`) overrides it. A dry run checks its own version only (`sameVersion`). A file moved back from the recycle folder matches its old `done` source and stays processed. One exception (`askingVersion` in `findProcessedResult`, used by the queue, prepare and Already processed asked about its own workflow at any version): when the asking version has a size gate set to write track changes, a `kept_original` result with the gate's reason (`saved only …`) from a version whose gates kept the original does not count, so that version takes the file again. A file kept by a version that writes track changes still counts, so nothing is taken again and again.
- **Restore** (`files/restore.ts`, `restoreRecycled`) has its own journal, moves with `renameNoClobber` and is a person's session only. Recycle rows are removed only through `removeRecycledRow`, which never touches a row whose job has a replace or restore journal. `insertRecycled` replaces a stale row for the same path.
- **Sidecar media info** (`media/nfo.ts`, `media/media-info.ts`, `media/poster-store.ts`) is read at queue time, never through a symlink, never outside the library, and nothing is ever written into a library for it.
- **Child processes.** ffmpeg runs from an argv array, no shell, in its own process group; every ffprobe/ffmpeg call outside the encode takes the job's abort signal (`makeExec` SIGKILLs on abort). `platform/child-caps.ts` drops the server's ambient capabilities for every ffmpeg and ffprobe child.

## Settling an interrupted replace

`settleJournal` in `apps/server/src/engine/files/sweep.ts` settles every job that still has a replace journal: at start-up through `startupSweep`, and at once through `settleReplaceNow` when `replaceOriginal` fails past `checking`. The journal names the paths; the files on disk decide what happened. The journal's step is read in one place only (the rows with "step `installing_tmp` or later" below).

Three paths are looked at: **O**, the original's path (`originalPath`); **T**, the tmp beside it (`tmpPath`, `.transcoda-<job>.tmp`); **C**, where the original goes in the recycle folder (`copyPath`). A path exists when `lstat` finds it (`FsOps.exists`; a symlink is never followed). A file **is the original** when its size, mtime, inode and device match the fingerprint the job probed (`sameFingerprint`). O **holds the replacement** when there is no T, O is not the original and its size is the journal's `outputBytes`.

Before the table, in order; the first that applies decides:

1. **An older `.orig` journal** (`recycling: false`) is left for the user, as described above. No file is touched.
2. **The library cannot be seen.** The library root or O's folder is missing, or O is missing and so is C's folder: the job fails with `library root unavailable: <path>`, the journal stays and the next start looks again. An unmounted share reads as empty, and settling from it would end in a false "original missing".
3. **One file under two names.** When O and C, or O and T, are the same inode on the same device (a crash inside `renameNoClobber` between its link and its unlink, or a rename replayed after a power loss), the second name is unlinked, its folder synced, and the table goes on as if it had never been there.

| O | T | C | Also true | What the sweep does | The job | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| yes | any | yes | C is the original, O holds the replacement | Nothing to move: the install happened, only the `cleaning` intent was lost. | completed (below) | `completed` |
| yes | any | yes | anything else | Both files stay where they are; T too. Journal cleared. | `failed`, `replace left two copies: <O>, <C>` | `conflicts` |
| yes | any | no | step `installing_tmp` or later, O holds the replacement | Nothing to move: the copy was pruned or deleted after the install. | completed (below) | `completed` |
| yes | any | no | step `installing_tmp` or later, O is the original | An earlier sweep moved the original back and stopped before it recorded that. T removed, O's folder synced, recycle row dropped, journal cleared. | `failed`, `interrupted; original restored`, not requeued | `rolledBack` |
| yes | any | no | anything else (the original never left) | T removed, the recycle row for C dropped, journal cleared. | requeued when it was running (`requeueOnce`: failed instead on a second interruption); a job the pipeline had already ended keeps its state; never requeued through `settleReplaceNow` | `interrupted` or `cleared` |
| no | yes | yes | T's size is `outputBytes` | T renamed to O (no clobber), O's folder synced. | completed (below) | `completed` |
| no | yes | yes | T has another size | C renamed back to O (no clobber), both folders synced, recycle row dropped, journal cleared, then T removed. A tmp that is not the whole replacement is never installed. | `failed`, `interrupted; original restored`, not requeued | `rolledBack` |
| no | no | yes | O is still free | C renamed back to O (no clobber), both folders synced, recycle row dropped, journal cleared. | `failed`, `interrupted; original restored`, not requeued | `rolledBack` |
| no | no | yes | something took O meanwhile | Nothing moves (`ClobberRefused`). Journal cleared. | `failed`, `could not restore the original: …; the original is at <C>` | `conflicts` |
| no | yes | no | | T stays. Recycle row dropped, journal cleared. | `failed`, `original missing` | `conflicts` |
| no | no | no | | Recycle row dropped, journal cleared. | `failed`, `original missing` | `conflicts` |

Every `failed` here has failure code `replace`, except `interrupted; original restored`, which has `interrupted`.

- **Completed** sets the job back to `replacing` with the journal at `cleaning`, and records the recycle row for C when C exists and the index has no row of this job at that path (a row an earlier job left at that path is replaced). At start-up `EngineService` then finishes it after `pruneRecycle`: the job ends `done` and its result is rewritten as a replace into the recycle folder. Through `settleReplaceNow` the pipeline clears the journal and ends the job `done` with the problem `…; recovered: the replacement is installed`.
- **Any other error while settling** (an I/O error, a rename refused in the restore after a short tmp) fails the job with `replace recovery failed: <error>; the original is at <O> or <C>` and keeps the journal, so the next start settles it again. It counts as a conflict.
- **A tmp left behind.** While a job had a journal when the sweep began, its tmp is never taken for a stray. A tmp that a row above leaves (two copies, original missing) is removed by the stray-tmp walk on the next start, once the journal is gone.
- **Through `settleReplaceNow`** the pipeline writes the job's end itself: `rolledBack` fails it with `replace: <step>: <error>; original restored`, `cleared` with `…; nothing was replaced`, and a conflict keeps the reason the sweep wrote.
- **An interrupted restore** (the restore journal) does not use this table: `rollBackRestore` in `apps/server/src/engine/files/restore.ts` undoes its moves from the last to the first, and the job stays `done`.

`apps/server/src/engine/files/sweep.test.ts` has a test for each row, and one that fails every disk call of the sweep once and checks that the original is never lost.

## Size gate: write track changes

A size gate with **When it saves less: Write track changes** (`belowMinimum: 'write-track-changes'`, node version 3; the v2→v3 migration sets `keep-original`, the old behaviour) handles a result that saved less than its minimum, before anything was written (`writeTrackChanges` in `pipeline/track-changes.ts`):

- **The plan.** `trackChangesOnly` starts from the model as built (`Prepared.asBuilt`: pictures copied, default flags not yet normalised). Every converted video becomes a copy of the source stream. Everything else stays: kept and dropped tracks, default and forced flags, order, languages, titles, the container, subtitle conversions the container needs, embedded sidecars.
- **Audio.** A converted audio track is copied unless its conversion plays on more of the plan's targets than the source track (`planIssues`), or on as many and shrinks the track: a lossless source (TrueHD, MLP, FLAC, ALAC, PCM, DTS-HD MA, WavPack, TTA) or a lower bitrate than the source's known one. So the result never plays on fewer targets than the source, and a conversion that only grows the track is dropped. A copied track gets back its source title when Encode audio had rewritten it for the new format. An added track (Encode audio's add-track) whose conversion is undone is left out, and its source track takes the default flag back.
- **Nothing to write.** When that plan is an identity of the source (`isIdentity`), the gate keeps the original exactly as Keep original does: No, `kept_original`, the same reason; the trace adds `(nothing but the video would change)`.
- **Write.** Otherwise the encoded output is deleted and the plan is rendered into `<tempDir>/tracks.<ext>` with `encode()` (no lane: the encode slot is already free; no GPU fallback) into the same attempt log, then verified like any output (`verifyEncoded`, without a second Render trace entry). The job continues on Yes as if the gate had passed: replace or move-copy, plugin steps, notify. It ends `done` with the reason `saved only 4.0%, below 20% → wrote track changes without re-encoding`, the result's plan, command and size are the remux's, and the gate's trace entry is `pass` with `findings.trackChanges: true`. A later size gate on the path does not measure again (traced as a pass).
- **Failure.** A remux or verify failure keeps the original (No, `kept_original`, the gate's reason) with a warning on the gate, `could not write the track changes: …`. It is never retried: a retry would encode the whole file again.
- **Dry runs.** A test encode does not remux: it ends `dry_run` with `… → would write track changes without re-encoding`. A plan-only dry run does not depend on size for such a gate when the plan has track changes (`sizeGateDecides`).

## Approval

The Approval node (`core:approval`, `nodes/core/approval.ts`) is a finish step of the `gate` phase with the size gate's ports: `pass` (Approved) and `else` (Rejected). Its finish hook returns no SDK action; the walk adds a core-only `ApprovalAction` for it (`approvalActionOf`), so the 1.x SDK's `FinishAction` union is unchanged. The walk and validation treat it like the size gate (`isGateType`): it must be alone on its output, and only non-writing steps may follow Rejected (`ELSE_ONLY_NOTIFY`, worded for Approval).

At run time (`pipeline/approval.ts`, `awaitApproval`), after verify and before anything is written:

- **Park.** The verified output stays in the job's temp dir. A `job_approvals` row (migration 23) keeps when it was parked, when it expires (`expireAfterDays`, 1 to 30, default 7), the sizes, the plan and the output probe; the job page and the Jobs list read it (`approval` on a job, the `awaitingApproval` list filter and count). The job stays `verifying` with the reason `waiting for approval` and gives up its lane (`JobControl.releaseLane`, the quick lane too), so other jobs run meanwhile.
- **Limit.** A result that would take the parked results past `TRANSCODA_APPROVAL_MAX_GB` (default 100 GB) is not parked: the job fails (`workflow`), the temp dir is removed and the original is untouched.
- **Answer.** `jobs.approve` and `jobs.reject` (a person's session only, refusal "Approval is a UI action"; no MCP tool) resolve the wait in memory (`ApprovalDesk`). Approved traces `pass` ("Approval: approved by <user>"), waits while the job is paused, and the remaining finish steps run as usual. Rejected traces `else`, runs the non-writing steps behind Rejected and ends `kept_original` ("rejected by <user>"); the output is discarded with the temp dir.
- **Expiry.** `engine.expireApprovals()` runs every minute and rejects the results past `expiresAt` the same way ("not approved within 7 days").
- **Cancel and shutdown.** A cancel deletes the row and ends the job `cancelled` like any other. A shutdown writes nothing.
- **Restart.** The wait does not survive a restart. Start-up step 2c of `startupSweep` (`failParkedApprovals`) deletes every row and fails its job (`interrupted`, never requeued): "the server restarted while the result waited for approval; the result was discarded and the original is untouched". The sweep then empties the temp dir as usual. Nothing was written, so the original is always untouched.
- **Health.** The deep health `queue` check does not count a job with a row as stalled.

## Verify

- `verifyOutput` runs every check and reports them all: `probe`, per-stream ends against the source's (bounded `-read_intervals` reads, 0.25 s plus the longer last packet), stream match in output order, default flags (exactly one default audio when there is audio, at most one default subtitle), `decode-start`, `decode-end` from a keyframe, `SAMPLE_SPOTS` (10) one-second spot decodes, and the targets.
- A decode passes only when ffmpeg exits 0 **and prints nothing**. Every null decode carries `NULL_TIMESTAMPS` (`-enc_time_base:v demux`, in `media/decoder-names.ts`).
- `verifyFullDecode` on a library adds a whole-file decode (6 h timeout); other verify calls get 300 s.
- In-pass checks read ffmpeg's stderr live: `classifyErrorLine` sorts each error line to source or output. A source error must be reproduced on the source before the original is kept (`kept_original`, never retried); otherwise it is output-invalid and retried once. The frame count is compared with `nb_frames` only.
- `source-damaged` needs proof on the source stream by stream; duration failures are always `output-invalid`.
- `TRANSCODA_DECODE_MEMORY_GB` (`platform/memory-guard.ts`) stops a read-only decode whose memory keeps growing.

## Encoders, GPUs and slots

- `usableHardware` (`capabilities/devices.ts`) drops encoders that are listed but cannot run: NVENC without nvidia-smi must pass a one-frame test encode; QSV and VA-API need an openable `/dev/dri/renderD*`.
- `engine.encodeDevice` (`auto`, `cpu`, `nvidia:<n>`, `intel:<pci>`) filters capabilities through `effectiveCapabilities`. `engine.gpuOrder` sets GPU order (default NVIDIA by index, then Intel by PCI address).
- `encodeSlots` gives one encode slot per usable GPU under `auto` with two or more GPUs, else one slot. `slotFitOf` says what a job needs (`gpu`, `nvidia`, `intel`, `software`); a software job takes the last free slot.
- Auto order in `model/model.ts` is NVENC, QSV, then software. VA-API is never picked by `auto`: the render sets up no VA-API device or `hwupload`, so it runs only when named, with the model's own device arguments; `model/retarget.ts` moves an auto-picked stream to the slot's vendor at execute. A named encoder never moves.
- NVENC encodes decode with `-hwaccel cuda`; a QSV slot opens its render node and, for 8/10-bit 4:2:0 sources, decodes on the GPU too. A model that brings its own `-hwaccel` or `-init_hw_device` keeps it.
- A GPU failure (`looksLikeGpuFailure`, `model/fallback.ts`) requeues the job with that GPU in `failedGpus`; only when no other GPU fits does `softwareFallback` run it in software.

## Queue and scheduler

- **The encode slot frees once the file is encoded**, before the job turns `verifying` (`JobControl.releaseEncoder`). Verify, a test-encode's ending and the finish steps run without a lane. A verify failure is requeued and waits for a slot like any job.
- Pause frees the lane and SIGSTOPs ffmpeg; a resumed job gets its own slot back first. A pause outside ffmpeg holds the job before verify and before the finish steps. The queue pause persists across restarts.
- **Run hours** (`queue/run-hours.ts`, `closedLibraries`): jobs of `library` runs in a closed library are not prepared and get no lane; a running job is never stopped. Manual runs start at once. Times are the server's zone.
- **Retry once, inside the job** (`attempt 2`): ffmpeg failure, output-side errors, verify `output-invalid`, move-copy I/O before a write. Deterministic failures (workflow, walk, render, probe, path checks, every replace failure) end at once.
- **Stall guard** (`encode/stall-guard.ts`): an encode whose output stops growing for `TRANSCODA_ENCODE_STALL_MINUTES` (60; 0 turns it off) is stopped. No output at all is final; stopping partway is retried. Paused time does not count.
- Shutdown writes nothing to the database (a completed replace is still recorded `done`); the sweep picks up the rest.

## Temp files and logs

- Everything a job writes while it runs is under `<TRANSCODA_TRANSCODE_DIR>/<jobId>/`: the output, `ffmpeg.pid` and extracted covers. The pipeline creates it in execute only.
- The temp dir is removed before a final state or a retry is written. On shutdown nothing is removed; the sweep does it.
- One ffmpeg log per attempt: `<configDir>/logs/jobs/<jobId>.attempt-<n>.log`, truncated when the attempt starts.
- Move or copy writes only under `TRANSCODA_OUTPUT_ROOTS` and never over an existing file.

## Failure codes

Every write of `failed` names one of `FAILURE_CODES` (`packages/shared/src/engine/states.ts`): `interrupted`, `source_unreadable`, `source_changed`, `encode`, `verify`, `replace`, `workflow`, `internal`. In the pipeline use `final(code, …)` or `retryable(code, …)`; the sweep and the scheduler set their own. Any other final state, and Retry failed, clear it. The code is for metrics; people see the reason.

## ffmpeg versions

The image ships jellyfin-ffmpeg 8 (`JELLYFIN_FFMPEG_VERSION` in `docker/Dockerfile`); local development often has ffmpeg 9. Code must work on both:

- ffmpeg 8 rounds null-muxer timestamps and logs false dts errors: hence `NULL_TIMESTAMPS` on every null decode.
- ffmpeg 8 reports `out_time=N/A` for a whole encode with a copied image track. Every complete progress block is still a sample (`outTimeSeconds` null), and `withFrameTime` takes the further of out time and `frame=` over the frame rate.
- jellyfin-ffmpeg lists NVENC, QSV and VA-API in every build; `usableHardware` is what keeps them out where they cannot run.
- Default flags assume Matroska's `default_mode` is passthrough (the default disposition is written as it is, never inferred). It is the muxer's default in jellyfin-ffmpeg 8.1.3, the version the image ships (`ffmpeg -h muxer=matroska`: `-default_mode … (default passthrough)`), as in ffmpeg 9, so the argv does not set it.

## Tests

- Unit tests sit beside each module (`*.test.ts`). Build inputs with `apps/server/src/engine/testing/builders.ts` (`probeOf`, `fileOf`, `capsOf`, `withStream`, `withSidecar`, `packetRows`) instead of hand-written probes. Use `FakeSpawner` for ffmpeg runs.
- Real-ffmpeg tests (`*.real.test.ts`, and others that call `fixturesAvailable()`) read `.local/fixtures` through `engine/testing/fixtures.ts`; generate them with `pnpm fixtures`. They skip without fixtures, so run them before changing verify, render or progress. `pnpm test:docker` runs them against the image's jellyfin-ffmpeg, as the nightly does.
- The ffmpeg argv is snapshot-tested in `engine/model/render.test.ts`; review every snapshot change. Tests use `libx264`/`libx265` only; hardware paths are covered by argv and scheduler tests.
- `engine/walk/walk.examples.test.ts` walks every bundled example workflow; `engine/engine.examples.test.ts` runs the core ones over real ffmpeg.
