// Prepare: load the workflow, check the file, probe → decide → build, and render the argv; a job
// that ends here is recorded at once, else what it learned is kept for execute.

import type { Stats } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { AnyFinishAction, ProbeResult, StreamPlan } from '@transcoda/sdk';
import type { Issue, JsonValue, Lane, TraceEntry, WorkflowGraph } from '@transcoda/shared';
import { type Exec, makeExec } from '../capabilities/ffmpeg.ts';
import { type Fingerprint, fingerprintKey } from '../db/repos/files.ts';
import {
  alreadyProcessedReason,
  appendTrace,
  findPriorRun,
  type JobRow,
  nextTraceSeq,
  setJobProbe,
  upsertFile,
  type WalkStep,
} from '../db/repos/jobs.ts';
import { findRun } from '../db/repos/runs.ts';
import type { CoreTools } from '../nodes/core-tools.ts';
import { alreadyProcessed } from './already-processed.ts';
import {
  copyPictures,
  coverFile,
  encoderUsable,
  isIdentity,
  isMkvCover,
  kept,
  normalizeDefaults,
} from './build-model.ts';
import { checkSource } from './check-source.ts';
import type { CurrentNode } from './events.ts';
import { loadWorkflowForJob } from './load-workflow.ts';
import { checkPath, skipReasonFor } from './paths.ts';
import { sourceDamagedAtCheck } from './pipeline-branches.ts';
import type { PipelineCore } from './pipeline-core.ts';
import {
  estimateBytes,
  laneFor,
  originalLanguageOf,
  planOf,
  renderOnPath,
  sizeGateDecides,
  slotFitOf,
} from './pipeline-plan.ts';
import { gateFindings, traceFinish, traceGate } from './pipeline-trace.ts';
import {
  fileStatsOf,
  logPathFor,
  message,
  NEVER_WRITES,
  PASS_LOG_ARGS,
  type Prepared,
  stepOf,
  TRYING_ANOTHER_GPU,
} from './pipeline-types.ts';
import { probeFile, probeLog, probeReason } from './probe.ts';
import { outputExtension, RenderError, renderArgs, renderCommandLine } from './render.ts';
// Two functions are named replaceOriginal: the finish node (nodes/core/finish.ts) and this one.
import { fingerprintFromStats } from './replace.ts';
import { autoStreams, retarget } from './retarget.ts';
import type { ExecuteOutcome, JobControl, SlotFit } from './scheduler.ts';
import { confirmSourceDamage } from './verify.ts';
import { type WalkDeps, type WalkInput, walkBuild, walkDecide } from './walk.ts';

