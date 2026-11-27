import { copyFile, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { planSummary } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../app/test-app.ts';
import type { Exec } from '../../capabilities/ffmpeg.ts';
import { findJob, findJobResult, listRecycled, listTrace } from '../../db/repos/jobs.ts';
import { findWorkflow } from '../../db/repos/workflows.ts';
import { setOrder } from '../../nodes/core/stream-rules.ts';
import { nodeFsOps } from '../../platform/fs-ops.ts';
import { edge, mainGraph, node } from '../../workflows/test-helpers.ts';
import { fingerprintOf } from '../files/fingerprint.ts';
import { fitToContainer, modelFromProbe, normalizeDefaults } from '../model/model.ts';
import { probeOf, withSidecar } from '../testing/builders.ts';
import { estimateBytes, planOf } from './plan.ts';
import { redactUrl } from './steps.ts';
import {
  configDir,
  encodeAnd,
  fake,
  fakeExec,
  file,
  line,
  queue,
  replaceNode,
  restartWith,
  root,
  SECRET,
  settled,
  spawner,
  t,
  toH264,
  until,
  workflow,
} from './testing.ts';

describe('pipeline helpers', () => {
  it('estimateBytes is the median ratio × before, null without history', () => {
    const app = createTestApp();
    expect(estimateBytes(app.db, 'nope', 1000)).toBeNull();
  });

  it('planOf marks an added track and keeps a note per stream', () => {
    const probe = probeOf([
      { type: 'video', codec: 'hevc', default: true },
      { type: 'audio', codec: 'eac3', language: 'eng', default: true, channels: 6 },
    ]);
    const model = modelFromProbe(probe);
    const main = model.streams[1];
    if (!main) throw new Error('no audio');
    main.default = false;
    model.streams.push({
      ...main,
      mode: 'convert',
      codec: 'aac',
      encoder: 'aac',
      bitrateKbps: 160,
      channels: 2,
      default: true,
      order: 2,
    });
    const plan = planOf(model, probe, 'eng');
    expect(plan.rewrite).toBe(true);
    expect(plan.streams.map((s) => [s.index, s.action, s.default, s.isOriginalLanguage])).toEqual([
      [0, 'keep', { before: true, after: true }, false],
      [1, 'keep', { before: true, after: false }, true],
      [1, 'convert', { before: false, after: true }, true],
    ]);
    expect(plan.streams[2]?.note).toMatch(/^added: convert eac3→aac/);
  });

  it('planOf lists the output tracks in output order, without mkv covers, each with its source stream', () => {
    const probe = probeOf([
      { type: 'video', codec: 'hevc', default: true },
      { type: 'audio', codec: 'truehd', language: 'eng', default: true },
      { type: 'audio', codec: 'aac', language: 'jpn' },
      { type: 'video', codec: 'mjpeg', attachedPic: true },
      { type: 'subtitle', codec: 'subrip', language: 'eng' },
    ]);
    const model = modelFromProbe(probe);
    const [video, truehd, aac, cover, sub] = model.streams;
    if (!video || !truehd || !aac || !cover || !sub) throw new Error('streams missing');
    // jpn first: the output's first audio track is the aac one.
    setOrder(model, [video, aac, truehd, cover, sub]);
    expect(planOf(model, probe, 'jpn').output).toEqual([
      { type: 'video', codec: 'hevc', sourceIndex: 0 },
      { type: 'audio', codec: 'aac', sourceIndex: 2 },
      { type: 'audio', codec: 'truehd', sourceIndex: 1 },
      { type: 'subtitle', codec: 'subrip', sourceIndex: 4 },
    ]);
  });

  it('planOf gives an output track its bit depth and channels: the encode, else the source', () => {
    const probe = probeOf([
      { type: 'video', codec: 'h264', default: true, bitDepth: 8 },
      { type: 'audio', codec: 'eac3', language: 'eng', default: true, channels: 6 },
      { type: 'audio', codec: 'dts', language: 'jpn', channels: 8 },
    ]);
    const model = modelFromProbe(probe);
    const [video, eac3, dts] = model.streams;
    if (!video || !eac3 || !dts) throw new Error('streams missing');
    Object.assign(video, { mode: 'convert', codec: 'hevc', pixelFormat: 'yuv420p10le' });
    Object.assign(dts, { mode: 'convert', codec: 'aac', channels: 2 });
    expect(planOf(model, probe, null).output).toEqual([
      { type: 'video', codec: 'hevc', sourceIndex: 0, bitDepth: 10 },
      { type: 'audio', codec: 'eac3', sourceIndex: 1, channels: 6 },
      { type: 'audio', codec: 'aac', sourceIndex: 2, channels: 2 },
    ]);
  });

  it('planOf appends normalizeDefaults notes to the diff note', () => {
    const probe = probeOf([
      { type: 'video', codec: 'hevc', default: true },
      { type: 'audio', codec: 'aac', language: 'eng' },
      { type: 'audio', codec: 'aac', language: 'deu' },
    ]);
    const model = { ...modelFromProbe(probe), container: 'mp4' as const };
    const notes = normalizeDefaults(model);
    const plan = planOf(model, probe, null, notes);
    expect(plan.streams.map((s) => [s.index, s.default.after, s.note])).toEqual([
      [0, true, ''],
      [1, true, 'default; no audio track was default'],
      [2, false, ''],
    ]);
  });

  it('planOf lists sidecar files apart from the probe streams', () => {
    const probe = probeOf([{ type: 'video', codec: 'hevc', default: true }, { type: 'audio' }]);
    let model = withSidecar(modelFromProbe(probe), 1, 'Show.de.srt', { forced: true });
    model = withSidecar(model, 2, 'Show.fr.sup', { language: 'fra', codec: 'hdmv_pgs_subtitle' });
    model = { ...model, container: 'mp4' };
    fitToContainer(model);
    const plan = planOf(model, probe, null);
    expect(plan.streams.map((s) => s.index)).toEqual([0, 1]);
    expect(plan.rewrite).toBe(true);
    // A track from a subtitle file has no source stream in the probe.
    expect(plan.output?.map((o) => o.sourceIndex)).toEqual([0, 1, null]);
    expect(plan.sidecars).toEqual([
      {
        file: 'Show.de.srt',
        language: 'deu',
        forced: true,
        sdh: false,
        codec: 'mov_text',
        action: 'embed',
        note: '',
      },
      {
        file: 'Show.fr.sup',
        language: 'fra',
        forced: false,
        sdh: false,
        codec: 'hdmv_pgs_subtitle',
        action: 'drop',
        note: "container can't hold it",
      },
    ]);
  });

  it('planOf has no sidecars key without extra inputs', () => {
    const probe = probeOf([{ type: 'video' }]);
    expect(planOf(modelFromProbe(probe), probe, null).sidecars).toBeUndefined();
  });

  it('redactUrl keeps only scheme and host', () => {
    expect(redactUrl(`https://h.example:8443/a/${SECRET}?t=${SECRET}`)).toBe(
      'https://h.example:8443/…',
    );
    expect(redactUrl('not a url')).toBe('an invalid URL');
  });
});

describe('core:embed-sidecar-subtitles in the pipeline', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nHallo\n';
  const sidecar = (name: string) => join(root, 'Show', name);
  const recycled = (name: string) => join(root, '.transcoda-recycle', 'Show', name);
  const embedWorkflow = (
    settings: Parameters<typeof node>[2] = {},
    ...more: ReturnType<typeof node>[]
  ) =>
    workflow(
      line(
        node('in', 'core:input-manual'),
        node('es', 'core:embed-sidecar-subtitles', settings),
        ...more,
        node('ro', 'core:replace-original'),
      ),
    );
  const withGerman = (container: 'mkv' | 'mp4' = 'mkv', codec = 'subrip') =>
    probeOf(
      [
        { type: 'video', codec: 'hevc', default: true },
        { type: 'audio', codec: 'aac', language: 'eng', default: true },
        { type: 'subtitle', codec, language: 'deu', default: container === 'mp4' },
      ],
      container === 'mp4'
        ? { sizeBytes: 600, container: 'mp4', formatName: 'mov,mp4,m4a,3gp,3g2,mj2' }
        : { sizeBytes: 600 },
    );

  it('dry run: the plan lists the embed rows and the summary says so; nothing moves', async () => {
    await writeFile(sidecar('a.de.srt'), srt);
    const id = await queue(file(), embedWorkflow(), { dryRun: true });
    await t.deps.engine.start();
    expect(await settled(id)).toMatchObject({ state: 'dry_run' });
    const plan = findJobResult(t.db, id)?.plan;
    expect(plan?.sidecars).toEqual([
      expect.objectContaining({ file: 'a.de.srt', language: 'deu', action: 'embed' }),
    ]);
    expect(planSummary(plan as NonNullable<typeof plan>)).toContain('embed 1 subtitle file');
    expect(listTrace(t.db, id).find((e) => e.nodeId === 'es')?.reason).toBe('embed a.de.srt (deu)');
    expect(spawner.calls).toEqual([]);
    expect(await readFile(sidecar('a.de.srt'), 'utf8')).toBe(srt);
  });

  it('real run: done, and the embedded sidecar is in the recycle folder with a recycled row', async () => {
    await writeFile(sidecar('a.de.srt'), srt);
    fake.outputProbe = withGerman();
    const id = await queue(file(), embedWorkflow());
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'done', reason: null });
    expect(await readFile(recycled('a.de.srt'), 'utf8')).toBe(srt);
    expect(await nodeFsOps.exists(sidecar('a.de.srt'))).toBe(false);
    expect(listRecycled(t.db).map((r) => r.path)).toEqual(
      expect.arrayContaining([recycled('a.mkv'), recycled('a.de.srt')]),
    );
  });

  it("afterEmbed 'keep': the sidecar stays; a second run sees the embedded track and ends nothing_to_do", async () => {
    await writeFile(sidecar('a.de.srt'), srt);
    fake.outputProbe = withGerman();
    const wf = embedWorkflow({ afterEmbed: 'keep' });
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'done', reason: null });
    expect(await readFile(sidecar('a.de.srt'), 'utf8')).toBe(srt);
    expect(await nodeFsOps.exists(recycled('a.de.srt'))).toBe(false);

    fake.sourceProbe = withGerman();
    // Forced: the file is now this version's output, which a plain scan marks already_processed.
    const again = await queue(file(), wf, { force: true });
    const job = await settled(again);
    expect(job).toMatchObject({ state: 'nothing_to_do' });
    expect(listTrace(t.db, again).find((e) => e.nodeId === 'es')?.reason).toBe(
      'no subtitle file embedded; skipped a.de.srt: already has deu',
    );
    expect(spawner.calls).toHaveLength(1);
  });

  it('embed before a remux to mp4: the .sup is planned as drop and never recycled; the .srt is', async () => {
    await writeFile(sidecar('a.de.srt'), srt);
    await writeFile(sidecar('a.fr.sup'), Buffer.from([0x50, 0x47, 1, 2]));
    fake.outputProbe = withGerman('mp4', 'mov_text');
    const id = await queue(
      file(),
      embedWorkflow(
        {},
        node('rm', 'core:remux', { container: 'mp4', subtitleConversion: 'drop-incompatible' }),
      ),
    );
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    expect(findJob(t.db, id)).toBeTruthy();
    await spawner.complete({ bytes: 600 });
    expect(await settled(id)).toMatchObject({ state: 'done', reason: null });
    expect(findJobResult(t.db, id)?.plan?.sidecars).toEqual([
      expect.objectContaining({ file: 'a.de.srt', action: 'embed' }),
      expect.objectContaining({
        file: 'a.fr.sup',
        action: 'drop',
        note: "container can't hold it",
      }),
    ]);
    expect(listTrace(t.db, id).find((e) => e.nodeId === 'rm')?.reason).toContain(
      "dropped (container can't hold it): a.fr.sup hdmv_pgs_subtitle",
    );
    expect(await nodeFsOps.exists(sidecar('a.fr.sup'))).toBe(true);
    expect(await nodeFsOps.exists(recycled('a.fr.sup'))).toBe(false);
    expect(await readFile(recycled('a.de.srt'), 'utf8')).toBe(srt);
  });

  it('a sidecar that cannot be recycled is a problem on a done job, never a failure', async () => {
    await writeFile(sidecar('a.de.srt'), srt);
    fake.outputProbe = withGerman();
    const id = await queue(file(), embedWorkflow());
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    await rm(sidecar('a.de.srt'));
    await spawner.complete({ bytes: 600 });
    const job = await settled(id);
    expect(job.state).toBe('done');
    expect(job.reason).toMatch(
      /^finished with a problem: subtitle file a\.de\.srt could not be recycled: /,
    );
    // Replace original's work left it: the problem is badged on that node.
    expect(findJobResult(t.db, id)?.nodeProblems).toEqual([
      {
        workflowPath: [],
        nodeId: 'ro',
        severity: 'problem',
        message: expect.stringMatching(/^subtitle file a\.de\.srt could not be recycled: /),
      },
    ]);
  });
});

