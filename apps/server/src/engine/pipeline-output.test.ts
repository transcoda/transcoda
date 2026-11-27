import { mkdir, readFile, rename, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProbeResult } from '@transcoda/sdk';
import type { JobState } from '@transcoda/shared';
import { describe, expect, it, vi } from 'vitest';
import { fingerprintKey } from '../db/repos/files.ts';
import { findJobResult, hasReplaceJournal, listRecycled } from '../db/repos/jobs.ts';
import { nodeFsOps } from '../platform/fs-ops.ts';
import { node } from '../workflows/test-helpers.ts';
import type { RunnerProcess, SpawnOptions } from './encode/process.ts';
import { fingerprintOf } from './files/fingerprint.ts';
import { contentHash } from './media/content-hash.ts';
import { classifyErrorLine, sourceDecoderNames } from './media/decoder-names.ts';
import { modelFromProbe } from './model/model.ts';
import { renderEncoders } from './model/render.ts';
import {
  base,
  configDir,
  encodeAnd,
  execCalls,
  execSignals,
  fake,
  faultOnce,
  ffprobeJson,
  file,
  fsOps,
  lib,
  line,
  listAll,
  moveCopy,
  published,
  queue,
  replaceNode,
  root,
  row,
  runOnce,
  serverLog,
  settled,
  setup,
  spawner,
  states,
  t,
  toH264,
  transcodeDir,
  until,
  workflow,
} from './pipeline-test-harness.ts';
import { probeOf, withStream } from './test-helpers.ts';

describe('pipeline: the verified output probe (before/after)', () => {
  const toReplace = () =>
    workflow(line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')));
  const outputOf = (id: string) => findJobResult(t.db, id)?.outputProbe as ProbeResult | null;

  it('a real run keeps the probe verify read of its output with the result; the job detail shows it without the raw JSON', async () => {
    const id = await queue(file(), toReplace());
    expect(await runOnce(id)).toMatchObject({ state: 'done' });
    expect(outputOf(id)).toMatchObject({
      container: 'mkv',
      sizeBytes: 600,
      streams: [
        { index: 0, type: 'video', codec: 'h264' },
        { index: 1, type: 'audio', codec: 'aac' },
      ],
    });
    // Stored without the raw ffprobe JSON (nothing reads it), with each stream's tag bitrate.
    expect(outputOf(id)).not.toHaveProperty('raw');
    expect(outputOf(id)?.streams[0]).toHaveProperty('tagBitrateKbps', null);
    const detail = t.deps.engine.jobDetail(id);
    expect(detail?.outputProbe).toMatchObject({ container: 'mkv', sizeBytes: 600 });
    expect(detail?.outputProbe).not.toHaveProperty('raw');
    expect(detail?.outputProbe?.streams[0]).toMatchObject({ codec: 'h264', tagBitrateKbps: null });
  });

  it('the job detail reads a whole ProbeResult the first builds stored, without its raw JSON', async () => {
    const id = await queue(file(), toReplace());
    expect(await runOnce(id)).toMatchObject({ state: 'done' });
    const legacy = { ...fake.outputProbe, raw: ffprobeJson(fake.outputProbe) };
    t.db
      .prepare('UPDATE job_results SET output_probe = ? WHERE job_id = ?')
      .run(JSON.stringify(legacy), id);
    const detail = t.deps.engine.jobDetail(id);
    expect(detail?.outputProbe).not.toHaveProperty('raw');
    expect(detail?.outputProbe?.streams[0]).toMatchObject({ codec: 'h264', tagBitrateKbps: null });
  });

  it('a test-encode keeps it too', async () => {
    const id = await queue(file(), toReplace(), { dryRun: true, testEncode: true });
    expect(await runOnce(id)).toMatchObject({ state: 'dry_run' });
    expect(outputOf(id)).toMatchObject({ sizeBytes: 600, streams: [{ codec: 'h264' }, {}] });
  });

  it('a size gate that keeps the original keeps the probe of what it measured', async () => {
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        toH264(),
        node('sg', 'core:size-gate', { minSavingPercent: 50 }),
        node('ro', 'core:replace-original'),
      ),
    );
    const id = await queue(file(), wf);
    expect(await runOnce(id, 900)).toMatchObject({ state: 'kept_original' });
    expect(outputOf(id)).toMatchObject({ container: 'mkv', streams: [{ codec: 'h264' }, {}] });
  });

  it('a plan-only dry run has none', async () => {
    const id = await queue(file(), toReplace(), { dryRun: true, testEncode: false });
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'dry_run' });
    expect(outputOf(id)).toBeNull();
    expect(t.deps.engine.jobDetail(id)?.outputProbe).toBeNull();
  });

  it('a job that fails after its output passed verify keeps none: that output was thrown away', async () => {
    const id = await queue(file(), toReplace());
    await t.deps.engine.start();
    const touch = async (n: number) => {
      const when = new Date(Date.now() - n * 60_000);
      await utimes(file(), when, when);
    };
    await until('first spawn', () => spawner.calls.length === 1);
    await touch(10);
    await spawner.complete({ bytes: 600 });
    await until('second spawn', () => spawner.calls.length === 2);
    await touch(20);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'failed', failureCode: 'source_changed' });
    expect(outputOf(id)).toBeNull();
  });

  it('a job whose output failed verify has none', async () => {
    fake.brokenOutput = true;
    const id = await queue(file(), toReplace());
    await t.deps.engine.start();
    await until('first spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('second spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'failed', failureCode: 'verify' });
    expect(outputOf(id)).toBeNull();
  });
});