export async function runPrepare(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
): Promise<{ lane: Lane; fit: SlotFit } | { final: true } | ExecuteOutcome> {
  const { db, config, fs } = core.deps;
  let loaded = loadWorkflowForJob(core.deps.workflows, job);
  const pluginDown = (l: typeof loaded): boolean =>
    l.kind === 'invalid' &&
    l.issues.some((i: Issue) => i.severity === 'error' && i.code === 'PLUGIN_UNAVAILABLE');
  if (pluginDown(loaded) && core.deps.restartGate) {
    // A plugin that is restarting (crashed, in backoff) is waited for, up to its next restart plus
    // the start timeout; one that stopped, is disabled or removed is not, the job fails below.
    const waited = await core.deps.restartGate.waitForRestarts(ctl.signal);
    core.stopIfAborted(ctl);
    if (waited) {
      loaded = loadWorkflowForJob(core.deps.workflows, job);
      if (pluginDown(loaded) && job.attempt === 1) {
        return { requeue: { reason: 'a plugin was still restarting', attempt: 2 } };
      }
    }
  }
  if (loaded.kind === 'not-active') {
    core.finish(job, ctl, 'skipped', { reason: 'workflow is not active' });
    return { final: true };
  }
  if (loaded.kind === 'missing') {
    core.finish(job, ctl, 'failed', { code: 'workflow', reason: 'workflow missing' });
    return { final: true };
  }
  if (loaded.kind === 'invalid') {
    const errors = loaded.issues.filter((i: Issue) => i.severity === 'error');
    // A plugin that cannot run is named in the reason (the active version cannot start).
    const down = errors.filter((i) => i.code === 'PLUGIN_UNAVAILABLE');
    core.finish(job, ctl, 'failed', {
      code: 'workflow',
      reason: `workflow invalid: ${
        down.length > 0 ? down.map((i) => i.message).join('; ') : `${errors.length} error(s)`
      }`,
      warnings: errors.map((i) => `${i.nodeId ? `${i.nodeId}: ` : ''}${i.message}`),
    });
    return { final: true };
  }

  // A real job runs the version active when it starts: re-pin it (its row, events and results
  // then say which version ran).
  const repinned = loaded.version !== job.workflowVersion;
  if (repinned) job = core.update(job, ctl, { workflowVersion: loaded.version });

  // Where the file is now: the path, its library and the identity are checked again, and only
  // realpaths go further (a folder swapped for a symlink since queueing is caught here).
  const check = await checkPath(db, job.path, fs);
  core.stopIfAborted(ctl);
  if (!check.ok) return core.skip(job, ctl, check.reason);
  if (check.library.id !== job.libraryId) return core.skip(job, ctl, 'library changed');
  if (check.realPath !== job.path) return core.skip(job, ctl, 'path now leads to another file');
  const realPath = check.realPath;
  const library = check.library;

  let stat: Stats;
  try {
    stat = await fs.stat(realPath);
  } catch (err) {
    core.stopIfAborted(ctl);
    core.finish(job, ctl, 'failed', {
      code: 'source_unreadable',
      reason: `cannot read the file: ${message(err)}`,
    });
    return { final: true };
  }
  core.stopIfAborted(ctl);
  const fp = fingerprintFromStats(stat);
  const skip = skipReasonFor(fp, stat, library, core.deps.now(), core.settleMinutes);
  // `still growing` too: skipped, never requeued at once (it would be taken again right away).
  if (skip !== null) return core.skip(job, ctl, skip, fp);
  // A real job records what the source's content was (Already processed matches copies by it).
  const sourceHash = job.dryRun ? null : await core.hashOf(job, ctl, realPath);
  if (sourceHash !== null) core.sourceHashes.set(job.id, sourceHash);
  else core.sourceHashes.delete(job.id);

  // Another job may have processed this file while this one waited, and a re-pinned version
  // may have failed on it already (a forced run ignores both). A job not re-pinned skips the
  // failed match: Retry failed starts it again at the version its own failure has.
  if (!findRun(db, job.runId)?.force) {
    const prior = findPriorRun(db, fingerprintKey(fp), job.workflowId, job.workflowVersion, {
      sameVersion: job.dryRun,
      processedOnly: !repinned,
    });
    if (prior) {
      core.finish(job, ctl, 'already_processed', { reason: alreadyProcessedReason(prior) }, { fp });
      return { final: true };
    }
  }

  let probe: ProbeResult;
  try {
    probe = await probeFile(realPath, {
      ffprobePath: config.ffprobePath,
      signal: ctl.signal,
      ...(core.deps.exec ? { exec: core.deps.exec } : {}),
    });
  } catch (err) {
    core.stopIfAborted(ctl);
    // The job's reason is one plain sentence; the whole error (command and stderr) goes to the
    // job log and the server log.
    core.deps.log.warn({ msg: 'probe failed', job: job.id, error: message(err) });
    const logPath = await writeProbeLog(core, job, err);
    // A cancel or shutdown during the log write wins over the failure.
    core.stopIfAborted(ctl);
    core.finish(
      job,
      ctl,
      'failed',
      { code: 'source_unreadable', reason: probeReason(err, realPath) },
      { fp, logPath },
    );
    return { final: true };
  }
  core.stopIfAborted(ctl);
  upsertFile(
    db,
    {
      libraryId: library.id,
      path: realPath,
      fingerprint: fp,
      lastProbe: probe as unknown as JsonValue,
    },
    core.deps.now(),
  );
  setJobProbe(db, job.id, probe as unknown as JsonValue);

  // Decide.
  core.update(job, ctl, { state: 'deciding' });
  const file = fileStatsOf(fp, realPath);
  let lastBuildNode: CurrentNode | null = null;
  const walkDeps = walkDepsOf(
    core,
    job,
    ctl,
    (e) => {
      lastBuildNode = { workflowPath: [...e.workflowPath], nodeId: e.nodeId };
    },
    coreTools(core, job, ctl, realPath, probe, fp, sourceHash),
  );
  const walkInput: WalkInput = {
    graph: loaded.graph,
    probe,
    file,
    attempt: job.attempt,
    firstSeq: nextTraceSeq(db, job.id),
    dryRun: job.dryRun,
    jobId: job.id,
  };
  const decided = await walkDecide(walkDeps, walkInput);
  core.stopIfAborted(ctl);
  if (decided.kind === 'failed') return walkFailed(core, job, ctl, decided, fp);
  core.update(job, ctl, { walkPath: decided.nodes.map(stepOf) });

  // Build.
  core.update(job, ctl, { state: 'building' });
  const built = await walkBuild(walkDeps, walkInput, decided);
  core.stopIfAborted(ctl);
  if (built.kind === 'failed') return walkFailed(core, job, ctl, built, fp);
  core.update(job, ctl, { walkPath: built.path });
  if (built.sourceDamagedAt !== null) {
    return sourceDamagedAtCheck(core, job, ctl, { fp, realPath, probe, model: built.model }, built);
  }
  const { model, actions, gates, damaged } = built;
  // A picture a node set to convert is copied (see copyPictures).
  const pictureNotes = copyPictures(model, probe);
  // Default flags as the output will have them (verify compares them strictly); a model that
  // writes nothing is left as it is.
  const defaultNotes = isIdentity(model, probe)
    ? new Map<StreamPlan, string>()
    : normalizeDefaults(model, probe);
  // A stream with both notes keeps both.
  for (const [s, note] of pictureNotes) {
    const other = defaultNotes.get(s);
    defaultNotes.set(s, other === undefined ? note : `${note}; ${other}`);
  }
  const originalLanguage = originalLanguageOf(decided);
  const plan = planOf(model, probe, originalLanguage, defaultNotes);
  const estimatedBytes = estimateBytes(db, job.workflowId, fp.sizeBytes);
  const base = { fp, plan, estimatedBytes };

  if (!plan.rewrite) {
    core.finish(job, ctl, 'nothing_to_do', { reason: 'already as planned' }, base);
    return { final: true };
  }
  const writes = actions.some((a) => a.kind === 'replace' || a.kind === 'move-copy');
  // A path that only renders still renders when a damaged source has steps to run (Damaged).
  if (!writes && damaged === null) {
    core.finish(job, ctl, 'kept_original', { reason: NEVER_WRITES }, base);
    return { final: true };
  }

  const tempDir = join(config.transcodeDir, job.id);
  const outputPath = join(tempDir, `out${outputExtension(model.container)}`);
  const coverFiles = new Map<number, string>();
  for (const s of kept(model)) {
    if (isMkvCover(model, s)) {
      coverFiles.set(
        s.sourceIndex,
        join(tempDir, `cover-${s.sourceIndex}.${coverFile(s.codec).ext}`),
      );
    }
  }
  // ffmpeg never opens a sidecar in the library: each is copied into the temp dir first.
  const extraInputFiles = new Map<number, string>();
  for (const [n, e] of (model.extraInputs ?? []).entries()) {
    const ext = /^\.[A-Za-z0-9]{1,8}$/.test(extname(e.path)) ? extname(e.path) : '';
    extraInputFiles.set(n + 1, join(tempDir, `sidecar-${n + 1}${ext}`));
  }
  let args: string[];
  try {
    args = [
      ...PASS_LOG_ARGS,
      ...renderArgs({
        model,
        input: realPath,
        output: outputPath,
        coverFiles,
        extraInputFiles,
        ...core.renderDevice(),
      }),
    ];
  } catch (err) {
    if (!(err instanceof RenderError)) throw err;
    core.finish(job, ctl, 'failed', { code: 'encode', reason: `render: ${err.message}` }, base);
    return { final: true };
  }
  const command = renderCommandLine(config.ffmpegPath, args);
  // A job back from a failed GPU keeps saying so; a retry (no failed GPUs) starts clean. After a
  // restart the map is empty: the row's reason still says why it moved.
  if (job.failedGpus.length === 0) core.gpuWarnings.delete(job.id);
  else if (!core.gpuWarnings.has(job.id) && job.reason?.endsWith(TRYING_ANOTHER_GPU)) {
    core.gpuWarnings.set(job.id, [job.reason]);
  }
  const warnings: string[] = [...(core.gpuWarnings.get(job.id) ?? [])];
  if (config.puid !== null && config.puid !== stat.uid) {
    warnings.push(`owner would change from ${stat.uid} to ${config.puid}`);
  }

  if (job.dryRun && !job.testEncode) {
    // The plan cannot know what a gate will decide: the walk lists both branches and the gate
    // says so (the web shows both as possible). A gate before the write makes the outcome
    // "depends on size" (#41), recorded in the plan.
    const decides = sizeGateDecides(actions);
    const dryBase = decides ? { ...base, plan: { ...plan, dependsOnSize: decides } } : base;
    // A gate's own step, and a Render with a Damaged side, leave by no port: the result
    // decides, both branches are possible.
    const branching = new Set<string>();
    if (gates.some((g) => g.elsePath.length > 0)) for (const g of gates) branching.add(g.nodeId);
    if (damaged !== null) branching.add(damaged.nodeId);
    if (branching.size > 0) {
      const pass = built.path.map((s) =>
        s.workflowPath.length === 0 && branching.has(s.nodeId) ? { ...s, port: null } : s,
      );
      // A step several branches lead into (a notify behind both Yes and No) is listed once.
      const listed = new Set<string>();
      const once = (s: { workflowPath: string[]; nodeId: string }) => {
        const key = [...s.workflowPath, s.nodeId].join('\0');
        if (listed.has(key)) return false;
        listed.add(key);
        return true;
      };
      core.update(job, ctl, {
        walkPath: [...pass, ...gates.flatMap((g) => g.elsePath), ...(damaged?.path ?? [])]
          .filter(once)
          .map(stepOf),
      });
    }
    if (damaged !== null) {
      const steps = damaged.path.map((s) => titleOf(core, loaded.graph, s.nodeId)).join(', ');
      traceFinish(core, job, ctl, {
        nodeId: damaged.nodeId,
        workflowPath: [],
        source: 'core',
        port: null,
        reason: `Render: decides while encoding; if the source is damaged: ${steps}`,
      });
    }
    for (const g of gates) {
      const min = gateMinimum(actions[g.actionIndex]);
      traceGate(core, job, ctl, g.nodeId, {
        port: null,
        reason: `Size gate: decides after encoding: keep if it saves less than ${min}%`,
        findings: gateFindings(min),
      });
    }
    core.finish(
      job,
      ctl,
      writes ? 'dry_run' : 'kept_original',
      { reason: writes ? null : NEVER_WRITES, warnings },
      { ...dryBase, command },
    );
    return { final: true };
  }

  const auto = autoStreams(model, built.autoPicks);
  const prepared: Prepared = {
    realPath,
    library,
    fp,
    stat,
    probe,
    model,
    autoStreams: auto,
    actions,
    gates,
    damaged,
    renderNodeId: renderOnPath(loaded.graph, built.path),
    writes,
    walkPath: built.path.map(stepOf),
    plan,
    // Retarget and the software fallback keep the streams in order, so each note stays with
    // the stream at its index.
    replan: (other) => {
      const notes = new Map<StreamPlan, string>();
      for (const [i, s] of other.streams.entries()) {
        const note = defaultNotes.get(model.streams[i] as StreamPlan);
        if (note !== undefined) notes.set(s, note);
      }
      return planOf(other, probe, originalLanguage, notes);
    },
    tempDir,
    outputPath,
    logPath: logPathFor(config, job),
    coverFiles,
    extraInputFiles,
    lastBuildNode,
    runningNode: null,
    args,
    command,
    slot: null,
    estimatedBytes,
    warnings,
    outputProbe: null,
    written: null,
    fit: 'software',
  };
  prepared.fit = reachableFit(core, prepared, slotFitOf(model, auto));
  core.prepared.set(job.id, prepared);
  return { lane: laneFor(model, probe), fit: prepared.fit };
}