describe('pipeline: Already processed', () => {
  const traceOf = (id: string, nodeId: string) =>
    listTrace(t.db, id)
      .filter((e) => e.nodeId === nodeId)
      .map((e) => [e.phase, e.port, e.reason]);
  /** in → Already processed; No → encode → replace; Yes leads nowhere (nothing to write). */
  const gate = (settings: Record<string, string | number>) =>
    workflow(
      mainGraph(
        [
          node('in', 'core:input-manual'),
          node('ap', 'core:already-processed', settings),
          toH264(),
          node('ro', 'core:replace-original'),
        ],
        [edge('in', 'ap'), edge('ap', 'ev', { from: 'else' }), edge('ev', 'ro')],
      ),
    );
  const day = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  /**
   * A dry run of `workflowId` on the file: the port Already processed took. Forced, so the queue
   * doesn't mark a file this version wrote `already_processed` before the node sees it.
   */
  const portFor = async (workflowId: string, path = file()) => {
    const id = await queue(path, workflowId, { dryRun: true, force: true });
    await settled(id);
    return traceOf(id, 'ap')[0]?.[1];
  };

  it('recognises another workflow’s output and its own, by version; its own output is tagged', async () => {
    await t.deps.engine.start();
    const save = encodeAnd(replaceNode());
    const first = await queue(file(), save);
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    expect(await settled(first)).toMatchObject({ state: 'done' });
    const at = findJobResult(t.db, first)?.createdAt ?? '';

    // The replaced file is Save's output.
    const check = gate({ workflowId: save });
    const dry = await queue(file(), check, { dryRun: true });
    expect(await settled(dry)).toMatchObject({ state: 'nothing_to_do' });
    expect(traceOf(dry, 'ap')).toEqual([
      [
        'decide',
        'pass',
        `done by ${findWorkflow(t.db, save)?.name} v2 on ${day(at)} (this file is its output)`,
      ],
    ]);

    // "This workflow" of the checking workflow has no history for this file: No, and it encodes.
    const own = gate({});
    const second = await queue(file(), own);
    await until('spawn', () => spawner.calls.length === 2);
    await spawner.complete({ bytes: 500 });
    expect(await settled(second)).toMatchObject({ state: 'done' });
    expect(traceOf(second, 'ap')).toEqual([
      ['decide', 'else', `not processed by ${findWorkflow(t.db, own)?.name}`],
    ]);

    // Its own output now: Yes for "This workflow" of that workflow, by version.
    expect(await portFor(own)).toBe('pass');
    expect(await portFor(gate({ workflowId: own, version: 2 }))).toBe('pass');
    expect(await portFor(gate({ workflowId: own, version: 1 }))).toBe('else');
  });

  it('a copy of an output at another path (new inode) is known by its content hash', async () => {
    await t.deps.engine.start();
    const save = encodeAnd(replaceNode());
    const first = await queue(file(), save);
    await until('spawn', () => spawner.calls.length === 1);
    await spawner.complete({ bytes: 600 });
    expect(await settled(first)).toMatchObject({ state: 'done' });
    const at = findJobResult(t.db, first)?.createdAt ?? '';

    const copy = join(root, 'Show', 'copy.mkv');
    await copyFile(file(), copy);
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(copy, past, past);
    const [a, b] = [await fingerprintOf(file()), await fingerprintOf(copy)];
    expect(b.ino).not.toBe(a.ino);

    const check = gate({ workflowId: save });
    const dry = await queue(copy, check, { dryRun: true });
    await settled(dry);
    expect(traceOf(dry, 'ap')).toEqual([
      [
        'decide',
        'pass',
        `done by ${findWorkflow(t.db, save)?.name} v2 on ${day(at)} (same content as its output)`,
      ],
    ]);
    // A different file of the same size is not (the encodes here write bytes of 1).
    await writeFile(copy, Buffer.alloc(600, 9));
    await utimes(copy, past, past);
    expect(await portFor(check, copy)).toBe('else');
  });
});

