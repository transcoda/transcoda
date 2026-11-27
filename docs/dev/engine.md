# The encode engine

The rules in force today for `apps/server/src/engine/`, `apps/server/src/capabilities/` and the core nodes in `apps/server/src/nodes/core/`. History is in the decision files linked at the end; where they disagree with this page, the code wins.

## A job's path

1. **Queue** (`queue-service.ts`, `paths.ts`). A scan, the catch-up watcher (`catch-up.ts`) or a person queues a path. `checkPath` resolves it by realpath under a live library root; only `MEDIA_EXTENSIONS` are listed, the recycle folder and `.transcoda-<job>.tmp` files never are. `skipReasonFor` skips files that are still growing (`SETTLE_MINUTES`, 3), hardlinked or unreadable. `resolveWorkflow` pins the active version (a real run with nothing active becomes a dry run of the newest version). One transaction per run.
2. **Schedule** (`scheduler.ts`). Probe, decide and build run outside the lanes, at most `prepWorkers` (2) at once and at most `MAX_READY` (4) jobs preparing or ready. Then a job waits for its lane: `encode` (one slot per usable GPU, see below) or `quick` (one job).
3. **Prepare.** The path is checked again, a real job re-pins to the version active now (`loadWorkflowForJob`) and re-checks history, the file is probed (`probe.ts`) and fingerprinted (`fingerprint.ts`, plus a sampled `content-hash.ts`). The walk (`walk.ts`: `walkDecide`, then `walkBuild`) runs each node's hook and records a trace entry per node; Build gives a `BuildModel` (`build-model.ts`, `normalizeDefaults`), which `render.ts` turns into an ffmpeg argv (`renderArgs`). An identity model is `nothing_to_do`; a plan-only dry run ends here as `dry_run`.
4. **Execute.** The pipeline (the `Pipeline` class and its phase modules under `apps/server/src/engine/`) re-renders for the granted slot's device, extracts covers, runs ffmpeg (`process.ts`, progress from `progress.ts`), then verifies (`verify.ts`), then runs the finish steps in order: size gate, the write (`replace.ts` or move-copy), plugin steps, notify. Results go to `job_results`.
5. **Start-up** (`engine.ts`, `sweep.ts`). `startupSweep` settles every job with a replace or restore journal from what is on disk, kills stale ffmpeg groups by their `ffmpeg.pid`, empties the transcode dir (except `test-outputs/`), then `pruneRecycle` runs and the scheduler starts.

## Safety rules that must hold

- **Nothing rewrites media without a passing verify.** The only writers are Replace original and Move or copy, and only after verify. The pipeline copies the output beside the original as `.transcoda-<job>.tmp`; it never moves it.
- **Every replace recycles.** The original moves to the recycle folder (`<root>/.transcoda-recycle` by default; a configured folder must be strictly inside the library root and on the same filesystem; there is no copy-and-unlink fallback). `replaceOriginal` writes an intent journal (`checking` → `writing_tmp` → `moving_original` → `installing_tmp` → `cleaning`) before each step, committed with `durableReplaceWrites` (`synchronous = FULL`).
- **Never rename over an existing path.** Every rename in replace, sweep and restore goes through `renameNoClobber`. A taken recycle path gets `.1`, `.2`, ….
- **The disk decides recovery.** The sweep reads O/T/C (original, tmp, copy) and settles a job as completed, rolled back or a conflict; it decides nothing while the library root or the file's folder is unreachable. A replace that fails past `checking` is settled at once with the same rules (`settleReplaceNow`).
- **Free space.** A replace waits, cancellable, until the original's filesystem has the output size plus `FREE_SPACE_MARGIN_BYTES` (5 GB) free; the job's reason says so. The encode slot is already free by then; a quick-lane job keeps its lane while it waits.
- **Done after any write.** Once a replace installed the result or a move-copy finished, the job ends `done` whatever happens next (`finished with a problem: …`). Never retry after a write.
- **Fingerprint checks.** The original's fingerprint is checked after any space wait and right before it moves; a change discards the output and requeues once (`requeueOnce`), then fails with `source_changed`.
- **Dry runs change nothing in the library.** A plan-only dry run writes nothing at all. A test-encode dry run encodes and verifies for real into the transcode dir, stops at the first write step, and may keep the output in `<transcodeDir>/test-outputs/` (`test-outputs.ts`). `apps/server/src/mcp/never.test.ts` pins that the library stays byte-identical. Dry-run results never count as history.
- **Never re-run a processed file.** `findPriorRun` makes a file `already_processed` when a real job of the same workflow, at any version, ended `done`, `nothing_to_do` or `kept_original` with it as source or as output. A `failed` result counts for its own version only. Only Process again (`force`) overrides it. A dry run checks its own version only (`sameVersion`). A file moved back from the recycle folder matches its old `done` source and stays processed.
- **Restore** (`restore.ts`, `restoreRecycled`) has its own journal, moves with `renameNoClobber` and is a person's session only. Recycle rows are removed only through `removeRecycledRow`, which never touches a row whose job has a replace or restore journal. `insertRecycled` replaces a stale row for the same path.
- **Sidecar media info** (`nfo.ts`, `media-info.ts`, `poster-store.ts`) is read at queue time, never through a symlink, never outside the library, and nothing is ever written into a library for it.
- **Child processes.** ffmpeg runs from an argv array, no shell, in its own process group; every ffprobe/ffmpeg call outside the encode takes the job's abort signal (`makeExec` SIGKILLs on abort). `child-caps.ts` drops the server's ambient capabilities for every ffmpeg and ffprobe child.