describe('pipeline: fix round (review)', () => {
  it('CRIT: a move-copy failure after the replace never retries: done with the failure as a warning', async () => {
    await mkdir(join(base, 'out', 'Show'), { recursive: true });
    await writeFile(join(base, 'out', 'Show', 'a.mkv'), 'taken');
    const id = await queue(file(), encodeAnd(replaceNode(), moveCopy()));
    const job = await runOnce(id);
    expect(job).toMatchObject({ state: 'done', attempt: 1 });
    expect(job.reason).toMatch(/^finished with a problem: move-copy: .*a\.mkv already exists$/);
    expect(findJobResult(t.db, id)).toMatchObject({ afterBytes: 600, replacedTo: 'recycle' });
    expect(findJobResult(t.db, id)?.warnings).toContain(
      job.reason?.replace('finished with a problem: ', ''),
    );
    expect(spawner.calls).toHaveLength(1);
    expect((await stat(file())).size).toBe(600);
  });

  it('I4: a move-copy failure before anything was written fails (final), the original untouched', async () => {
    await mkdir(join(base, 'out', 'Show'), { recursive: true });
    await writeFile(join(base, 'out', 'Show', 'a.mkv'), 'taken');
    const id = await queue(file(), encodeAnd(moveCopy(), replaceNode()));
    const job = await runOnce(id);
    expect(job).toMatchObject({ state: 'failed', failureCode: 'replace', attempt: 1 });
    expect(job.reason).toMatch(/^move-copy: .*a\.mkv already exists$/);
    expect((await stat(file())).size).toBe(1000);
    expect(await readFile(join(base, 'out', 'Show', 'a.mkv'), 'utf8')).toBe('taken');
  });

  it('I4: move-copy copies the result under the output root (original untouched); move removes the temp output, an unlink error is reported', async () => {
    const id = await queue(file(), encodeAnd(moveCopy()));
    expect(await runOnce(id)).toMatchObject({ state: 'done', reason: null });
    expect((await stat(join(base, 'out', 'Show', 'a.mkv'))).size).toBe(600);
    expect((await stat(file())).size).toBe(1000);
    expect(await listAll(join(base, 'out'))).toEqual(['/Show', '/Show/a.mkv']);
    // The copy is the written file: its fingerprint, not the untouched original's.
    expect(findJobResult(t.db, id)?.outputFingerprint).toBe(
      fingerprintKey(await fingerprintOf(join(base, 'out', 'Show', 'a.mkv'))),
    );
    expect(findJobResult(t.db, id)).toMatchObject({
      sourceHash: await contentHash(file()),
      outputHash: await contentHash(join(base, 'out', 'Show', 'a.mkv')),
    });

    await t.deps.engine.stop();
    await setup({ fs: faultOnce(fsOps, 'unlink', (p) => p.endsWith('/out.mkv'), 'EACCES') });
    await writeFile(join(root, 'Show', 'b.mkv'), Buffer.alloc(1000, 7));
    const id2 = await queue(join(root, 'Show', 'b.mkv'), encodeAnd(moveCopy('move')));
    const job = await runOnce(id2);
    expect(job.state).toBe('done');
    expect(findJobResult(t.db, id2)?.warnings).toEqual([
      expect.stringMatching(/^move-copy: could not remove the moved output .*out\.mkv: injected$/),
    ]);
    expect((await stat(join(base, 'out', 'Show', 'b.mkv'))).size).toBe(600);
  });

  it('I4: an output root that is not configured fails the job before anything is written', async () => {
    const wf = encodeAnd(moveCopy());
    const id = await queue(file(), wf);
    // The root is no longer configured when the job starts (the version is re-validated then).
    t.deps.config.outputRoots.length = 0;
    await t.deps.engine.start();
    const job = await settled(id);
    expect(job.state).toBe('failed');
    expect(job.failureCode).toBe('workflow');
    expect(job.reason).toMatch(/output root|workflow invalid/);
    expect(await listAll(join(base, 'out'))).toEqual([]);
  });

  it('an encoded job gives up the encoder: the next file encodes while the first is verified', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held = false;
    fake.execHook = async (_file, args) => {
      // Hold the first job's verify at its first read of the output.
      if (!held && (args.at(-1) as string).startsWith(transcodeDir)) {
        held = true;
        await gate;
      }
      return null;
    };
    const second = join(root, 'Show', 'b.mkv');
    await nodeFsOps.copyFile(file(), second);
    const wf = encodeAnd(replaceNode());
    const a = await queue(file(), wf);
    const b = await queue(second, wf);
    await t.deps.engine.start();
    await until('first spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    // The first is verifying (held): the other gets the encoder meanwhile. Both prepare at once
    // and the slot goes to whichever is ready first, so either may be first.
    await until('second spawn while the first verifies', () => held && spawner.calls.length === 2);
    expect([row(a).state, row(b).state].sort()).toEqual(['encoding', 'verifying']);
    release();
    await spawner.complete({ bytes: 600 });
    expect(await settled(a)).toMatchObject({ state: 'done' });
    expect(await settled(b)).toMatchObject({ state: 'done' });
  });

  it('a verify failure after the encoder was given up retries in a slot of its own: it waits for the next file to finish encoding', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held = false;
    fake.execHook = async (_file, args) => {
      if (!held && (args.at(-1) as string).startsWith(transcodeDir)) {
        held = true;
        await gate;
      }
      return null;
    };
    const second = join(root, 'Show', 'b.mkv');
    await nodeFsOps.copyFile(file(), second);
    const wf = encodeAnd(replaceNode());
    const ids = [await queue(file(), wf), await queue(second, wf)];
    await t.deps.engine.start();
    await until('first spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('second spawn while the first verifies', () => held && spawner.calls.length === 2);
    const first = ids.find((id) => row(id).state === 'verifying') as string;
    const next = ids.find((id) => id !== first) as string;
    // The first's output fails verify: it is queued again, but the slot is the other's.
    fake.brokenOutput = true;
    release();
    await until(
      'first retried',
      () => row(first).attempt === 2 && row(first).state !== 'verifying',
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(spawner.calls).toHaveLength(2);
    expect(t.deps.engine.scheduler.status().lanes.encode).toBe(next);
    expect(row(next).state).toBe('encoding');
    // The other finishes encoding: the retry takes the slot back and encodes again.
    fake.brokenOutput = false;
    await spawner.complete({ bytes: 600 });
    await until('third spawn', () => spawner.calls.length === 3);
    expect(row(first)).toMatchObject({ state: 'encoding', attempt: 2 });
    await spawner.complete({ bytes: 600 });
    expect(await settled(first)).toMatchObject({ state: 'done', attempt: 2 });
    expect(await settled(next)).toMatchObject({ state: 'done', attempt: 1 });
  });

  it('I4: a cancel while move-copy writes removes its tmp and ends cancelled', async () => {
    await t.deps.engine.stop();
    let id = '';
    await setup({
      fs: {
        ...fsOps,
        copyFile: async (src, dst) => {
          await nodeFsOps.copyFile(src, dst);
          if (dst.includes(`${base}/out/`)) t.deps.engine.scheduler.cancelJob(id);
        },
      },
    });
    id = await queue(file(), encodeAnd(moveCopy()));
    expect(await runOnce(id)).toMatchObject({ state: 'cancelled' });
    expect(await listAll(join(base, 'out'))).toEqual(['/Show']);
  });

  it('I1: each attempt writes its own log, truncated at start; the in-pass check sees only this attempt', async () => {
    const id = await queue(file(), encodeAnd(replaceNode()));
    // A stale log of attempt 1 from an earlier run of this job.
    await mkdir(join(configDir, 'logs', 'jobs'), { recursive: true });
    await writeFile(join(configDir, 'logs', 'jobs', `${id}.attempt-1.log`), 'stale\n');
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600, stderr: ['[out#0/matroska @ 0x1] [error] write error'] });
    await until('second spawn', () => spawner.calls.length === 2);
    // While attempt 2 runs, the log shown is attempt 2's (empty so far).
    expect(await t.deps.engine.jobLog(id)).toBe('');
    await spawner.complete({ bytes: 600, stderr: ['[libx264 @ 0x1] [warning] fine'] });
    expect(await settled(id)).toMatchObject({ state: 'done', attempt: 2 });
    const [one, two] = spawner.calls.map((c) => c.logPath);
    expect(one).toBe(join(configDir, 'logs', 'jobs', `${id}.attempt-1.log`));
    expect(two).toBe(join(configDir, 'logs', 'jobs', `${id}.attempt-2.log`));
    expect(await readFile(one as string, 'utf8')).toBe(
      '[out#0/matroska @ 0x1] [error] write error\n',
    );
    expect(await readFile(two as string, 'utf8')).toBe('[libx264 @ 0x1] [warning] fine\n');
    expect(findJobResult(t.db, id)?.logPath).toBe(two);
    expect(await t.deps.engine.jobLog(id)).toBe('[libx264 @ 0x1] [warning] fine\n');
  });

  it('I3: a replace failing while installing settles at once: the replacement is installed, done with a warning', async () => {
    await t.deps.engine.stop();
    const fs = faultOnce(fsOps, 'link', (_a, b) => b === file());
    await setup({ fs });
    const id = await queue(file(), encodeAnd(replaceNode()));
    const job = await runOnce(id);
    expect(fs.fired()).toBe(true);
    expect(job).toMatchObject({ state: 'done', attempt: 1, replaceJournal: null });
    expect(job.reason).toBe(
      'finished with a problem: replace: installing_tmp: injected; recovered: the replacement is installed',
    );
    expect((await stat(file())).size).toBe(600);
    expect((await stat(join(root, '.transcoda-recycle', 'Show', 'a.mkv'))).size).toBe(1000);
    expect(listRecycled(t.db)).toHaveLength(1);
    expect(await listAll(join(root, 'Show'))).toEqual(['/a.mkv']);
  });

  it('final I3: an unexpected throw after the replace ends done with the problem, not failed', async () => {
    await t.deps.engine.stop();
    let installed = false;
    const plain = fsOps;
    await setup({
      fs: {
        ...plain,
        link: async (a, b) => {
          await plain.link(a, b);
          if (b === file()) installed = true;
        },
        // The second replace's path check meets an I/O error it does not know (rethrown).
        lstat: async (p) => {
          if (installed && p === file())
            throw Object.assign(new Error('injected'), { code: 'EIO' });
          return plain.lstat(p);
        },
      },
    });
    const id = await queue(file(), encodeAnd(replaceNode(), node('ro2', 'core:replace-original')));
    const job = await runOnce(id);
    expect(installed).toBe(true);
    expect(job).toMatchObject({ state: 'done', attempt: 1 });
    expect(job.reason).toBe('finished with a problem: internal error: injected');
    expect(findJobResult(t.db, id)).toMatchObject({
      outcome: 'done',
      afterBytes: 600,
      replacedTo: 'recycle',
    });
    expect(findJobResult(t.db, id)?.warnings).toContain('internal error: injected');
    expect((await stat(file())).size).toBe(600);
    expect(spawner.calls).toHaveLength(1);
  });

  it('final M1/M2: a pause during verify holds the job before the replace until resumed; the final state clears paused', async () => {
    const id = await queue(file(), encodeAnd(replaceNode()));
    let paused = false;
    fake.execHook = async () => {
      // The first verify call: pause the job (no process attached, so nothing is frozen).
      if (!paused && row(id).state === 'verifying') {
        paused = true;
        expect(t.deps.engine.scheduler.pauseJob(id)).toBe('ok');
      }
      return null;
    };
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('paused in verify', () => paused && row(id).paused);
    // Verify finishes, then the job waits: nothing is replaced while it is paused.
    await new Promise((r) => setTimeout(r, 300));
    expect(row(id)).toMatchObject({ state: 'verifying', paused: true });
    expect((await stat(file())).size).toBe(1000);
    expect(t.deps.engine.scheduler.resumeJob(id)).toBe('ok');
    expect(await settled(id)).toMatchObject({ state: 'done', paused: false });
    expect((await stat(file())).size).toBe(600);
  });

  it('final M1: a final state written while paused clears paused (cancel of a paused queued job)', async () => {
    const id = await queue(file(), encodeAnd(replaceNode()));
    expect(t.deps.engine.scheduler.pauseJob(id)).toBe('ok');
    expect(row(id).paused).toBe(true);
    expect(t.deps.engine.scheduler.cancelJob(id)).toBe('ok');
    expect(row(id)).toMatchObject({ state: 'cancelled', paused: false });
  });

  it('I3: a replace failing after the original was linked to the recycle folder settles at once: original in place, failed, not retried', async () => {
    await t.deps.engine.stop();
    const fs = faultOnce(fsOps, 'unlink', (p) => p === file());
    await setup({ fs });
    const id = await queue(file(), encodeAnd(replaceNode()));
    const job = await runOnce(id);
    expect(fs.fired()).toBe(true);
    expect(job).toMatchObject({
      state: 'failed',
      failureCode: 'replace',
      attempt: 1,
      replaceJournal: null,
    });
    expect(job.reason).toBe('replace: moving_original: injected; nothing was replaced');
    expect((await stat(file())).size).toBe(1000);
    expect(await listAll(join(root, 'Show'))).toEqual(['/a.mkv']);
    expect(await listAll(join(root, '.transcoda-recycle'))).toEqual(['/Show']);
    expect(spawner.calls).toHaveLength(1);
  });

  it('I5: a replace failure the settle cannot decide (library unreachable) keeps its journal; failed, not retried', async () => {
    await t.deps.engine.stop();
    const plain = fsOps;
    const fault = faultOnce(plain, 'unlink', (p) => p === file());
    await setup({
      fs: {
        ...fault,
        exists: async (p) => (fault.fired() && p === root ? false : plain.exists(p)),
      },
    });
    const id = await queue(file(), encodeAnd(replaceNode()));
    const job = await runOnce(id);
    expect(job).toMatchObject({ state: 'failed', failureCode: 'replace', attempt: 1 });
    expect(job.reason).toBe(`library root unavailable: ${root}`);
    expect(hasReplaceJournal(t.db, id)).toBe(true);
    expect(spawner.calls).toHaveLength(1);
  });

  it('I5: a shutdown after the replacement tmp is written still records the completed replace as done', async () => {
    await t.deps.engine.stop();
    let stopping: Promise<void> | null = null;
    await setup({
      fs: {
        ...fsOps,
        copyFile: async (src, dst) => {
          if (dst.endsWith('.tmp') && !stopping) stopping = t.deps.engine.stop();
          return nodeFsOps.copyFile(src, dst);
        },
      },
    });
    const id = await queue(file(), encodeAnd(replaceNode()));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('stop called', () => stopping !== null);
    await stopping;
    expect(row(id)).toMatchObject({ state: 'done', replaceJournal: null });
    expect((await stat(file())).size).toBe(600);
  });

  it('I5: a cancel while the replace waits for space ends cancelled; nothing moved, no journal', async () => {
    await t.deps.engine.stop();
    await setup({ fs: { ...fsOps, statfs: async () => ({ bavail: 1, bsize: 4096 }) } });
    const id = await queue(file(), encodeAnd(replaceNode()));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('replacing', () => row(id).state === 'replacing');
    await until('journal', () => hasReplaceJournal(t.db, id));
    t.deps.engine.scheduler.cancelJob(id);
    expect(await settled(id)).toMatchObject({ state: 'cancelled', replaceJournal: null });
    expect((await stat(file())).size).toBe(1000);
    expect(await listAll(join(root, 'Show'))).toEqual(['/a.mkv']);
  });

  it('C4: a replace waiting for space says so on the job, in job.changed, in the log and in deep health', async () => {
    await t.deps.engine.stop();
    await setup({ fs: { ...fsOps, statfs: async () => ({ bavail: 1, bsize: 4096 }) } });
    const id = await queue(file(), encodeAnd(replaceNode()));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('waiting', () => row(id).reason !== null);
    expect(row(id)).toMatchObject({
      state: 'replacing',
      reason: `waiting for 5.00 GB free on ${lib.path} (4.10 kB free)`,
    });
    const changed = published.filter((e) => e.type === 'job.changed' && e.jobId === id).at(-1);
    expect(changed).toMatchObject({ state: 'replacing', reason: row(id).reason });
    expect(t.deps.engine.spaceWaits.list()).toMatchObject([{ jobId: id, path: lib.path }]);
    expect(serverLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'replace waits for free space', job: id }),
    );
    expect((await t.deps.health.deep()).queue).toBe('fail');
    t.deps.engine.scheduler.cancelJob(id);
    expect(await settled(id)).toMatchObject({ state: 'cancelled' });
    expect(t.deps.engine.spaceWaits.list()).toEqual([]);
    expect(serverLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'replace stopped waiting for free space', job: id }),
    );
  });

  it('C4: recording a space wait that throws is a log line; the replace still waits and ends as it would', async () => {
    await t.deps.engine.stop();
    await setup({ fs: { ...fsOps, statfs: async () => ({ bavail: 1, bsize: 4096 }) } });
    vi.spyOn(t.deps.engine.spaceWaits, 'set').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    const id = await queue(file(), encodeAnd(replaceNode()));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('warned', () =>
      vi
        .mocked(serverLog.warn)
        .mock.calls.some(
          ([e]) => (e as { msg?: string }).msg === 'could not record the wait for free space',
        ),
    );
    expect(row(id).state).toBe('replacing');
    t.deps.engine.scheduler.cancelJob(id);
    expect(await settled(id)).toMatchObject({ state: 'cancelled' });
  });

  it('I5: a file moved out of the root between encode and replace fails the job (final); nothing written outside', async () => {
    const id = await queue(file(), encodeAnd(replaceNode()));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    const away = join(base, 'outside', 'Show');
    await rename(join(root, 'Show'), away);
    await symlink(away, join(root, 'Show'));
    const outsideBefore = await listAll(join(base, 'outside'));
    await spawner.complete({ bytes: 600 });
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', failureCode: 'source_changed', attempt: 1 });
    expect(job.reason).toBe('file moved before the replace: symlink escapes root');
    expect(await listAll(join(base, 'outside'))).toEqual(outsideBefore);
  });

  it('I5: ffmpeg that cannot start is retried once', async () => {
    await t.deps.engine.stop();
    await setup();
    let broken = true;
    const real = spawner.spawn.bind(spawner);
    spawner.spawn = (f: string, a: string[], o: SpawnOptions): RunnerProcess => {
      if (!broken) return real(f, a, o);
      broken = false;
      const done = Promise.reject(
        Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }),
      );
      done.catch(() => {});
      return { pid: -1, pause() {}, resume() {}, kill() {}, done };
    };
    const id = await queue(file(), encodeAnd(replaceNode()));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'done', attempt: 2 });
    expect(states(id)).toContain('queued');
  });

  it('I5: a library with verifyFullDecode decodes the whole output before the replace', async () => {
    expect(t.deps.engine.queue.updateLibrary(lib.id, { verifyFullDecode: true })).toMatchObject({
      verifyFullDecode: true,
    });
    const id = await queue(file(), encodeAnd(replaceNode()));
    expect(await runOnce(id)).toMatchObject({ state: 'done' });
    const out = join(transcodeDir, id, 'out.mkv');
    const whole = execCalls.filter(
      (c) => c[0] === 'ffmpeg' && c.includes(out) && !c.includes('-ss') && !c.includes('-t'),
    );
    expect(whole).toHaveLength(1);
  });

  it('C3: a cancel during verify aborts its ffmpeg runs and ends cancelled; a shutdown aborts them and writes nothing', async () => {
    fake.execHook = async (file, args, signal) => {
      if (file !== 'ffmpeg' || !args.includes('-ss')) return null;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    const id = await queue(file(), encodeAnd(replaceNode()));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    await until('verify hangs', () =>
      execCalls.some((c) => c[0] === 'ffmpeg' && c.includes('-ss')),
    );
    t.deps.engine.scheduler.cancelJob(id);
    expect(await settled(id)).toMatchObject({ state: 'cancelled' });
    expect(execSignals.some((s) => s?.aborted)).toBe(true);

    await writeFile(join(root, 'Show', 'b.mkv'), Buffer.alloc(1000, 7));
    execCalls.length = 0;
    const id2 = await queue(join(root, 'Show', 'b.mkv'), encodeAnd(replaceNode()));
    await until('spawn 2', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 600 });
    await until('verify hangs', () =>
      execCalls.some((c) => c[0] === 'ffmpeg' && c.includes('-ss')),
    );
    const before = row(id2);
    await t.deps.engine.stop();
    expect(row(id2)).toEqual(before);
    expect(before.state).toBe('verifying');
  });

  it('C3: a cancel during cover extraction aborts it', async () => {
    fake.sourceProbe = probeOf(
      [
        { type: 'video', codec: 'h264', default: true },
        { type: 'video', codec: 'png', attachedPic: true },
      ],
      { container: 'mp4', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', sizeBytes: 1000 },
    );
    let seen: AbortSignal | undefined;
    fake.execHook = async (_file, args, signal) => {
      if (!args.includes('image2')) return null;
      seen = signal;
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
      throw new Error('aborted');
    };
    await writeFile(join(root, 'Show', 'c.mp4'), Buffer.alloc(1000, 7));
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        node('rm', 'core:remux', { container: 'mkv' }),
        replaceNode(),
      ),
    );
    const id = await queue(join(root, 'Show', 'c.mp4'), wf);
    await t.deps.engine.start();
    await until('extracting', () => seen !== undefined);
    t.deps.engine.scheduler.cancelJob(id);
    expect(await settled(id)).toMatchObject({ state: 'cancelled' });
    expect(seen?.aborted).toBe(true);
    expect(spawner.calls).toEqual([]);
  });

  it('currentNode is the node at work, the one a failure is traced on: Render while encoding and verifying, Replace original while replacing', async () => {
    const id = await queue(file(), encodeAnd(replaceNode()));
    await runOnce(id);
    const at = (state: JobState) =>
      published.find((e) => e.type === 'job.changed' && e.jobId === id && e.state === state);
    expect(at('encoding')).toMatchObject({ currentNode: { workflowPath: [], nodeId: 'render-1' } });
    expect(at('verifying')).toMatchObject({ currentNode: { nodeId: 'render-1' } });
    expect(at('replacing')).toMatchObject({ currentNode: { workflowPath: [], nodeId: 'ro' } });
  });

  it('verify progress: each check is published while verifying, filling by checks done', async () => {
    const id = await queue(file(), encodeAnd(replaceNode()));
    await runOnce(id);
    const verifying = published.flatMap((e) =>
      e.type === 'job.changed' && e.jobId === id && e.state === 'verifying' ? [e.progress] : [],
    );
    expect(verifying[0]).toBeNull();
    const checks = verifying.flatMap((p) => (p?.verify ? [p.verify] : []));
    expect(checks.length).toBeGreaterThan(2);
    const total = checks[0]?.total ?? 0;
    expect(checks.at(0)).toEqual({ stage: 'checks', done: 1, total });
    expect(checks.at(-1)).toEqual({ stage: 'checks', done: total, total });
    expect(verifying.at(-1)?.percent).toBe(100);
    const replacing = published.find(
      (e) => e.type === 'job.changed' && e.jobId === id && e.state === 'replacing',
    );
    expect(replacing).toMatchObject({ progress: null });
  });

  it('minor: a NUMBER_OF_FRAMES tag that disagrees is a warning, not a failure', async () => {
    fake.execHook = async (_file, args) => {
      if (!args.includes('-show_format') || (args.at(-1) as string).startsWith(transcodeDir)) {
        return null;
      }
      const json = ffprobeJson(fake.sourceProbe) as { streams: Record<string, unknown>[] };
      (json.streams[0] as Record<string, unknown>).tags = { NUMBER_OF_FRAMES: '1440' };
      return { stdout: JSON.stringify(json), stderr: '' };
    };
    const id = await queue(file(), encodeAnd(replaceNode()));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    spawner.emitProgress({ outTimeSeconds: 60, speed: 1, fps: 24, sizeBytes: 600, frames: 700 });
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'done' });
    expect(findJobResult(t.db, id)?.warnings).toEqual([
      'encode wrote 700 video frames; the source tag NUMBER_OF_FRAMES says 1440',
    ]);
  });

  it('minor: a replace refused at its checking step is final (no retry)', async () => {
    const id = await queue(file(), encodeAnd(replaceNode()));
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    // Something takes the replace's tmp name beside the original (after the startup sweep).
    await writeFile(join(root, 'Show', `.transcoda-${id}.tmp`), 'not ours');
    await spawner.complete({ bytes: 600 });
    const job = await settled(id);
    expect(job).toMatchObject({
      state: 'failed',
      failureCode: 'replace',
      attempt: 1,
      replaceJournal: null,
    });
    expect(job.reason).toMatch(/^replace: checking: .*\.tmp already exists$/);
    expect(spawner.calls).toHaveLength(1);
    expect((await stat(file())).size).toBe(1000);
  });

  it('minor: a node recycle folder outside the library root fails the job before anything moves', async () => {
    const id = await queue(
      file(),
      encodeAnd(replaceNode({ recycleFolder: join(base, 'outside', 'bin') })),
    );
    const job = await runOnce(id);
    expect(job).toMatchObject({ state: 'failed', failureCode: 'replace', attempt: 1 });
    expect(job.reason).toBe(
      `replace: recycle folder ${join(base, 'outside', 'bin')} is outside the library root ${root}`,
    );
    expect(await listAll(join(base, 'outside'))).toEqual([]);
    expect((await stat(file())).size).toBe(1000);
  });

  it('C4: error lines are classified per message family', () => {
    const codecs = new Set(['h264', 'hevc', 'aac']);
    const cases: [string, 'source' | 'demuxer' | 'output'][] = [
      ['[in#0/matroska,webm @ 0x1] [error] 0x00 at pos 300606 invalid as first byte', 'demuxer'],
      ['[h264 @ 0x1] [error] error while decoding MB 15 10', 'source'],
      ['[hevc @ 0x1] [error] Could not find ref with POC 21', 'source'],
      [
        '[vist#0:0/h264 @ 0x1] [dec:h264 @ 0x2] [error] Error submitting packet to decoder',
        'source',
      ],
      ['[aist#0:1/aac @ 0x1] [error] Error while decoding stream', 'source'],
      ['[dec:hevc @ 0x1] [error] Decoding error: Invalid data found', 'source'],
      ['[libx264 @ 0x1] [error] malloc of size 1 failed', 'output'],
      ['[vost#0:0/libx265 @ 0x1] [error] Error while encoding', 'output'],
      ['[out#0/matroska @ 0x1] [error] Error writing trailer: No space left on device', 'output'],
      ['[matroska @ 0x1] [error] Error writing packet', 'output'],
      ['[aac @ 0x1] [error] Too many bits per frame requested', 'output'],
      ['[error] Conversion failed!', 'output'],
    ];
    for (const [line, side] of cases) {
      // aac is also an encoder of this job: a bare [aac @ …] is the output's.
      expect([line, classifyErrorLine(line, codecs, new Set(['libx264', 'aac']))]).toEqual([
        line,
        side,
      ]);
    }
    expect(classifyErrorLine('[h264 @ 0x1] [warning] something', codecs, new Set())).toBeNull();
  });

  it("x265's CPU mask error (no NUMA nodes, as in Docker Desktop) is not an output error", () => {
    const encoders = new Set(['libx265']);
    const codecs = sourceDecoderNames(['h264']);
    expect(
      classifyErrorLine('x265 [error]: Failed to genrate CPU mask', codecs, encoders),
    ).toBeNull();
    expect(
      classifyErrorLine('x265 [error]: Failed to generate CPU mask', codecs, encoders),
    ).toBeNull();
    expect(classifyErrorLine('x265 [error]: unable to open input file', codecs, encoders)).toBe(
      'output',
    );
  });

  it('a dca decoder line is a source error when the source has a dts stream', () => {
    const codecs = sourceDecoderNames(['dts', 'hevc']);
    expect(
      classifyErrorLine(
        '[dca @ 0x55d0] [error] Invalid LFE scale factor index',
        codecs,
        new Set(['libx264']),
      ),
    ).toBe('source');
  });

  it('an srt encoder line is the output’s even when the source has a subrip stream', () => {
    const source = probeOf([
      { type: 'video', codec: 'hevc', default: true },
      { type: 'subtitle', codec: 'subrip', language: 'eng' },
      { type: 'subtitle', codec: 'mov_text', language: 'ger' },
    ]);
    const model = withStream(modelFromProbe(source), 2, { mode: 'convert', codec: 'subrip' });
    const encoders = renderEncoders(model);
    expect(encoders.has('srt')).toBe(true);
    const codecs = sourceDecoderNames(source.streams.map((s) => s.codec));
    for (const line of [
      '[srt @ 0x55d0] [error] Subtitle encoding failed',
      '[sost#0:2/srt @ 0x55d1] [error] Error while encoding',
    ]) {
      expect([line, classifyErrorLine(line, codecs, encoders)]).toEqual([line, 'output']);
    }
  });

  it('an error from an extra input (a sidecar) is never the source’s', () => {
    const codecs = sourceDecoderNames(['hevc', 'subrip']);
    for (const line of [
      '[in#1/srt @ 0x1] [error] Invalid data found when processing input',
      '[sist#1:0/subrip @ 0x1] [error] Error while decoding stream',
    ]) {
      expect([line, classifyErrorLine(line, codecs, new Set())]).toEqual([line, 'output']);
    }
    expect(
      classifyErrorLine('[sist#0:2/subrip @ 0x1] [error] Error while decoding', codecs, new Set()),
    ).toBe('source');
  });
});
