// Libraries, runs and queueing: a file or a folder becomes a run with one job per media file.
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
  ACTIVE_JOB_STATES,
  type Issue,
  type JobPlan,
  type JobState,
  planSummary,
  type RunHours,
} from '@transcoda/shared';
import type { Database } from '../db/open.ts';
import {
  alreadyProcessedReason,
  findFinalRealResult,
  hasReplaceJournal,
  insertJob,
  type JobRow,
  updateJob,
  upsertFile,
} from '../db/repos/jobs.ts';
import {
  findLibrary,
  insertLibrary,
  type LibraryRow,
  listLibraries,
  softDeleteLibrary,
  trimSlash,
  updateLibrary,
} from '../db/repos/libraries.ts';
import { findRun, insertRun, listRuns, type RunRow, runCounts } from '../db/repos/runs.ts';
import { findFeeder, findWorkflow } from '../db/repos/workflows.ts';
import type { WorkflowService } from '../workflows/service.ts';
import type { EngineEvents } from './events.ts';
import { type Fingerprint, fingerprintKey } from './fingerprint.ts';
import { errorCode, type FsOps, nodeFsOps } from './fs-ops.ts';
import {
  checkPath,
  isMediaFile,
  isRecycleOrTemp,
  isWithin,
  listMediaFiles,
  type PathCheck,
  SETTLE_MINUTES,
  type SkipReason,
  skipReasonFor,
} from './paths.ts';
import { fingerprintFromStats } from './replace.ts';

export interface QueueInput {
  path: string;
  /** Default: the workflow that feeds the library (its active Library input). */
  workflowId?: string;
  dryRun: boolean;
  /** Dry runs only: the version to plan with. Default the newest. */
  workflowVersion?: number;
  /**
   * Dry runs only: encode, verify and measure for real, then stop before the first write.
   * `'if-single-file'`: only when the path is one file. Absent: false. Ignored for a real run,
   * also one that becomes a dry run because no version is active.
   */
  testEncode?: boolean | 'if-single-file';
  /** Queue files even when this workflow version already has a final result for them. */
  force: boolean;
  /** One file only ("Run on a file"): a folder is rejected as `not a file`. */
  fileOnly?: boolean;
  priority: number;
  createdBy: string;
}

export type QueueResult =
  | { kind: 'queued'; run: RunRow; jobs: JobRow[] }
  | { kind: 'path-rejected'; reason: string }
  | { kind: 'workflow-missing' }
  | { kind: 'version-missing' }
  | { kind: 'workflow-invalid'; issues: Issue[] }
  | { kind: 'no-feeding-workflow' };

export interface RunSummary {
  run: RunRow;
  counts: ReturnType<typeof runCounts>;
  workflowName: string;
  libraryName: string;
}

export interface RunFile {
  jobId: string;
  fileName: string;
  filePath: string;
  state: JobState;
  reason: string | null;
  beforeBytes: number | null;
  afterBytes: number | null;
  replacedTo: 'recycle' | 'deleted' | null;
  workflowVersion: number;
  /** Dry runs only: the estimated output size; null for a real run or a row without one. */
  estimatedBytes: number | null;
  /** Dry runs only: what the plan would do, in one line; null without a stored plan. */
  planSummary: string | null;
  /** A plan-only dry run decided by its size gate after encoding (#41); null otherwise. */
  dependsOnSize: { minSavingPercent: number } | null;
}

export interface RunDetail extends RunSummary {
  /** Every job of the run, in queue order. */
  files: RunFile[];
}

export type BrowseResult = {
  dirs: string[];
  files: Array<{ name: string; sizeBytes: number; mtime: string }>;
};

/** Why `browse` refused a folder, in the queue's words (`outside library root`, …). */
export type BrowseRejection = {
  kind: 'path-rejected';
  reason: Exclude<PathCheck, { ok: true }>['reason'] | 'in recycle folder';
};

export interface LibraryInput {
  name: string;
  path: string;
  recycleFolder?: string | null;
  processHardlinked?: boolean;
  /** Default false: verify decodes the whole output before replacing. */
  verifyFullDecode?: boolean;
  /** Default none: automatic jobs start at any time. */
  runHours?: RunHours | null;
}

export type LibraryPatch = Partial<
  Pick<LibraryRow, 'name' | 'recycleFolder' | 'processHardlinked' | 'verifyFullDecode' | 'runHours'>
>;

