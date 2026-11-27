import { mkdir, readFile, rename, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../../capabilities/ffmpeg.ts';
import { findJobResult } from '../../db/repos/jobs/jobs.ts';
import { node } from '../../workflows/test-helpers.ts';
import { probeOf } from '../testing/builders.ts';
import { coverFailure, coverTimeoutMs } from './encode.ts';
import {
  base,
  execCalls,
  fake,
  fakeExec,
  ffprobeJson,
  file,
  lib,
  line,
  listAll,
  queue,
  restartWith,
  root,
  row,
  settled,
  setup,
  spawner,
  states,
  t,
  toH264,
  transcodeDir,
  until,
  workflow,
} from './testing.ts';

describe('pipeline', () => {
  describe('the encode stall guard (60 ms on the test clock)', () => {
    const wf = () =>
      workflow(
        line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
      );
    /** Moves the test clock past the limit with no output growth, and lets the guard tick. */
    const stall = async () => {
      t.clock.advance(70);
      await new Promise((r) => setTimeout(r, 50));
    };

    it('no output ever: ffmpeg is stopped and the job fails at once with the stuck-stream reason', async () => {
      await t.deps.engine.stop();
      await setup({ encodeStallMinutes: 0.001 });
      const id = await queue(file(), wf());
      await t.deps.engine.start();
      await until('spawn', () => spawner.calls.length === 1);
      await stall();
      const job = await settled(id);
      expect(spawner.signals).toEqual(['SIGKILL']);
      expect(spawner.calls).toHaveLength(1);
      expect(job).toMatchObject({ state: 'failed', failureCode: 'encode', attempt: 1 });
      expect(job.reason).toMatch(
        /^ffmpeg wrote no output for 0\.001 minutes and was stopped\. .*could not get started/,
      );
      expect((await stat(file())).size).toBe(1000);
    });

    it('output that grows keeps it running; output that then stops is retried with a neutral reason', async () => {
      await t.deps.engine.stop();
      await setup({ encodeStallMinutes: 0.001 });
      const id = await queue(file(), wf());
      await t.deps.engine.start();
      await until('spawn', () => spawner.calls.length === 1);
      for (let i = 1; i <= 3; i += 1) {
        t.clock.advance(50);
        spawner.emitProgress({ outTimeSeconds: i, speed: 1, fps: 25, sizeBytes: 100 * i });
        await new Promise((r) => setTimeout(r, 30));
      }
      expect(spawner.signals).toEqual([]);
      await stall();
      await until('second spawn', () => spawner.calls.length === 2);
      expect(row(id)).toMatchObject({ attempt: 2 });
      spawner.emitProgress({ outTimeSeconds: 1, speed: 1, fps: 25, sizeBytes: 100 });
      await stall();
      const job = await settled(id);
      expect(job).toMatchObject({ state: 'failed', failureCode: 'encode', attempt: 2 });
      expect(job.reason).toMatch(
        /^ffmpeg stopped writing output for 0\.001 minutes and was stopped/,
      );
      expect((await stat(file())).size).toBe(1000);
    });
  });

  it('an encode whose ffmpeg reports no out time (ffmpeg 8, a copied image track) shows progress by its frames', async () => {
    fake.sourceProbe = {
      ...fake.sourceProbe,
      streams: fake.sourceProbe.streams.map((s) =>
        s.type === 'video' ? { ...s, frameRate: 24 } : s,
      ),
    };
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    spawner.emitProgress({
      outTimeSeconds: null,
      speed: 2,
      fps: 48,
      sizeBytes: 300,
      frames: 720,
    });
    expect(row(id).progress).toMatchObject({ percent: 50, outTimeSeconds: 30, etaSeconds: 15 });
    await spawner.complete({ bytes: 600 });
    expect((await settled(id)).state).toBe('done');
  });
});

describe('pipeline: controller notes', () => {
  it('a folder swapped for a symlink out of the root between queue and start → skipped, nothing written outside', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    const away = join(base, 'outside', 'Show');
    await rename(join(root, 'Show'), away);
    await symlink(away, join(root, 'Show'));
    const outsideBefore = await listAll(join(base, 'outside'));
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'skipped', reason: 'symlink escapes root' });
    expect(spawner.calls).toEqual([]);
    expect(await listAll(join(base, 'outside'))).toEqual(outsideBefore);
    expect(await listAll(transcodeDir)).toEqual([]);
  });

  it('a library removed between queue and start → skipped "outside library root"', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    // Soft-delete directly (deleteLibrary refuses while a job is queued).
    t.db.prepare('UPDATE libraries SET deleted_at = ? WHERE id = ?').run('2026-01-01', lib.id);
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'skipped', reason: 'outside library root' });
    expect(spawner.calls).toEqual([]);
  });

  it('a file still growing at job start is skipped "still growing" (no immediate requeue)', async () => {
    await t.deps.engine.stop();
    await setup({ settleMinutes: 3 });
    // Times relative to the test clock.
    const hourAgo = new Date(t.clock.now().getTime() - 60 * 60 * 1000);
    await utimes(file(), hourAgo, hourAgo);
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    const fresh = t.clock.now();
    await utimes(file(), fresh, fresh);
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({
      state: 'skipped',
      reason: 'still growing',
      requeues: 0,
    });
    expect(states(id)).toEqual(['probing', 'skipped']);
    expect(spawner.calls).toEqual([]);
  });

  it('a source decoder error mid-encode that the source reproduces at that spot → kept_original, no retry', async () => {
    fake.sourceSpotsDamaged = true;
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({
      bytes: 600,
      at: 30,
      stderr: [
        '[hevc @ 0x1234] [error] Could not find ref with POC 3',
        '[libx264 @ 0x9] [warning] x',
      ],
    });
    expect(await settled(id)).toMatchObject({
      state: 'kept_original',
      reason: 'source has decode errors; nothing was replaced',
      attempt: 1,
    });
    expect(findJobResult(t.db, id)?.warnings).toEqual([
      '[hevc @ 0x1234] [error] Could not find ref with POC 3',
      expect.stringMatching(
        /^decode-sample: source: decoding 7 s from 29\.00s failed: \[h264 @ 0x1\] error while decoding/,
      ),
    ]);
    // The confirming decode read the source around the spot (from a second before it).
    const spot = execCalls.find(
      (c) => c[0] === 'ffmpeg' && c.includes('-ss') && c.join(' ').includes(` -i ${root}`),
    );
    expect(spot?.[spot.indexOf('-ss') + 1]).toBe('29.000');
    expect(spawner.calls).toHaveLength(1);
    expect((await stat(file())).size).toBe(1000);
  });

  it('without an out time, a source decoder error is placed by the frames written, not at 0', async () => {
    fake.sourceSpotsDamaged = true;
    fake.sourceProbe = {
      ...fake.sourceProbe,
      streams: fake.sourceProbe.streams.map((s) =>
        s.type === 'video' ? { ...s, frameRate: 25 } : s,
      ),
    };
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({
      bytes: 600,
      at: 30,
      noOutTime: true,
      stderr: ['[hevc @ 0x1234] [error] Could not find ref with POC 3'],
    });
    expect(await settled(id)).toMatchObject({ state: 'kept_original' });
    const spot = execCalls.find(
      (c) => c[0] === 'ffmpeg' && c.includes('-ss') && c.join(' ').includes(` -i ${root}`),
    );
    expect(spot?.[spot.indexOf('-ss') + 1]).toBe('29.000');
  });

  it('without an out time or a frame rate, a source decoder error is ignored with a warning', async () => {
    fake.sourceSpotsDamaged = true;
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({
      bytes: 600,
      noOutTime: true,
      stderr: ['[hevc @ 0x1234] [error] Could not find ref with POC 3'],
    });
    expect(await settled(id)).toMatchObject({ state: 'done' });
    expect(findJobResult(t.db, id)?.warnings).toContain(
      'ignored 1 decoder error(s): ffmpeg reported no output time to place them by',
    );
  });

  it('a dca decoder error mid-encode on a dts source that the source reproduces → kept_original, no retry', async () => {
    fake.sourceSpotsDamaged = true;
    fake.sourceProbe = probeOf(
      [
        { type: 'video', codec: 'hevc', default: true },
        { type: 'audio', codec: 'dts', language: 'eng', default: true },
      ],
      { sizeBytes: 1000 },
    );
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({
      bytes: 600,
      at: 30,
      stderr: ['[dca @ 0x55d0] [error] Invalid LFE scale factor index'],
    });
    expect(await settled(id)).toMatchObject({
      state: 'kept_original',
      reason: 'source has decode errors; nothing was replaced',
      attempt: 1,
    });
    expect(spawner.calls).toHaveLength(1);
  });

  it('a source decoder error mid-encode the source does not reproduce is output-invalid: retried once, then failed', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    const stderr = ['[hevc @ 0x1234] [error] Could not find ref with POC 3'];
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600, stderr });
    await until('second spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 600, stderr });
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', failureCode: 'encode', attempt: 2 });
    expect(job.reason).toMatch(
      /^encode reported source decode errors the source does not reproduce: \[hevc/,
    );
  });

  it('decoder errors before the first output frame (a stream cut mid-GOP) are ignored', async () => {
    fake.sourceSpotsDamaged = true;
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({
      bytes: 600,
      leading: [
        '[hevc @ 0x1] [error] Could not find ref with POC 21',
        '[vist#0:0/hevc @ 0x2] [dec:hevc @ 0x3] [error] Error submitting packet to decoder',
      ],
    });
    expect(await settled(id)).toMatchObject({ state: 'done', reason: null });
    expect(findJobResult(t.db, id)?.warnings).toEqual([
      'ignored 2 decoder error(s) before the first output frame',
    ]);
  });

  it('an error from the output side during the encode is retried, then fails', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    const stderr = [
      '[out#0/matroska @ 0x1] [error] Error writing trailer: No space left on device',
    ];
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600, stderr });
    await until('second spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 600, stderr });
    const job = await settled(id);
    expect(job).toMatchObject({ state: 'failed', failureCode: 'encode', attempt: 2 });
    expect(job.reason).toMatch(/^encode reported errors: \[out#0/);
  });

  it('a non-zero ffmpeg exit fails with the log tail as the reason', async () => {
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    const stderr = [...Array.from({ length: 5000 }, () => 'noise'), '[error] Conversion failed!'];
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 0, stderr, code: 1 });
    await until('second spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 0, stderr, code: 1 });
    expect(await settled(id)).toMatchObject({
      state: 'failed',
      failureCode: 'encode',
      reason: 'ffmpeg exited 1: Conversion failed!',
    });
    // jobLog serves only the tail.
    const tail = await t.deps.engine.jobLog(id);
    expect(tail?.length).toBeLessThanOrEqual(64 * 1024);
    expect(tail?.endsWith('[error] Conversion failed!\n')).toBe(true);
  });

  it('a GPU encode that fails runs once more on the software encoder, and says so', async () => {
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        node('ev', 'core:encode-video', { codec: 'h264', encoder: 'h264_nvenc', skipIf: 'never' }),
        node('ro', 'core:replace-original'),
      ),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    expect(spawner.calls[0]?.args).toContain('h264_nvenc');
    await spawner.complete({
      bytes: 0,
      code: 1,
      stderr: [
        '[h264_nvenc @ 0x1] [error] OpenEncodeSessionEx failed: unsupported device (2)',
        '[out#0/matroska @ 0x2] [error] Nothing was written into output file, because at least one of its streams received no packets.',
      ],
    });
    await until('software spawn', () => spawner.calls.length === 2);
    const soft = spawner.calls[1]?.args ?? [];
    expect(soft).toContain('libx264');
    expect(soft).not.toContain('h264_nvenc');
    expect(soft).not.toContain('-hwaccel');
    await spawner.complete({ bytes: 600 });
    const job = await settled(id);
    expect(job.state).toBe('done');
    expect(findJobResult(t.db, id)?.warnings).toEqual([
      'the GPU encode failed (h264_nvenc: OpenEncodeSessionEx failed: unsupported device (2)); encoded in software instead',
    ]);
  });

  it('a model renderArgs refuses → failed "render: …", never retried', async () => {
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        node('bad', 'test:stray-arg'),
        node('ro', 'core:replace-original'),
      ),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({
      state: 'failed',
      failureCode: 'encode',
      reason: 'render: globalArgs has a stray argument "stray"',
      attempt: 1,
    });
  });

  it('an mkv cover is extracted into the temp dir before the encode; a failed extraction fails the job', async () => {
    fake.sourceProbe = probeOf(
      [
        { type: 'video', codec: 'h264', default: true },
        { type: 'audio', codec: 'aac', language: 'eng', default: true },
        { type: 'video', codec: 'png', attachedPic: true },
      ],
      { container: 'mp4', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', sizeBytes: 1000 },
    );
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        node('rm', 'core:remux', { container: 'mkv' }),
        node('ro', 'core:replace-original'),
      ),
    );
    await writeFile(join(root, 'Show', 'c.mp4'), Buffer.alloc(1000, 7));
    const id = await queue(join(root, 'Show', 'c.mp4'), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    const cover = join(transcodeDir, id, 'cover-2.png');
    expect(execCalls.some((c) => c.at(-1) === cover && c.includes('image2'))).toBe(true);
    const args = spawner.calls[0]?.args ?? [];
    expect(args[args.indexOf('-attach') + 1]).toBe(cover);
    expect(row(id).lane).toBe('quick');
    await t.deps.engine.stop();

    fake.coverExtracts = false;
    await setup();
    const wf2 = workflow(
      line(
        node('in', 'core:input-manual'),
        node('rm', 'core:remux', { container: 'mkv' }),
        node('ro', 'core:replace-original'),
      ),
    );
    await writeFile(join(root, 'Show', 'd.mp4'), Buffer.alloc(1000, 7));
    const id2 = await queue(join(root, 'Show', 'd.mp4'), wf2);
    await t.deps.engine.start();
    expect(await settled(id2)).toMatchObject({
      state: 'failed',
      failureCode: 'encode',
      reason: 'render: cover video #2 needs its extracted image file',
    });
    expect(spawner.calls).toEqual([]);
  });

  describe('sidecar subtitle inputs', () => {
    const sidecarWorkflow = (path: string) =>
      workflow(
        line(
          node('in', 'core:input-manual'),
          node('sc', 'test:add-sidecar', { path }),
          node('ro', 'core:replace-original'),
        ),
      );

    it('ffmpeg reads a private copy in the temp dir, never the sidecar in the library', async () => {
      const original = join(root, 'Show', 'a.de.srt');
      await writeFile(original, '1\n00:00:01,000 --> 00:00:02,000\nHallo\n');
      const id = await queue(file(), sidecarWorkflow(original));
      await t.deps.engine.start();
      await until('spawn', () => spawner.calls.length === 1);
      const copy = join(transcodeDir, id, 'sidecar-1.srt');
      const args = spawner.calls[0]?.args ?? [];
      const inputs = args.flatMap((a, i) => (a === '-i' ? [args[i + 1]] : []));
      expect(inputs).toEqual([join(root, 'Show', 'a.mkv'), copy]);
      expect(args[args.indexOf(copy) - 3]).toBe('-f');
      expect(args[args.indexOf(copy) - 2]).toBe('srt');
      expect(args).not.toContain(original);
      expect(await readFile(copy, 'utf8')).toContain('Hallo');
    });

    it('a symlinked sidecar is refused and the job fails before ffmpeg runs', async () => {
      const target = join(base, 'outside', 'secret.srt');
      await writeFile(target, 'secret');
      const link = join(root, 'Show', 'a.de.srt');
      await symlink(target, link);
      const id = await queue(file(), sidecarWorkflow(link));
      await t.deps.engine.start();
      expect(await settled(id)).toMatchObject({
        state: 'failed',
        failureCode: 'encode',
        // The realpath check refuses it first; copyRegular's O_NOFOLLOW still guards a swap after.
        reason:
          'render: subtitle file a.de.srt cannot be used: its path is not a real path in the library',
      });
      expect(spawner.calls).toEqual([]);
    });

    it('a sidecar under a symlinked parent directory is refused before ffmpeg runs', async () => {
      await mkdir(join(base, 'outside', 'subs'));
      await writeFile(join(base, 'outside', 'subs', 'a.de.srt'), 'secret');
      await symlink(join(base, 'outside', 'subs'), join(root, 'Show', 'subs'));
      const id = await queue(file(), sidecarWorkflow(join(root, 'Show', 'subs', 'a.de.srt')));
      await t.deps.engine.start();
      const job = await settled(id);
      expect(job).toMatchObject({
        state: 'failed',
        failureCode: 'encode',
        reason:
          'render: subtitle file a.de.srt cannot be used: its path is not a real path in the library',
      });
      expect(job.reason).not.toContain(base);
      expect(spawner.calls).toEqual([]);
    });

    it('a sidecar outside the library is refused before ffmpeg runs', async () => {
      const outside = join(base, 'outside', 'a.de.srt');
      await writeFile(outside, 'secret');
      const id = await queue(file(), sidecarWorkflow(outside));
      await t.deps.engine.start();
      expect(await settled(id)).toMatchObject({
        state: 'failed',
        failureCode: 'encode',
        reason:
          'render: subtitle file a.de.srt cannot be used: its path is not a real path in the library',
      });
      expect(spawner.calls).toEqual([]);
    });

    it('a sidecar over 8 MB is refused', async () => {
      const big = join(root, 'Show', 'a.de.srt');
      await writeFile(big, Buffer.alloc(8_000_001, 65));
      const id = await queue(file(), sidecarWorkflow(big));
      await t.deps.engine.start();
      expect(await settled(id)).toMatchObject({
        state: 'failed',
        failureCode: 'encode',
        reason: 'render: subtitle file a.de.srt cannot be used: it is larger than 8.00 MB',
      });
      expect(spawner.calls).toEqual([]);
    });
  });

  it('a ready job cancelled while waiting for its lane has its temp dir discarded and a cancelled result', async () => {
    await writeFile(join(root, 'Show', 'b.mkv'), Buffer.alloc(1000, 7));
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const first = await queue(file(), wf);
    const second = await queue(join(root, 'Show', 'b.mkv'), wf);
    await t.deps.engine.start();
    await until('one encoding', () => spawner.calls.length === 1);
    // Both prepare at once; whichever got the lane first runs, the other waits ready.
    const a = spawner.calls[0]?.logPath.includes(first) ? first : second;
    const b = a === first ? second : first;
    await until('b ready', () => t.deps.engine.scheduler.status().ready.includes(b));
    await mkdir(join(transcodeDir, b), { recursive: true });
    expect(t.deps.engine.scheduler.cancelJob(b)).toBe('ok');
    await until('b discarded', async () => !(await listAll(transcodeDir)).includes(`/${b}`));
    expect(row(b).state).toBe('cancelled');
    await until('b result', () => findJobResult(t.db, b) !== null);
    expect(findJobResult(t.db, b)).toMatchObject({ outcome: 'cancelled', plan: { rewrite: true } });
    expect(row(a).state).toBe('encoding');
  });

  it('a frame count off the source count fails the in-pass check', async () => {
    fake.sourceProbe = {
      ...fake.sourceProbe,
      raw: { streams: [{ index: 0, nb_frames: '1440' }] },
    };
    const exec: Exec = async (file, args) => {
      if (args.includes('-show_format') && !(args.at(-1) as string).startsWith(transcodeDir)) {
        const json = ffprobeJson(fake.sourceProbe) as { streams: Record<string, unknown>[] };
        (json.streams[0] as Record<string, unknown>).nb_frames = '1440';
        return { stdout: JSON.stringify(json), stderr: '' };
      }
      return fakeExec(file, args);
    };
    await restartWith(exec);
    const created = await t.deps.engine.queue.createLibrary({ name: 'Lib', path: root });
    expect('kind' in created).toBe(false);
    const wf = workflow(
      line(node('in', 'core:input-manual'), toH264(), node('ro', 'core:replace-original')),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    for (const n of [1, 2]) {
      await until(`spawn ${n}`, () => spawner.calls.length === n);
      spawner.emitProgress({ outTimeSeconds: 60, speed: 1, fps: 24, sizeBytes: 600, frames: 700 });
      await spawner.complete({ bytes: 600 });
    }
    expect(await settled(id)).toMatchObject({
      state: 'failed',
      failureCode: 'encode',
      reason: 'encode wrote 700 video frames, the source has 1440',
    });
  });
});

describe('cover extraction on big files', () => {
  it('the time limit grows with the file: 60 s plus 1 s per 100 MB', () => {
    expect(coverTimeoutMs(0)).toBe(60_000);
    expect(coverTimeoutMs(30_000_000_000)).toBe(360_000);
  });

  it("a stopped extraction says it took too long; another failure keeps ffmpeg's last line", () => {
    expect(
      coverFailure(
        Object.assign(new Error('Command failed: ffmpeg …'), { killed: true }),
        11,
        360_000,
      ),
    ).toBe(
      'render: copying the cover (video #11) out of the file took longer than 6 min and was stopped',
    );
    const err = Object.assign(new Error('Command failed: ffmpeg …'), {
      stderr: '[matroska @ 0x55d0] Invalid data\ncover.jpg: Invalid argument\n',
    });
    expect(coverFailure(err, 3, 60_000)).toBe(
      'render: the cover (video #3) could not be copied out of the file: cover.jpg: Invalid argument',
    );
  });
});
