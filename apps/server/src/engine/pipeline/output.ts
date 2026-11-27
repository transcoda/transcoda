// The encoded output, checked and written: verify, then replace the original (with its
// recycled sidecars) or move/copy the output under an output root.

import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { FinishAction } from '@transcoda/sdk';
import { type FailureCode, RENDER_DONE_PORT } from '@transcoda/shared';
import { durably } from '../../db/open.ts';
import { findJob, type JobRow, updateJob } from '../../db/repos/jobs/jobs.ts';
import { ClobberRefused, errorCode, renameNoClobber } from '../../platform/fs-ops.ts';
import { toVerifyProgress, type VerifyProgress } from '../encode/progress.ts';
import { checkPath, isWithin } from '../files/paths.ts';
import { defaultRecycleFolder } from '../files/recycle.ts';
// Two functions are named replaceOriginal: the finish node (nodes/core/finish.ts) and this one.
import {
  durableReplaceWrites,
  pollForSpace,
  replaceOriginal as replaceOriginalFile,
  spaceWaitText,
} from '../files/replace.ts';
import { recycleSidecars } from '../files/sidecar-recycle.ts';
import { settleReplaceNow } from '../files/sweep.ts';
import { extraInputOf } from '../model/model.ts';
import type { JobControl } from '../queue/scheduler.ts';
import { verifyOutput } from '../verify/verify.ts';
import { sourceDamaged } from './branches.ts';
import type { PipelineCore } from './core.ts';
import { traceFinish } from './trace.ts';
import {
  type End,
  type Failure,
  fail,
  final,
  message,
  PROGRESS_INTERVAL_MS,
  type Prepared,
  retryable,
  Stop,
  type Written,
} from './types.ts';

/**
 * Verifies the encoded output (each check written to the job as it is done); null when it passed,
 * else how the job ends: kept for a damaged source, or a retryable verify failure.
 */
export async function verifyEncoded(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  p: Prepared,
): Promise<End | null> {
  const { config } = core.deps;
  // Each check is written as it is done; the whole-file decode is throttled like an encode.
  let lastVerifyWrite = Number.NEGATIVE_INFINITY;
  const onVerifyProgress = (v: VerifyProgress): void => {
    if (ctl.signal.aborted) return;
    const t = core.deps.now().getTime();
    if (v.stage === 'full-decode' && (v.sample.outTimeSeconds ?? 0) > 0) {
      if (t - lastVerifyWrite < PROGRESS_INTERVAL_MS) return;
    }
    lastVerifyWrite = t;
    core.update(job, ctl, { progress: toVerifyProgress(v) });
  };
  const verified = await verifyOutput({
    outputPath: p.outputPath,
    sourcePath: p.realPath,
    model: p.model,
    sourceProbe: p.probe,
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    fullDecode: p.library.verifyFullDecode,
    signal: ctl.signal,
    onProgress: onVerifyProgress,
    ...(core.deps.exec ? { exec: core.deps.exec } : {}),
  });
  core.stopIfAborted(ctl);
  for (const w of verified.warnings) core.renderWarn(job, p, w);
  if (verified.ok) {
    p.outputProbe = verified.probe;
    p.runningNode = null;
    if (p.renderNodeId !== null) {
      traceFinish(core, job, ctl, {
        nodeId: p.renderNodeId,
        workflowPath: [],
        source: 'core',
        port: RENDER_DONE_PORT,
        reason: 'Render: encoded and verified \u2192 Done',
      });
    }
  }
  if (!verified.ok) {
    if (verified.kind === 'source-damaged') {
      return sourceDamaged(
        core,
        job,
        ctl,
        p,
        verified.sourceFailures.map((f) => `${f.check}: ${f.message}`),
        verified.sourceFailures,
      );
    }
    return fail(
      retryable(
        'verify',
        `verify: ${verified.failures.map((f) => `${f.check}: ${f.message}`).join('; ')}`,
      ),
    );
  }
  return null;
}

/**
 * After a replace: the embedded sidecars marked `recycle` follow the original into the recycle
 * folder (never on a move-copy or a gate's else). Returns problems, never throws.
 */