/**
 * An auto job's fit, narrowed to the vendor it was built for when it cannot move to the other
 * vendor's GPU (this ffmpeg lacks that encoder, or the moved model cannot render): otherwise it
 * would take the other vendor's slot and encode as built there, NVENC on GPU 0 from the Intel slot.
 */
function reachableFit(core: PipelineCore, p: Prepared, fit: SlotFit): SlotFit {
  if (fit !== 'gpu') return fit;
  const encoders = [...p.autoStreams].map((i) => p.model.streams[i]?.encoder ?? '');
  const nvidia = encoders.some((e) => e.endsWith('_nvenc'));
  const intel = encoders.some((e) => e.endsWith('_qsv'));
  if (nvidia === intel) return fit;
  const caps = core.capabilitiesOf();
  const usable = caps.encoders.filter((e) => encoderUsable(e, caps));
  const moved = retarget(p.model, p.autoStreams, nvidia ? 'intel' : 'nvidia', usable);
  if (moved && moved !== p.model && core.renderFor(p, moved)) return fit;
  return nvidia ? 'nvidia' : 'intel';
}

/**
 * Check source's pass for this job's file, cancelled with the job; a result is kept per file
 * (path, size, mtime) and setting, so a dry run followed by a real run reads the file once. A
 * pass that could not tell (`error`) is not kept: a retry reads again.
 */