## Verify

- `verifyOutput` runs every check and reports them all: `probe`, per-stream ends against the source's (bounded `-read_intervals` reads, 0.25 s plus the longer last packet), stream match in output order, default flags (exactly one default audio when there is audio, at most one default subtitle), `decode-start`, `decode-end` from a keyframe, `SAMPLE_SPOTS` (10) one-second spot decodes, and the targets.
- A decode passes only when ffmpeg exits 0 **and prints nothing**. Every null decode carries `NULL_TIMESTAMPS` (`-enc_time_base:v demux`, in `decoder-names.ts`).
- `verifyFullDecode` on a library adds a whole-file decode (6 h timeout); other verify calls get 300 s.
- In-pass checks read ffmpeg's stderr live: `classifyErrorLine` sorts each error line to source or output. A source error must be reproduced on the source before the original is kept (`kept_original`, never retried); otherwise it is output-invalid and retried once. The frame count is compared with `nb_frames` only.
- `source-damaged` needs proof on the source stream by stream; duration failures are always `output-invalid`.
- `TRANSCODA_DECODE_MEMORY_GB` (`memory-guard.ts`) stops a read-only decode whose memory keeps growing.

## Encoders, GPUs and slots

- `usableHardware` (`capabilities/devices.ts`) drops encoders that are listed but cannot run: NVENC without nvidia-smi must pass a one-frame test encode; QSV and VA-API need an openable `/dev/dri/renderD*`.
- `engine.encodeDevice` (`auto`, `cpu`, `nvidia:<n>`, `intel:<pci>`) filters capabilities through `effectiveCapabilities`. `engine.gpuOrder` sets GPU order (default NVIDIA by index, then Intel by PCI address).
- `encodeSlots` gives one encode slot per usable GPU under `auto` with two or more GPUs, else one slot. `slotFitOf` says what a job needs (`gpu`, `nvidia`, `intel`, `software`); a software job takes the last free slot.
- Auto order in `build-model.ts` is NVENC, QSV, VA-API, then software; `retarget.ts` moves an auto-picked stream to the slot's vendor at execute. A named encoder never moves.
- NVENC encodes decode with `-hwaccel cuda`; a QSV slot opens its render node and, for 8/10-bit 4:2:0 sources, decodes on the GPU too. A model that brings its own `-hwaccel` or `-init_hw_device` keeps it.
- A GPU failure (`looksLikeGpuFailure`, `fallback.ts`) requeues the job with that GPU in `failedGpus`; only when no other GPU fits does `softwareFallback` run it in software.

## Queue and scheduler

- **The encode slot frees once the file is encoded**, before the job turns `verifying` (`JobControl.releaseEncoder`). Verify, a test-encode's ending and the finish steps run without a lane. A verify failure is requeued and waits for a slot like any job.
- Pause frees the lane and SIGSTOPs ffmpeg; a resumed job gets its own slot back first. A pause outside ffmpeg holds the job before verify and before the finish steps. The queue pause persists across restarts.
- **Run hours** (`run-hours.ts`, `closedLibraries`): jobs of `library` runs in a closed library are not prepared and get no lane; a running job is never stopped. Manual runs start at once. Times are the server's zone.
- **Retry once, inside the job** (`attempt 2`): ffmpeg failure, output-side errors, verify `output-invalid`, move-copy I/O before a write. Deterministic failures (workflow, walk, render, probe, path checks, every replace failure) end at once.
- **Stall guard** (`stall-guard.ts`): an encode whose output stops growing for `TRANSCODA_ENCODE_STALL_MINUTES` (60; 0 turns it off) is stopped. No output at all is final; stopping partway is retried. Paused time does not count.
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

- Unit tests sit beside each module (`*.test.ts`). Build inputs with `apps/server/src/engine/test-helpers.ts` (`probeOf`, `fileOf`, `capsOf`, `withStream`, `withSidecar`, `packetRows`) instead of hand-written probes. Use `FakeSpawner` for ffmpeg runs.
- Real-ffmpeg tests (`*.real.test.ts`, and others that call `fixturesAvailable()`) read `.local/fixtures` through `engine/fixtures.ts`; generate them with `pnpm fixtures`. They skip without fixtures, so run them before changing verify, render or progress. `pnpm test:docker` runs them against the image's jellyfin-ffmpeg, as the nightly does.
- The ffmpeg argv is snapshot-tested in `engine/render.test.ts`; review every snapshot change. Tests use `libx264`/`libx265` only; hardware paths are covered by argv and scheduler tests.
- `engine/examples-walk.test.ts` walks every bundled example workflow.

## History

[M1 engine](../decisions/2026-10-m1-engine.md) · [M2 jobs](../decisions/2026-10-m2-jobs.md) · [Activation](../decisions/2026-10-activation-mcp.md) · [October 2026](../decisions/2026-10.md) · [November 2026](../decisions/2026-11.md)