export async function recycleSidecarsAfterReplace(
  core: PipelineCore,
  job: JobRow,
  p: Prepared,
  r: { recycleFolder: string; libraryRoot: string },
): Promise<string[]> {
  if (job.dryRun) throw new Error('a sidecar recycle step reached a dry run');
  const wanted = p.model.streams.some(
    (s) => s.keep && extraInputOf(p.model, s)?.afterReplace === 'recycle',
  );
  if (!wanted) return [];
  const { db, fs, log, now } = core.deps;
  return recycleSidecars(
    {
      model: p.model,
      jobId: job.id,
      libraryId: p.library.id,
      libraryRoot: r.libraryRoot,
      recycleFolder: r.recycleFolder,
    },
    { fs, recordRecycled: durableReplaceWrites(db, job.id, now, log).recordRecycled, now, log },
  );
}

export async function replace(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  p: Prepared,
  actionFolder: string | null,
): Promise<
  | {
      kind: 'done';
      job: JobRow;
      replacedTo: 'recycle';
      /** The recycle folder the replace used (sidecars follow the original there). */
      recycleFolder: string;
      libraryRoot: string;
      lateCancel: boolean;
      problem: string | null;
    }
  | { kind: 'requeue'; reason: string; requeues: number }
  | { kind: 'failure'; failure: Failure }
> {
  if (job.dryRun) throw new Error('a replace step reached a dry run');
  const { db, fs, config } = core.deps;
  const failure = (reason: string, code: FailureCode = 'replace') => ({
    kind: 'failure' as const,
    failure: final(code, reason),
  });
  // Only realpaths reach the replace: the file and its root are resolved again right before it.
  const check = await checkPath(db, p.realPath, fs);
  core.stopIfAborted(ctl);
  if (!check.ok || check.library.id !== p.library.id || check.realPath !== p.realPath) {
    return failure(
      `file moved before the replace: ${check.ok ? 'path now leads elsewhere' : check.reason}`,
      'source_changed',
    );
  }
  const root = check.library.path;
  if ((await fs.realpath(root)) !== root || (await fs.realpath(p.realPath)) !== p.realPath) {
    return failure('replace needs realpaths of the file and its library root');
  }
  let recycleFolder: string;
  if (actionFolder !== null) {
    // A node's folder stays inside the library root (the library's own setting is the admin's).
    recycleFolder = resolve(root, actionFolder);
    if (!isWithin(recycleFolder, root)) {
      return failure(`replace: recycle folder ${actionFolder} is outside the library root ${root}`);
    }
  } else {
    const folder = check.library.recycleFolder ?? defaultRecycleFolder(root);
    recycleFolder = isAbsolute(folder) ? folder : resolve(root, folder);
  }
  job = core.update(job, ctl, { state: 'replacing', progress: null });
  const result = await replaceOriginalFile(
    {
      jobId: job.id,
      originalPath: p.realPath,
      outputPath: p.outputPath,
      expected: p.fp,
      recycleFolder,
      owner:
        config.puid !== null && config.pgid !== null
          ? { uid: config.puid, gid: config.pgid }
          : null,
      libraryId: check.library.id,
      libraryRoot: root,
    },
    {
      fs,
      // Each write commits on its own with synchronous = FULL (never inside a transaction).
      ...durableReplaceWrites(db, job.id, core.deps.now, core.deps.log),
      waitForSpace: core.deps.waitForSpace ?? pollForSpace,
      // C4: the job says what it waits for ("waiting for 5.40 GB free on /media (5.10 GB free)"),
      // refreshed on every check, and the reason is cleared when the wait is over.
      // Telling must never change how the replace ends: a failed write is a log line.
      onSpaceWait: (wait) => {
        try {
          if (wait === null) core.deps.spaceWaits?.clear(job.id);
          else core.deps.spaceWaits?.set(job.id, wait, core.deps.now());
          const reason = wait === null ? null : spaceWaitText(wait);
          if (reason !== job.reason) job = core.update(job, ctl, { reason });
        } catch (err) {
          core.deps.log.warn({
            msg: 'could not record the wait for free space',
            job: job.id,
            error: message(err),
          });
        }
      },
      now: core.deps.now,
      log: core.deps.log,
      signal: ctl.signal,
    },
  );
  if (result.kind === 'cancelled') {
    // Nothing on disk changed; a cancel ends the job, a shutdown leaves it to the sweep.
    throw new Stop();
  }
  if (result.kind === 'fingerprint-changed') {
    if (ctl.stopReason() === 'shutdown') throw new Stop();
    const fresh = findJob(db, job.id) ?? job;
    if (fresh.requeues < 1) {
      return {
        kind: 'requeue',
        reason: 'file changed during processing',
        requeues: fresh.requeues + 1,
      };
    }
    return failure('file changed during processing', 'source_changed');
  }
  if (result.kind === 'failed') {
    const what = `replace: ${result.step}: ${result.message}`;
    // Nothing moved yet: final (the check that refused will refuse again).
    if (result.step === 'checking') return failure(what);
    // Past the check: settled now from what is on disk, with the sweep's rules.
    const row = findJob(db, job.id) ?? job;
    const settled = await settleReplaceNow(db, { fs, log: core.deps.log }, row, core.deps.now());
    if (settled === 'completed') {
      // The file was replaced and its original is in the recycle folder: done.
      if (findJob(db, job.id)?.replaceJournal) {
        durably(db, () => updateJob(db, job.id, { replaceJournal: null }, core.deps.now()));
      }
      return {
        kind: 'done',
        job: findJob(db, job.id) ?? job,
        replacedTo: 'recycle',
        recycleFolder,
        libraryRoot: root,
        lateCancel: false,
        problem: `${what}; recovered: the replacement is installed`,
      };
    }
    if (settled === 'rolledBack') return failure(`${what}; original restored`);
    if (settled === 'cleared') return failure(`${what}; nothing was replaced`);
    // conflicts: the sweep's reason says what is left (the journal may stay for the next start).
    return failure(findJob(db, job.id)?.reason ?? what);
  }
  // Replaced: recorded even during a shutdown (the sweep would otherwise requeue a replaced file).
  return {
    kind: 'done',
    job,
    replacedTo: 'recycle',
    recycleFolder,
    libraryRoot: root,
    lateCancel: ctl.stopReason() === 'cancel',
    problem: null,
  };
}