function coreTools(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  realPath: string,
  probe: ProbeResult,
  fp: Fingerprint,
  sourceHash: string | null,
): CoreTools {
  // A real job hashed its source already; a dry run hashes it once, when a node first asks.
  let hashed: Promise<string | null> | null =
    sourceHash === null ? null : Promise.resolve(sourceHash);
  const contentHashOnce = () => {
    hashed ??= core.hashOf(job, ctl, realPath);
    return hashed;
  };
  return {
    alreadyProcessed: (q) =>
      alreadyProcessed(
        {
          db: core.deps.db,
          jobId: job.id,
          jobWorkflowId: job.workflowId,
          fingerprint: fingerprintKey(fp),
          contentHash: contentHashOnce,
        },
        q,
      ),
    checkSource: async ({ decodeVideo }) => {
      const key = `${realPath}\0${fp.sizeBytes}\0${fp.mtimeMs}\0${decodeVideo ? 1 : 0}`;
      const hit = core.checkResults.get(key);
      if (hit) return hit;
      const r = await checkSource({
        path: realPath,
        probe,
        ffmpegPath: core.deps.config.ffmpegPath,
        decodeVideo,
        sizeBytes: fp.sizeBytes,
        exec: core.deps.exec ?? checkExec,
        confirm: ({ at, seconds }) =>
          confirmSourceDamage({
            sourcePath: realPath,
            sourceProbe: probe,
            ffmpegPath: core.deps.config.ffmpegPath,
            ffprobePath: core.deps.config.ffprobePath,
            times: [at],
            seconds,
            signal: ctl.signal,
            ...(core.deps.exec ? { exec: core.deps.exec } : {}),
          }),
        signal: ctl.signal,
      });
      if (r.kind !== 'error') {
        core.checkResults.set(key, r);
        while (core.checkResults.size > CHECK_RESULTS_KEPT) {
          const oldest = core.checkResults.keys().next().value;
          if (oldest === undefined) break;
          core.checkResults.delete(oldest);
        }
      }
      return r;
    },
  };
}