export interface QueueServiceDeps {
  db: Database;
  workflows: WorkflowService;
  events: EngineEvents;
  now(): Date;
  fs?: FsOps;
  /** Default {@link SETTLE_MINUTES}; 0 turns the "still growing" check off. */
  settleMinutes?: number;
  /** Called once per queued run and after a change to a library's run hours (the scheduler's tick). */
  onQueued(): void;
}

/** One file of a run before it is written: its skip reason, or its fingerprint. */
type Candidate =
  | { path: string; skip: SkipReason; fp?: undefined }
  | { path: string; skip: null; fp: Fingerprint };

const ACTIVE_SQL = ACTIVE_JOB_STATES.map((s) => `'${s}'`).join(',');
const DENIED = new Set(['EACCES', 'EPERM']);

async function realpathOrNull(fs: FsOps, p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

const RECYCLE_FOLDER_OUTSIDE = 'the recycle folder must be a folder inside the library root';

/**
 * A configured recycle folder must lie strictly inside the root: the root itself (or a parent)
 * would make every file "in the recycle folder", and one outside the root would move originals
 * out of the library (and usually off its filesystem). null: the default, always inside.
 */
function recycleFolderFits(root: string, folder: string | null): boolean {
  const r = trimSlash(resolve(root));
  return folder === null || (folder !== r && isWithin(folder, r));
}

export class QueueService {
  private readonly db: Database;
  private readonly fs: FsOps;
  private readonly settleMinutes: number;

  constructor(private readonly deps: QueueServiceDeps) {
    this.db = deps.db;
    this.fs = deps.fs ?? nodeFsOps;
    this.settleMinutes = deps.settleMinutes ?? SETTLE_MINUTES;
  }

  /**
   * Queues a file (one job) or a folder (one job per media file under it) as one run, pinned to
   * the workflow's current version. Files that cannot be processed now are `skipped` with the
   * reason; files this version already finished are `already_processed` unless `force`. A real
   * run that names no workflow (the library's feeder decides: "Scan now", an automatic scan) is a
   * `library` run, held to the library's run hours; anything else is `manual` and starts at once.
   */
  async queue(input: QueueInput): Promise<QueueResult> {
    const check = await checkPath(this.db, input.path, this.fs);
    if (!check.ok) return { kind: 'path-rejected', reason: check.reason };
    const { library, realPath } = check;
    // A file or folder in the recycle folder (or a replace tmp) is never queued.
    if (isRecycleOrTemp(realPath, library)) {
      return { kind: 'path-rejected', reason: 'in recycle folder' };
    }

    const workflowId = input.workflowId ?? findFeeder(this.db, library.id)?.workflowId ?? null;
    if (workflowId === null) return { kind: 'no-feeding-workflow' };
    // A fast refusal; the version is resolved again inside the transaction below, since a person
    // may activate or deactivate while the folder is being listed.
    const early = this.resolveWorkflow(workflowId, input.dryRun, input.workflowVersion);
    if (early.kind !== 'ok') return early;

    let st: Stats;
    try {
      st = await this.fs.stat(realPath);
    } catch (err) {
      return { kind: 'path-rejected', reason: this.statFailure(err) };
    }
    if (input.fileOnly && st.isDirectory()) return { kind: 'path-rejected', reason: 'not a file' };
    let paths: string[];
    if (st.isDirectory()) {
      try {
        paths = await listMediaFiles(realPath, library, this.fs);
      } catch (err) {
        return { kind: 'path-rejected', reason: this.statFailure(err) };
      }
    } else {
      paths = [realPath];
    }

    const testEncode =
      input.dryRun &&
      (input.testEncode === true || (input.testEncode === 'if-single-file' && !st.isDirectory()));

    const now = this.deps.now();
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const p of paths) {
      const c = await this.candidate(p, p === realPath ? check : null, library, now);
      // Two names for one file (a symlink to a sibling): one job.
      if (seen.has(c.path)) continue;
      seen.add(c.path);
      candidates.push(c);
    }

    const { db } = this;
    const written = db.transaction(() => {
      const workflow = this.resolveWorkflow(workflowId, input.dryRun, input.workflowVersion);
      if (workflow.kind !== 'ok') return workflow;
      const run = insertRun(
        db,
        {
          id: randomUUID(),
          libraryId: library.id,
          workflowId,
          workflowVersion: workflow.version,
          requestedPath: realPath,
          dryRun: workflow.dryRun,
          testEncode,
          note: workflow.note,
          force: input.force,
          createdBy: input.createdBy,
          source: input.workflowId === undefined && !workflow.dryRun ? 'library' : 'manual',
        },
        now,
      );
      const jobs = candidates.map((c) => {
        let state: JobState = 'queued';
        let reason: string | null = null;
        let fileId: string | null = null;
        if (c.skip !== null) {
          state = 'skipped';
          reason = c.skip;
        } else {
          const prior = input.force
            ? null
            : findFinalRealResult(db, fingerprintKey(c.fp), workflowId, workflow.version);
          if (prior) {
            state = 'already_processed';
            reason = alreadyProcessedReason(prior);
          }
          // Recorded for an already-processed file too: the run summary shows its size.
          const file = upsertFile(
            db,
            { libraryId: library.id, path: c.path, fingerprint: c.fp, lastProbe: null },
            now,
          );
          fileId = file.id;
        }
        return insertJob(
          db,
          {
            id: randomUUID(),
            runId: run.id,
            libraryId: library.id,
            fileId,
            path: c.path,
            workflowId,
            workflowVersion: workflow.version,
            dryRun: workflow.dryRun,
            testEncode,
            state,
            priority: input.priority,
            reason,
          },
          now,
        );
      });
      return { kind: 'queued' as const, run, jobs };
    })();
    if (written.kind !== 'queued') return written;
    const { run, jobs } = written;

    this.deps.events.publish({ type: 'run.changed', runId: run.id });
    this.deps.onQueued();
    return { kind: 'queued', run, jobs };
  }

  /** Creates a library at the realpath of an existing directory that no other root nests with. */
  async createLibrary(
    input: LibraryInput,
  ): Promise<
    LibraryRow | { kind: 'path-invalid'; reason: string } | { kind: 'overlaps'; other: LibraryRow }
  > {
    let real: string;
    try {
      real = await this.fs.realpath(resolve(input.path));
      if (!(await this.fs.stat(real)).isDirectory()) {
        return { kind: 'path-invalid', reason: 'not a directory' };
      }
    } catch (err) {
      return { kind: 'path-invalid', reason: this.statFailure(err) };
    }
    const recycleFolder = this.recycleFolderFor(real, input.recycleFolder ?? null);
    if (!recycleFolderFits(real, recycleFolder)) {
      return { kind: 'path-invalid', reason: RECYCLE_FOLDER_OUTSIDE };
    }
    for (const other of listLibraries(this.db)) {
      const roots = new Set([trimSlash(resolve(other.path))]);
      const otherReal = await realpathOrNull(this.fs, other.path);
      if (otherReal !== null) roots.add(otherReal);
      for (const root of roots) {
        if (isWithin(real, root) || isWithin(root, real)) return { kind: 'overlaps', other };
      }
    }
    return insertLibrary(
      this.db,
      {
        id: randomUUID(),
        name: input.name,
        path: real,
        recycleFolder,
        processHardlinked: input.processHardlinked ?? false,
        verifyFullDecode: input.verifyFullDecode ?? false,
        runHours: input.runHours ?? null,
      },
      this.deps.now(),
    );
  }

  /** Patches a live library; null when it is missing or deleted. */
  updateLibrary(
    id: string,
    patch: LibraryPatch,
  ): LibraryRow | null | { kind: 'path-invalid'; reason: string } {
    const library = findLibrary(this.db, id);
    if (!library || library.deletedAt !== null) return null;
    const next: LibraryPatch = { ...patch };
    if (patch.recycleFolder !== undefined) {
      next.recycleFolder = this.recycleFolderFor(library.path, patch.recycleFolder);
      if (!recycleFolderFits(library.path, next.recycleFolder)) {
        return { kind: 'path-invalid', reason: RECYCLE_FOLDER_OUTSIDE };
      }
    }
    const updated = updateLibrary(this.db, id, next, this.deps.now());
    // New run hours may let held jobs start now, or move the scheduler's wake-up.
    if (updated && patch.runHours !== undefined) this.deps.onQueued();
    return updated;
  }

  /**
   * "Retry failed": every failed real job whose file has no newer job goes back to the queue in its
   * own run, as one more attempt (its own log), on the version active when it starts. A job left
   * with a replace journal is not touched: the startup sweep settles it. Wakes the scheduler.
   */
  retryFailed(): { retried: number } {
    const rows = this.db
      .prepare(
        `SELECT j.id, j.attempt FROM jobs j
         WHERE j.state = 'failed' AND j.dry_run = 0
           AND NOT EXISTS (SELECT 1 FROM jobs n WHERE n.path = j.path AND n.queued_at > j.queued_at)`,
      )
      .all() as { id: string; attempt: number }[];
    const now = this.deps.now();
    let retried = 0;
    for (const { id, attempt } of rows) {
      if (hasReplaceJournal(this.db, id)) continue;
      const row = updateJob(
        this.db,
        id,
        {
          state: 'queued',
          attempt: attempt + 1,
          reason: null,
          lane: null,
          progress: null,
          paused: false,
          finishedAt: null,
        },
        now,
      );
      if (row) retried += 1;
    }
    if (retried > 0) this.deps.onQueued();
    return { retried };
  }

  /** Soft-deletes a library; `busy` while any of its jobs is active. */
  deleteLibrary(id: string): 'ok' | 'not-found' | 'busy' {
    const library = findLibrary(this.db, id);
    if (!library || library.deletedAt !== null) return 'not-found';
    const active = this.db
      .prepare(`SELECT 1 FROM jobs WHERE library_id = ? AND state IN (${ACTIVE_SQL}) LIMIT 1`)
      .get(id);
    if (active !== undefined) return 'busy';
    return softDeleteLibrary(this.db, id, this.deps.now()) ? 'ok' : 'not-found';
  }

  /** A run with its counts and every file; null when unknown. */
  runSummary(runId: string): RunDetail | null {
    const run = findRun(this.db, runId);
    if (!run) return null;
    const rows = this.db
      .prepare(
        `SELECT j.id AS jobId, j.path AS filePath, j.state AS state, j.reason AS reason,
           COALESCE(r.before_bytes,
             CASE WHEN j.state = 'already_processed' THEN f.size_bytes END) AS beforeBytes,
           r.after_bytes AS afterBytes, r.replaced_to AS replacedTo,
           j.workflow_version AS workflowVersion, j.dry_run AS dryRun,
           r.estimated_bytes AS estimatedBytes, r.plan AS plan
         FROM jobs j LEFT JOIN job_results r ON r.job_id = j.id
           LEFT JOIN files f ON f.id = j.file_id
         WHERE j.run_id = ? ORDER BY j.rowid`,
      )
      .all(runId) as (Omit<RunFile, 'fileName' | 'planSummary' | 'dependsOnSize'> & {
      dryRun: number;
      plan: string | null;
    })[];
    return {
      ...this.summarize(run),
      files: rows.map((r) => {
        // Dry runs only: the stored plan, parsed once for the summary and the size-gate outcome.
        const plan = r.dryRun !== 0 && r.plan !== null ? (JSON.parse(r.plan) as JobPlan) : null;
        return {
          jobId: r.jobId,
          fileName: basename(r.filePath),
          filePath: r.filePath,
          state: r.state,
          reason: r.reason,
          beforeBytes: r.beforeBytes,
          afterBytes: r.afterBytes,
          replacedTo: r.replacedTo,
          workflowVersion: r.workflowVersion,
          estimatedBytes: r.dryRun !== 0 ? r.estimatedBytes : null,
          planSummary: plan ? planSummary(plan) : null,
          dependsOnSize: r.state === 'dry_run' ? (plan?.dependsOnSize ?? null) : null,
        };
      }),
    };
  }

  /** Newest first. */
  listRuns(limit: number): RunSummary[] {
    return listRuns(this.db, { limit }).map((run) => this.summarize(run));
  }

  /**
   * One folder of a library for the file picker: sub-folders and media files, names sorted.
   * `relPath` is relative to the root ('' is the root); it must stay under the root after
   * symlinks are resolved, and the recycle folder and tmp files are hidden.
   */
  async browse(
    libraryId: string,
    relPath: string,
  ): Promise<BrowseResult | BrowseRejection | 'not-found'> {
    const rejected = (reason: BrowseRejection['reason']): BrowseRejection => ({
      kind: 'path-rejected',
      reason,
    });
    const library = findLibrary(this.db, libraryId);
    if (!library || library.deletedAt !== null) return 'not-found';
    if (isAbsolute(relPath)) return rejected('outside library root');
    const root = await realpathOrNull(this.fs, library.path);
    if (root === null) return 'not-found';
    const target = resolve(root, relPath);
    if (!isWithin(target, root)) return rejected('outside library root');
    const check = await checkPath(this.db, target, this.fs);
    if (!check.ok) return check.reason === 'not found' ? 'not-found' : rejected(check.reason);
    if (check.library.id !== libraryId) return rejected('symlink escapes root');
    if (isRecycleOrTemp(check.realPath, check.library)) return rejected('in recycle folder');
    const dir = check.realPath;
    let entries: Awaited<ReturnType<FsOps['readdir']>>;
    try {
      if (!(await this.fs.stat(dir)).isDirectory()) return 'not-found';
      entries = await this.fs.readdir(dir);
    } catch (err) {
      const why = this.statFailure(err);
      return why === 'not found' ? 'not-found' : rejected(why);
    }

    const result: BrowseResult = { dirs: [], files: [] };
    for (const e of entries) {
      const full = join(dir, e.name);
      if (isRecycleOrTemp(full, check.library)) continue;
      let st: Stats;
      try {
        if (e.isSymbolicLink()) {
          const link = await checkPath(this.db, full, this.fs);
          if (
            !link.ok ||
            link.library.id !== libraryId ||
            isRecycleOrTemp(link.realPath, link.library)
          ) {
            continue;
          }
          st = await this.fs.stat(link.realPath);
        } else {
          st = await this.fs.stat(full);
        }
      } catch {
        continue; // vanished or unreadable: not offered
      }
      if (st.isDirectory()) result.dirs.push(e.name);
      else if (st.isFile() && isMediaFile(e.name)) {
        result.files.push({ name: e.name, sizeBytes: st.size, mtime: st.mtime.toISOString() });
      }
    }
    result.dirs.sort();
    result.files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return result;
  }

  // ---- internals ----

  /**
   * The version the run is pinned to and whether it is a dry run. Real: the active version (never
   * another one when it cannot run); with nothing active, a dry run of the newest. Dry: the chosen
   * version, default the newest.
   */
  private resolveWorkflow(
    id: string,
    askedDryRun: boolean,
    askedVersion: number | undefined,
  ):
    | { kind: 'ok'; version: number; dryRun: boolean; note: string | null }
    | { kind: 'workflow-missing' }
    | { kind: 'version-missing' }
    | { kind: 'workflow-invalid'; issues: Issue[] } {
    const row = findWorkflow(this.db, id);
    if (row?.kind !== 'workflow') return { kind: 'workflow-missing' };
    let version = row.currentVersion;
    let dryRun = true;
    let note: string | null = null;
    if (askedDryRun) {
      version = askedVersion ?? row.currentVersion;
    } else if (row.activeVersion === null) {
      note = 'no active version';
    } else {
      version = row.activeVersion;
      dryRun = false;
    }
    const loaded = this.deps.workflows.loadForRun(id, version);
    if (loaded.kind === 'missing') return { kind: 'version-missing' };
    if (loaded.kind === 'invalid') return { kind: 'workflow-invalid', issues: loaded.issues };
    return { kind: 'ok', version, dryRun, note };
  }

  /** A configured recycle folder, absolute (a relative one is under the root). */
  private recycleFolderFor(root: string, folder: string | null): string | null {
    return folder === null ? null : trimSlash(resolve(root, folder));
  }

  private statFailure(err: unknown): 'not found' | 'unreadable' | 'path too long' {
    const code = errorCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'not found';
    if (code === 'ENAMETOOLONG') return 'path too long';
    if (code !== undefined && DENIED.has(code)) return 'unreadable';
    throw err;
  }

  private async candidate(
    listed: string,
    known: PathCheck | null,
    library: LibraryRow,
    now: Date,
  ): Promise<Candidate> {
    const check = known ?? (await checkPath(this.db, listed, this.fs));
    if (!check.ok) {
      // A file that vanished between the listing and now cannot be read.
      return { path: listed, skip: check.reason === 'not found' ? 'unreadable' : check.reason };
    }
    const path = check.realPath;
    if (check.library.id !== library.id) return { path: listed, skip: 'symlink escapes root' };
    if (isRecycleOrTemp(path, library)) return { path, skip: 'in recycle folder' };
    if (!isMediaFile(path)) return { path, skip: 'not media' };
    let fp: Fingerprint;
    let st: Stats;
    try {
      st = await this.fs.stat(path);
      fp = fingerprintFromStats(st);
      if (st.isFile()) await this.fs.canRead(path);
    } catch {
      return { path, skip: 'unreadable' };
    }
    const skip = skipReasonFor(fp, st, library, now, this.settleMinutes);
    return skip === null ? { path, skip: null, fp } : { path, skip };
  }

  private summarize(run: RunRow): RunSummary {
    return {
      run,
      counts: runCounts(this.db, run.id),
      workflowName: findWorkflow(this.db, run.workflowId, { includeDeleted: true })?.name ?? '',
      libraryName: findLibrary(this.db, run.libraryId)?.name ?? '',
    };
  }
}