/**
 * Copies (or moves) the output to `outputRoot/<path relative to the library root>` through a
 * tmp beside the destination and a no-clobber rename. Abort-aware: a cancel or shutdown while
 * it writes removes the tmp and throws Stop.
 */
export async function moveCopy(
  core: PipelineCore,
  job: JobRow,
  ctl: JobControl,
  p: Prepared,
  action: Extract<FinishAction, { kind: 'move-copy' }>,
  state: Written,
): Promise<Failure | null> {
  if (job.dryRun) throw new Error('a move-copy step reached a dry run');
  const { fs, config } = core.deps;
  const root = resolve(action.outputRoot);
  const allowed = config.outputRoots.map((r) => resolve(r));
  if (!allowed.some((r) => isWithin(root, r))) {
    return final('replace', `move-copy: ${action.outputRoot} is not a configured output root`);
  }
  const rel = relative(p.library.path, p.realPath);
  const stem = rel.slice(0, rel.length - extname(rel).length);
  const dest = join(root, `${stem}${extname(p.outputPath)}`);
  if (!isWithin(dest, root)) return final('replace', `move-copy: ${dest} is outside ${root}`);
  const tmp = join(dirname(dest), `.transcoda-${job.id}.tmp`);
  /** Removes the tmp; returns the error text when it could not. */
  const dropTmp = async (): Promise<string> => {
    try {
      await fs.unlink(tmp);
      return '';
    } catch (err) {
      return errorCode(err) === 'ENOENT' ? '' : `; could not remove ${tmp}: ${message(err)}`;
    }
  };
  core.stopIfAborted(ctl);
  try {
    await fs.mkdir(dirname(dest));
    if (await fs.exists(dest)) return final('replace', `move-copy: ${dest} already exists`);
    await fs.copyFile(p.outputPath, tmp);
    if (ctl.signal.aborted) {
      const left = await dropTmp();
      if (left) p.warnings.push(`move-copy${left}`);
      throw new Stop();
    }
    if (config.puid !== null && config.pgid !== null) {
      try {
        await fs.chown(tmp, config.puid, config.pgid);
      } catch (err) {
        if (errorCode(err) !== 'EPERM') throw err;
      }
    }
    await renameNoClobber(fs, tmp, dest);
  } catch (err) {
    if (err instanceof Stop) throw err;
    const left = await dropTmp();
    if (err instanceof ClobberRefused)
      return final('replace', `move-copy: ${dest} already exists${left}`);
    return retryable('replace', `move-copy: ${message(err)}${left}`);
  }
  state.dest = dest;
  state.mode = action.mode === 'move' ? 'moved' : 'copied';
  if (action.mode === 'move') {
    try {
      await fs.unlink(p.outputPath);
    } catch (err) {
      p.warnings.push(
        `move-copy: could not remove the moved output ${p.outputPath}: ${message(err)}`,
      );
    }
  }
  return null;
}