function walkFailed(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  f: { nodeId: string; reason: string; path: WalkStep[]; retryable: boolean },
  fp: Fingerprint,
): { final: true } | ExecuteOutcome {
  const last = f.path.at(-1);
  if (last) ctl.setCurrentNode({ workflowPath: last.workflowPath, nodeId: last.nodeId });
  const reason = f.nodeId ? `${f.nodeId}: ${f.reason}` : f.reason;
  // A plugin hook that failed in a way a second attempt may fix: the same retry-once rule as
  // the encode (nothing has been written yet).
  if (f.retryable && job.attempt === 1) return { requeue: { reason, attempt: 2 } };
  core.update(job, ctl, { walkPath: f.path });
  core.finish(job, ctl, 'failed', { code: 'workflow', reason }, { fp });
  return { final: true };
}

/**
 * Writes a failed probe's command line and output to the attempt's job log; its path, or null
 * when the log cannot be written (the server log still has the error).
 */
async function writeProbeLog(
  core: PipelineCore,
  job: JobRow,
  err: unknown,
): Promise<string | null> {
  const { fs, config, log } = core.deps;
  const path = logPathFor(config, job);
  try {
    await fs.mkdir(dirname(path));
    await fs.writeText(path, probeLog(err));
    return path;
  } catch (e) {
    log.warn({ msg: 'probe log not written', job: job.id, error: message(e) });
    return null;
  }
}