describe('pipeline: a failed probe (#44)', () => {
  it('fails with one plain sentence; the command line and ffprobe output go to the job log', async () => {
    const path = file();
    const command = `ffprobe -v error -show_format -show_streams -show_chapters -of json ${path}`;
    const stderr = `[matroska,webm @ 0x90903c000] EBML header parsing failed\n${path}: Invalid data found when processing input\n`;
    const exec: Exec = async (f, args) => {
      if (args.includes('-show_format') && args.at(-1) === path) {
        throw Object.assign(new Error(`Command failed: ${command}\n${stderr}`), {
          code: 1,
          stderr,
        });
      }
      return fakeExec(f, args);
    };
    await restartWith(exec);
    const created = await t.deps.engine.queue.createLibrary({ name: 'Lib', path: root });
    expect('kind' in created).toBe(false);
    const id = await queue(path, encodeAnd(replaceNode()));
    await t.deps.engine.start();
    const job = await settled(id);
    expect(job).toMatchObject({
      state: 'failed',
      failureCode: 'source_unreadable',
      reason:
        "The file couldn't be read: it isn't a valid video file (ffprobe: Invalid data found when processing input)",
    });
    expect(job.reason).not.toContain(path);
    expect(spawner.calls).toHaveLength(0);
    const log = await t.deps.engine.jobLog(id);
    expect(log).toContain(command);
    expect(log).toContain('EBML header parsing failed');
    expect(findJobResult(t.db, id)?.logPath).toBe(
      join(configDir, 'logs', 'jobs', `${id}.attempt-1.log`),
    );
  });
});
