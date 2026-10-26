// Kept test-encode outputs: a verified output of a test-encode dry run, moved under
// `<transcodeDir>/test-outputs/<jobId>.<ext>` and registered in `test_outputs` until `kept_until`.
// The retention setting, the scratch-space margin and the sweeps decide how long each one stays.
// An mkv output played in the browser gets a cached mp4 beside it, `<jobId>.preview.mp4`, built on
// first play and deleted with the output.
import nodeFs from 'node:fs';
import { join } from 'node:path';
import { TEST_ENCODE_KEEP_HOURS_MAX } from '@transcoda/contract';
import type { JobPlan } from '@transcoda/shared';
import { z } from 'zod';
import type { Config } from '../config.ts';
import type { Database } from '../db/open.ts';
import { getSetting, SETTING_DEFAULTS, SETTING_KEYS } from '../db/repos/settings.ts';
import type { Logger } from '../logger.ts';
import { errorCode, type FsOps } from './fs-ops.ts';
import { buildPreview, MAX_PREVIEW_BUILDS } from './preview.ts';

/** The folder under the transcode dir that holds the kept outputs (the startup sweep skips it). */
export const TEST_OUTPUT_DIR = 'test-outputs';
/** How often the server sweeps expired and stray test outputs (besides every engine start). */
export const TEST_OUTPUT_SWEEP_MS = 3_600_000;

/** Why a job's test output was not kept or is gone before its time (`jobs.test_output_note`). */
export const TEST_OUTPUT_NOTES = {
  scratchLow: 'not kept: scratch space low',
  retentionZero: 'not kept: test encodes are kept for 0 hours',
  deleted: 'deleted',
  expired: 'expired',
  missing: 'deleted: file missing',
  evicted: 'deleted: scratch space was needed',
} as const;

const GIB = 1024 ** 3;

/**
 * The free space the transcode dir must keep: the deep health's scratch minimum, never below 5 GiB.
 * Shared by the deep health and the test-output space guard.
 */
export function scratchMinFreeBytes(config: Pick<Config, 'healthMinFreeGiB'>): number {
  return Math.max(5, config.healthMinFreeGiB) * GIB;
}

export interface TestOutputRow {
  jobId: string;
  fileName: string;
  container: 'mkv' | 'mp4';
  sizeBytes: number;
  createdAt: string;
  keptUntil: string;
}

/** An open, checked regular file; the caller closes `fd`. */
export interface OpenedFile {
  fd: number;
  size: number;
}

/** What {@link TestOutputStore.preview} gives: the preview opened, or why not. */
export type PreviewResult =
  | ({ kind: 'ready' } & OpenedFile)
  | { kind: 'missing' }
  | { kind: 'busy' }
  | { kind: 'scratchLow' }
  | { kind: 'failed' };

type BuildOutcome = 'built' | 'missing' | 'scratchLow' | 'failed';

const previewName = (jobId: string): string => `${jobId}.preview.mp4`;
const PART = '.part';

export interface TestOutputStoreDeps {
  db: Database;
  fs: FsOps;
  config: Pick<Config, 'transcodeDir' | 'healthMinFreeGiB'>;
  now(): Date;
  log: Logger;
}

interface DbRow {
  job_id: string;
  file_name: string;
  container: 'mkv' | 'mp4';
  size_bytes: number;
  created_at: string;
  kept_until: string;
}

const toRow = (r: DbRow): TestOutputRow => ({
  jobId: r.job_id,
  fileName: r.file_name,
  container: r.container,
  sizeBytes: r.size_bytes,
  createdAt: r.created_at,
  keptUntil: r.kept_until,
});