/** A top-level node's title as the editor shows it: its label, else its type's title. */
function titleOf(core: PipelineCore, graph: WorkflowGraph, nodeId: string): string {
  const n = graph.nodes.find((x) => x.id === nodeId);
  if (!n) return nodeId;
  return n.label ?? core.deps.registry.get(n.type)?.def.title ?? n.type;
}

/** What the walk needs for this job: trace entries written and published, the node at work set. */
function walkDepsOf(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  onBuildEntry: (entry: TraceEntry) => void,
  tools?: CoreTools,
): WalkDeps {
  return {
    ...(tools ? { core: tools } : {}),
    registry: core.deps.registry,
    resolveChild: (id, version, overrides) =>
      core.deps.workflows.resolvePinnedChild(id, version, overrides),
    now: core.deps.now,
    onTrace: (entry: TraceEntry) => {
      if (ctl.stopReason() === 'shutdown') return;
      if (entry.phase === 'build') onBuildEntry(entry);
      appendTrace(core.deps.db, job.id, entry);
      core.events().publish({ type: 'job.trace', jobId: job.id, entry });
    },
    onNodeStart: (node) => {
      if (!ctl.signal.aborted) ctl.setCurrentNode(node);
    },
    capabilities: core.capabilitiesOf(),
    log: (m) => core.deps.log.info({ msg: 'node log', job: job.id, message: m }),
  };
}

/** The minimum saving of a size-gate action (0 if the action is something else). */
function gateMinimum(action: AnyFinishAction | undefined): number {
  return action?.kind === 'size-gate' ? action.minSavingPercent : 0;
}

/** Check source's pass: its own timeout is per call (by size); stderr may list many errors. */
const checkExec: Exec = makeExec({ timeout: 4 * 3_600_000, maxBuffer: 64 * 1024 * 1024 });
/** Check source results kept in memory (a dry run, then the real run). */
const CHECK_RESULTS_KEPT = 200;