const closeQuietly = (fd: number): void => {
  try {
    nodeFs.closeSync(fd);
  } catch {
    // already closed
  }
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const KEEP_HOURS = z.number().int().min(0).max(TEST_ENCODE_KEEP_HOURS_MAX);

export class TestOutputStore {
  /** Preview builds running now, by job id: concurrent plays of one job await the same build. */
  private readonly building = new Map<string, Promise<BuildOutcome>>();

  constructor(private readonly deps: TestOutputStoreDeps) {}

  /** `<transcodeDir>/test-outputs`. */
  get dir(): string {
    return join(this.deps.config.transcodeDir, TEST_OUTPUT_DIR);
  }

  /**
   * Keeps a verified output for the retention time: moved under the test-output dir and registered.
   * Retention 0 or too little scratch space left afterwards: the output is deleted and the job says
   * why. Never throws (a failure is logged and keeps nothing).
   */
  async keep(
    jobId: string,
    outputPath: string,
    container: 'mkv' | 'mp4',
  ): Promise<TestOutputRow | null> {
    const { db, fs, log } = this.deps;
    const fileName = `${jobId}.${container}`;
    const target = join(this.dir, fileName);
    try {
      const hours = this.keepHours();
      if (hours === 0) {
        await this.unlinkQuietly(outputPath);
        this.dropRow(jobId);
        this.setNote(jobId, TEST_OUTPUT_NOTES.retentionZero);
        return null;
      }
      await fs.mkdir(this.dir);
      await this.unlinkPreview(jobId);
      await fs.rename(outputPath, target);
      if ((await this.freeBytes()) < scratchMinFreeBytes(this.deps.config)) {
        await this.unlinkQuietly(target);
        this.dropRow(jobId);
        this.setNote(jobId, TEST_OUTPUT_NOTES.scratchLow);
        log.info({ msg: 'test output not kept: scratch space low', job: jobId });
        return null;
      }
      const sizeBytes = (await fs.stat(target)).size;
      const now = this.deps.now();
      const row: TestOutputRow = {
        jobId,
        fileName,
        container,
        sizeBytes,
        createdAt: now.toISOString(),
        keptUntil: new Date(now.getTime() + hours * 3_600_000).toISOString(),
      };
      db.transaction(() => {
        db.prepare(
          `INSERT INTO test_outputs (job_id, file_name, container, size_bytes, created_at, kept_until)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(job_id) DO UPDATE SET file_name = excluded.file_name,
             container = excluded.container, size_bytes = excluded.size_bytes,
             created_at = excluded.created_at, kept_until = excluded.kept_until`,
        ).run(row.jobId, row.fileName, row.container, row.sizeBytes, row.createdAt, row.keptUntil);
        this.setNote(jobId, null);
      })();
      log.info({ msg: 'test output kept', job: jobId, keptUntil: row.keptUntil });
      return row;
    } catch (err) {
      log.warn({ msg: 'test output could not be kept', job: jobId, error: message(err) });
      await this.unlinkQuietly(target);
      try {
        this.dropRow(jobId);
        this.setNote(jobId, `not kept: ${message(err)}`);
      } catch (dbErr) {
        log.warn({
          msg: 'could not note a test output not kept',
          job: jobId,
          error: message(dbErr),
        });
      }
      return null;
    }
  }

  find(jobId: string): TestOutputRow | null {
    const r = this.deps.db.prepare('SELECT * FROM test_outputs WHERE job_id = ?').get(jobId) as
      | DbRow
      | undefined;
    return r ? toRow(r) : null;
  }

  /** Why the job's test output was not kept or went early; null when nothing to say. */
  note(jobId: string): string | null {
    const r = this.deps.db.prepare('SELECT test_output_note FROM jobs WHERE id = ?').get(jobId) as
      | { test_output_note: string | null }
      | undefined;
    return r?.test_output_note ?? null;
  }

  /**
   * Opens the kept file for reading: the path comes from the row only, opened with O_NOFOLLOW and
   * checked on the open fd (a symlink, a directory or a FIFO in its place is refused). Past
   * `kept_until` it is null and the output is removed as expired (the hourly sweep may not have run
   * yet). The caller owns the fd and closes it.
   */
  open(jobId: string): { fd: number; size: number; row: TestOutputRow } | null {
    const row = this.find(jobId);
    if (!row || row.fileName !== `${row.jobId}.${row.container}`) return null;
    if (Date.parse(row.keptUntil) <= this.deps.now().getTime()) {
      this.expireNow(row);
      return null;
    }
    const opened = this.openRegular(join(this.dir, row.fileName));
    return opened ? { ...opened, row } : null;
  }

  /** The job's built preview, opened and checked like {@link open}; null when there is none. */
  openPreview(jobId: string): OpenedFile | null {
    return this.openRegular(join(this.dir, previewName(jobId)));
  }

  /**
   * Where the job's preview stands, without building it (a HEAD): `ready` (built), `building`,
   * `busy` (a play now would be refused: MAX_PREVIEW_BUILDS are running), `scratchLow` (a play
   * now would be refused for space), else `none` (a play would build it).
   */
  async previewState(
    jobId: string,
    outputSize: number,
  ): Promise<'ready' | 'building' | 'busy' | 'scratchLow' | 'none'> {
    if (this.building.has(jobId)) return 'building';
    const built = this.openPreview(jobId);
    if (built) {
      closeQuietly(built.fd);
      return 'ready';
    }
    if (this.building.size >= MAX_PREVIEW_BUILDS) return 'busy';
    try {
      const free = await this.freeBytes();
      if (free < scratchMinFreeBytes(this.deps.config) + outputSize) return 'scratchLow';
    } catch {
      // unknown: a play finds out
    }
    return 'none';
  }

  /**
   * The mkv output's preview, built on first use: `<jobId>.preview.mp4` through a `.part` file,
   * ffmpeg reading `source` (an {@link open} result, whose fd this takes over and closes). Plays
   * of one job share one build; at most MAX_PREVIEW_BUILDS run at once (`busy`). A build needs
   * the scratch margin plus the output's size free (`scratchLow`); a failed one is logged at warn
   * and leaves nothing behind (`failed`); one whose output went meanwhile is deleted (`missing`).
   */
  async preview(
    jobId: string,
    source: { fd: number; size: number; row: TestOutputRow },
    o: { ffmpegPath: string; plan: JobPlan | null },
  ): Promise<PreviewResult> {
    const ready = (): PreviewResult => {
      const opened = this.openPreview(jobId);
      return opened ? { kind: 'ready', ...opened } : { kind: 'missing' };
    };
    let pending = this.building.get(jobId);
    if (!pending) {
      const cached = this.openPreview(jobId);
      if (cached) {
        closeQuietly(source.fd);
        return { kind: 'ready', ...cached };
      }
      if (this.building.size >= MAX_PREVIEW_BUILDS) {
        closeQuietly(source.fd);
        return { kind: 'busy' };
      }
      pending = this.build(jobId, source, o).finally(() => this.building.delete(jobId));
      this.building.set(jobId, pending);
    } else {
      closeQuietly(source.fd);
    }
    const outcome = await pending;
    return outcome === 'built' ? ready() : { kind: outcome };
  }

  /** Deletes a kept output (row and file) and notes why; false when the job has none. */
  async remove(jobId: string, why: 'deleted' | 'expired' | 'evicted'): Promise<boolean> {
    const row = this.find(jobId);
    if (!row) return false;
    await this.unlinkQuietly(join(this.dir, row.fileName));
    await this.unlinkPreview(jobId);
    this.deps.db.transaction(() => {
      this.dropRow(jobId);
      this.setNote(jobId, TEST_OUTPUT_NOTES[why]);
    })();
    this.deps.log.info({ msg: 'test output deleted', job: jobId, why });
    return true;
  }

  /**
   * Removes expired outputs, rows whose file is gone, and anything in the dir that is not a
   * registered `<jobId>.<mkv|mp4>` regular file, the `<jobId>.preview.mp4` of a registered mkv, or
   * the `.part` of a preview being built. Never throws; returns how many were removed.
   */
  async sweep(): Promise<number> {
    const { db, fs, log } = this.deps;
    let removed = 0;
    try {
      const nowIso = this.deps.now().toISOString();
      const expired = db
        .prepare('SELECT job_id FROM test_outputs WHERE kept_until <= ? ORDER BY created_at')
        .all(nowIso) as { job_id: string }[];
      for (const { job_id } of expired) {
        if (await this.remove(job_id, 'expired')) removed += 1;
      }

      const registered = new Set(
        this.rows().flatMap((r) =>
          r.container === 'mkv' ? [r.fileName, previewName(r.jobId)] : [r.fileName],
        ),
      );
      const entries = (await fs.exists(this.dir)) ? await fs.readdir(this.dir) : [];
      for (const e of entries) {
        const p = join(this.dir, e.name);
        try {
          // Checked per entry: a build may start while the sweep runs.
          if (this.isBuildPart(e.name)) continue;
          if (registered.has(e.name) && (await fs.lstat(p)).isFile()) continue;
          await fs.rm(p, { recursive: true });
          log.info({ msg: 'stray test output removed', name: e.name });
          removed += 1;
        } catch (err) {
          log.warn({
            msg: 'could not remove a stray test output',
            name: e.name,
            error: message(err),
          });
        }
      }

      for (const row of this.rows()) {
        if (await fs.exists(join(this.dir, row.fileName))) continue;
        await this.unlinkPreview(row.jobId);
        db.transaction(() => {
          this.dropRow(row.jobId);
          this.setNote(row.jobId, TEST_OUTPUT_NOTES.missing);
        })();
        log.info({ msg: 'test output deleted', job: row.jobId, why: 'missing' });
        removed += 1;
      }
    } catch (err) {
      log.warn({ msg: 'test output sweep failed', error: message(err) });
    }
    return removed;
  }

  /**
   * Before a real job encodes: while the transcode dir has less free space than the margin, the
   * oldest kept output is deleted. Never throws (a real job is never held up by kept outputs).
   */
  async makeRoom(): Promise<number> {
    let removed = 0;
    try {
      const min = scratchMinFreeBytes(this.deps.config);
      for (;;) {
        const oldest = this.deps.db
          .prepare('SELECT job_id FROM test_outputs ORDER BY created_at, job_id LIMIT 1')
          .get() as { job_id: string } | undefined;
        if (!oldest) break;
        if ((await this.freeBytes()) >= min) break;
        if (!(await this.remove(oldest.job_id, 'evicted'))) break;
        removed += 1;
      }
    } catch (err) {
      this.deps.log.warn({ msg: 'could not make room in scratch space', error: message(err) });
    }
    return removed;
  }

  // ---- internals ----

  /**
   * Drops an expired row and notes it at once (so nothing serves it again), then deletes the file
   * in the background (unlinkQuietly never throws; a leftover is a stray for the next sweep).
   */
  private expireNow(row: TestOutputRow): void {
    this.deps.db.transaction(() => {
      this.dropRow(row.jobId);
      this.setNote(row.jobId, TEST_OUTPUT_NOTES.expired);
    })();
    this.deps.log.info({ msg: 'test output deleted', job: row.jobId, why: 'expired' });
    void this.unlinkQuietly(join(this.dir, row.fileName));
    void this.unlinkPreview(row.jobId);
  }

  /** One preview build (see {@link preview}); never throws. */
  private async build(
    jobId: string,
    source: { fd: number; size: number; row: TestOutputRow },
    o: { ffmpegPath: string; plan: JobPlan | null },
  ): Promise<BuildOutcome> {
    const target = join(this.dir, previewName(jobId));
    const part = target + PART;
    // Still the output this build started from (not removed, expired or replaced meanwhile).
    const current = () => {
      const row = this.find(jobId);
      return (
        row?.createdAt === source.row.createdAt &&
        Date.parse(row.keptUntil) > this.deps.now().getTime()
      );
    };
    let started = false;
    try {
      const free = await this.freeBytes();
      if (free < scratchMinFreeBytes(this.deps.config) + source.size) {
        this.deps.log.info({ msg: 'test output preview refused: scratch space low', job: jobId });
        return 'scratchLow';
      }
      await this.unlinkQuietly(part);
      started = true;
      await buildPreview({
        ffmpegPath: o.ffmpegPath,
        input: nodeFs.createReadStream('', { fd: source.fd, autoClose: true }),
        outPath: part,
        plan: o.plan,
      });
      if (!current()) {
        await this.unlinkQuietly(part);
        return 'missing';
      }
      await this.deps.fs.rename(part, target);
      if (!current()) {
        await this.unlinkQuietly(target);
        return 'missing';
      }
      return 'built';
    } catch (err) {
      this.deps.log.warn({
        msg: 'test output preview failed',
        job: jobId,
        error: message(err).split('\n')[0],
      });
      await this.unlinkQuietly(part);
      return current() ? 'failed' : 'missing';
    } finally {
      if (!started) closeQuietly(source.fd);
    }
  }

  /** Opens `p` with O_NOFOLLOW and checks the fd: a regular file, or null (nothing left open). */
  private openRegular(p: string): OpenedFile | null {
    const { constants } = nodeFs;
    let fd: number;
    try {
      fd = nodeFs.openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      return null;
    }
    try {
      const info = nodeFs.fstatSync(fd);
      if (info.isFile()) return { fd, size: info.size };
    } catch {
      // closed below
    }
    nodeFs.closeSync(fd);
    return null;
  }

  /** True when `name` is the `.part` of a preview being built now. */
  private isBuildPart(name: string): boolean {
    if (!name.endsWith(`.preview.mp4${PART}`)) return false;
    return this.building.has(name.slice(0, -`.preview.mp4${PART}`.length));
  }

  /** Deletes the job's preview and any `.part` of it; never throws. */
  private async unlinkPreview(jobId: string): Promise<void> {
    const p = join(this.dir, previewName(jobId));
    await this.unlinkQuietly(p);
    await this.unlinkQuietly(p + PART);
  }

  private rows(): TestOutputRow[] {
    return (this.deps.db.prepare('SELECT * FROM test_outputs').all() as DbRow[]).map(toRow);
  }

  /** The retention setting in hours; the default when the row is missing or not a valid value. */
  private keepHours(): number {
    try {
      return (
        getSetting(this.deps.db, SETTING_KEYS.testEncodeKeepHours, KEEP_HOURS) ??
        SETTING_DEFAULTS.testEncodeKeepHours
      );
    } catch {
      return SETTING_DEFAULTS.testEncodeKeepHours;
    }
  }

  private async freeBytes(): Promise<number> {
    const target = (await this.deps.fs.exists(this.dir)) ? this.dir : this.deps.config.transcodeDir;
    const { bavail, bsize } = await this.deps.fs.statfs(target);
    return bavail * bsize;
  }

  private dropRow(jobId: string): void {
    this.deps.db.prepare('DELETE FROM test_outputs WHERE job_id = ?').run(jobId);
  }

  private setNote(jobId: string, note: string | null): void {
    this.deps.db.prepare('UPDATE jobs SET test_output_note = ? WHERE id = ?').run(note, jobId);
  }

  private async unlinkQuietly(p: string): Promise<void> {
    try {
      await this.deps.fs.unlink(p);
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return;
      this.deps.log.warn({ msg: 'could not delete a test output', path: p, code: errorCode(err) });
    }
  }
}
