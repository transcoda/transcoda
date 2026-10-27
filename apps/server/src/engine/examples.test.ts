// The example workflows in examples/workflows, end to end over real ffmpeg and the fixtures:
// first run, second run (= nothing to do), dry run over fresh copies (= writes nothing).
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Capabilities } from '@transcoda/contract';
import {
  type JobState,
  syncLinkedSettings,
  upgradeGraphJson,
  type WorkflowGraph,
  WorkflowGraphSchema,
} from '@transcoda/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type JobResultRow, listRecycled } from '../db/repos/jobs.ts';
import type { Logger } from '../logger.ts';
import { createTestApp, type TestApp } from '../test-app.ts';
import {
  copyFixture,
  type FixtureName,
  fixturePath,
  fixturesAvailable,
  realCapabilities,
  tempDir,
  toolPaths,
} from './fixtures.ts';
import { nodeFsOps } from './fs-ops.ts';
import { probeFile } from './probe.ts';
import { nodeSpawner } from './process.ts';
import type { RunDetail } from './queue-service.ts';

const EXAMPLES_DIR = fileURLToPath(new URL('../../../../examples/workflows/', import.meta.url));
const EXAMPLES = ['save-space', 'play-everywhere', 'keep-my-languages'] as const;
type Example = (typeof EXAMPLES)[number];

const FOLDER: FixtureName[] = [
  'tigger-pooh.mp4',
  'compliant.mkv',
  'untagged.mkv',
  'two-defaults.mkv',
  'ass-fonts.mkv',
  'h264-big.mkv',
];
/** H.264 sources with no default audio or two: a rewrite flags exactly one (final review I1). */
const DEFAULT_FLAGS: FixtureName[] = ['no-default-audio.mkv', 'two-defaults-h264.mkv'];
const FILES: Record<Example, FixtureName[]> = {
  'save-space': [...FOLDER, ...DEFAULT_FLAGS],
  'play-everywhere': FOLDER,
  'keep-my-languages': [...FOLDER, 'pgs-subs.mkv'],
};

/** A run settles well within this on a laptop CPU (libx265 medium on 3 s at 640×360). */
const SETTLE_MS = 100_000;
const GATE_TIMEOUT_MS = 240_000;

async function loadExample(name: Example): Promise<WorkflowGraph> {
  return WorkflowGraphSchema.parse(
    upgradeGraphJson(
      JSON.parse(await readFile(join(EXAMPLES_DIR, `${name}.json`), 'utf8')),
      () => false,
    ),
  );
}

describe('examples/workflows', () => {
  const caps: Capabilities = {
    available: true,
    path: '/usr/bin/ffmpeg',
    version: '9.0.2',
    encoders: ['aac', 'libx264', 'libx265'],
    hwaccels: [],
    filters: ['pan'],
  };

  it('every example parses and validates against the core registry', async () => {
    const t = createTestApp({ capabilities: caps });
    for (const name of EXAMPLES) {
      const graph = await loadExample(name);
      const { issues, valid } = t.deps.workflows.validate(graph);
      expect(valid, name).toBe(true);
      const types = graph.nodes.map((n) => n.type);
      expect(types, name).toContain('core:input-manual');
      expect(types, name).toContain('core:replace-original');
      for (const n of graph.nodes.filter((n) => n.type === 'core:encode-video')) {
        expect((n.settings as { encoder: string }).encoder, name).toBe('auto');
      }
      // Only Save space leaves a port open (video-is Yes, port id `pass`: already HEVC).
      const expected =
        name === 'save-space'
          ? [
              {
                code: 'NO_WRITE_PATH',
                nodeId: 'is-hevc',
                message: expect.stringContaining('"Yes"'),
              },
            ]
          : [];
      expect(
        issues.map((i) => ({ code: i.code, nodeId: i.nodeId, message: i.message })),
        name,
      ).toEqual(expected);
      // Each starts with a note, and every shared value it links to exists.
      expect(
        graph.groups.some((g) => g.note?.startsWith('## ')),
        name,
      ).toBe(true);
      for (const n of graph.nodes) {
        for (const value of Object.values(n.links ?? {})) {
          expect(
            graph.values?.entries.map((v) => v.name),
            `${name} ${n.id}`,
          ).toContain(value);
        }
      }
    }
  });
});

// ---- the end-to-end gate --------------------------------------------------------------------

interface Outcome {
  jobId: string;
  state: JobState;
  reason: string | null;
  result: JobResultRow | null;
}

/**
 * The API the gate drives. Task 17's REST layer is not on this branch yet; every method maps
 * one-to-one to a route (workflows create/save/setMode, jobs.queue, runs.get, jobs.get), so moving
 * the gate to REST only changes this object.
 */
function gateApi(t: TestApp) {
  return {
    createWorkflow(name: string, graph: WorkflowGraph): string {
      const { id } = t.deps.workflows.create({ name, kind: 'workflow' }, 'gate');
      const saved = t.deps.workflows.save({ id, baseVersion: 1, graph }, 'gate');
      if (!saved.valid) throw new Error(`${name} invalid: ${JSON.stringify(saved.issues)}`);
      const mode = t.deps.workflows.activate(id, saved.version, 'gate');
      if (mode.kind !== 'ok') throw new Error(`${name} not activated: ${mode.kind}`);
      return id;
    },
    async queue(path: string, workflowId: string, dryRun = false): Promise<string> {
      const r = await t.deps.engine.queue.queue({
        path,
        workflowId,
        dryRun,
        force: false,
        priority: 0,
        createdBy: 'gate',
      });
      if (r.kind !== 'queued') throw new Error(`not queued: ${JSON.stringify(r)}`);
      return r.run.id;
    },
    run(runId: string): RunDetail {
      const run = t.deps.engine.queue.runSummary(runId);
      if (!run) throw new Error(`no run ${runId}`);
      return run;
    },
    job(jobId: string) {
      const job = t.deps.engine.jobDetail(jobId);
      if (!job) throw new Error(`no job ${jobId}`);
      return job;
    },
  };
}
type GateApi = ReturnType<typeof gateApi>;

/** Polls the run until no job is in progress; returns each file's outcome by file name. */
async function settle(api: GateApi, runId: string): Promise<Map<string, Outcome>> {
  const deadline = Date.now() + SETTLE_MS;
  let run = api.run(runId);
  while (run.counts.in_progress > 0) {
    if (Date.now() > deadline) throw new Error(`run ${runId} did not settle`);
    await new Promise((r) => setTimeout(r, 50));
    run = api.run(runId);
  }
  const outcomes = new Map<string, Outcome>();
  for (const f of run.files) {
    const d = api.job(f.jobId);
    outcomes.set(f.fileName, {
      jobId: f.jobId,
      state: f.state,
      reason: f.reason,
      result: d.result,
    });
  }
  // Counts reconcile: every job counted once, under its state, and done bytes add up.
  const { counts } = run;
  expect(counts.total).toBe(run.files.length);
  for (const state of new Set(run.files.map((f) => f.state))) {
    expect(counts[state as keyof typeof counts], state).toBe(
      run.files.filter((f) => f.state === state).length,
    );
  }
  const done = run.files.filter((f) => f.state === 'done');
  expect(counts.beforeBytes).toBe(done.reduce((n, f) => n + (f.beforeBytes ?? 0), 0));
  expect(counts.afterBytes).toBe(done.reduce((n, f) => n + (f.afterBytes ?? 0), 0));
  return outcomes;
}

function states(outcomes: Map<string, Outcome>): Record<string, JobState> {
  return Object.fromEntries([...outcomes].map(([name, o]) => [name, o.state]));
}

/** Readable failure context: state, reason and warnings per file. */
function explain(outcomes: Map<string, Outcome>): string {
  return [...outcomes]
    .map(([n, o]) => `${n}: ${o.state} ${o.reason ?? ''} ${o.result?.warnings.join(' | ') ?? ''}`)
    .join('\n');
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/**
 * Every entry under `dir`, dotfolders included: a file maps to its sha256, a directory to `dir`.
 * Two equal snapshots mean nothing was written, renamed, created or removed.
 */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    const full = join(e.parentPath, e.name);
    out[full.slice(dir.length + 1)] = e.isDirectory() ? 'dir' : await sha256(full);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function listing(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { recursive: true })).sort();
  } catch {
    return [];
  }
}

describe.skipIf(!fixturesAvailable())('examples/workflows: the end-to-end gate', () => {
  let base: string;
  let t: TestApp;
  let api: GateApi;
  const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };

  beforeAll(async () => {
    base = await tempDir('examples-');
    const { ffmpegPath, ffprobePath } = toolPaths();
    t = createTestApp({
      config: {
        configDir: join(base, 'config'),
        transcodeDir: join(base, 'transcode'),
        ffmpegPath,
        ffprobePath,
      },
      capabilities: await realCapabilities(),
      spawner: nodeSpawner,
      fsOps: nodeFsOps,
      log: quiet,
      start: new Date(),
    });
    api = gateApi(t);
    await t.deps.engine.start();
  });

  afterAll(async () => {
    await t?.deps.engine.stop();
    if (base) await rm(base, { recursive: true, force: true });
  });

  /**
   * One example over its own library: the first run (checked by `first`), the same folder again
   * (only nothing_to_do / already_processed), then a dry run over fresh copies that writes
   * nothing. Returns the first run's outcomes.
   */
  async function gate(
    name: Example,
    first: (outcomes: Map<string, Outcome>, folder: string) => Promise<void> | void,
  ): Promise<void> {
    await gateWith(name, await loadExample(name), FILES[name], first);
  }

  /** {@link gate} for any workflow graph over the given fixtures. */
  async function gateWith(
    name: string,
    graph: WorkflowGraph,
    files: FixtureName[],
    first: (outcomes: Map<string, Outcome>, folder: string) => Promise<void> | void,
  ): Promise<void> {
    const root = join(base, name);
    const media = join(root, 'media');
    const fresh = join(root, 'fresh');
    await mkdir(media, { recursive: true });
    await mkdir(fresh, { recursive: true });
    for (const f of files) await copyFixture(f, media);
    const lib = await t.deps.engine.queue.createLibrary({ name, path: root });
    if ('kind' in lib) throw new Error(`library ${name}: ${lib.kind}`);
    const wf = api.createWorkflow(name, graph);

    // First run.
    const one = await settle(api, await api.queue(media, wf));
    expect(one.size, explain(one)).toBe(files.length);
    for (const o of one.values()) expect(o.state, explain(one)).not.toBe('failed');
    await first(one, media);

    // Originals intact: an untouched file is byte-for-byte the fixture; a replaced one sits in
    // the recycle folder byte-for-byte.
    const recycled = listRecycled(t.db, lib.id);
    for (const [file, o] of one) {
      const original = await sha256(fixturePath(file as FixtureName));
      if (o.state === 'done') {
        const row = recycled.find((r) => r.jobId === o.jobId);
        expect(row?.path, `${file} recycled`).toContain('.transcoda-recycle');
        expect(await sha256(row?.path ?? ''), `${file} recycled`).toBe(original);
      } else {
        expect(await sha256(join(media, file)), `${file} untouched`).toBe(original);
      }
    }
    const afterFirst = await snapshot(root);
    const tempAfterFirst = await listing(join(base, 'transcode'));

    // Second run over the same folder: nothing left to do.
    const two = await settle(api, await api.queue(media, wf));
    expect(two.size, explain(two)).toBe(files.length);
    for (const [file, o] of two) {
      const before = one.get(file)?.state;
      if (o.state === 'already_processed') {
        // Only a file the first run left untouched keeps its fingerprint.
        expect(['nothing_to_do', 'kept_original'], `${file}\n${explain(two)}`).toContain(before);
      } else {
        expect(o.state, `${file}\n${explain(two)}`).toBe('nothing_to_do');
      }
    }
    // …and writes nothing: the whole library root (recycle folder included) and the temp dir.
    expect(await snapshot(root)).toEqual(afterFirst);
    expect(await listing(join(base, 'transcode'))).toEqual(tempAfterFirst);

    // Dry run over fresh copies (new inodes): plans, estimates, and not one byte written.
    for (const f of files) await copyFixture(f, fresh);
    const rootBefore = await snapshot(root);
    const tempBefore = await listing(join(base, 'transcode'));
    const dry = await settle(api, await api.queue(fresh, wf, true));
    expect(await snapshot(root)).toEqual(rootBefore);
    expect(await listing(join(base, 'transcode'))).toEqual(tempBefore);
    const learned = [...one.values()].some((o) => o.state === 'done');
    for (const [file, o] of dry) {
      const before = one.get(file)?.state;
      const changed = before === 'done' || before === 'kept_original';
      if (!changed) {
        expect(o.state, `${file}\n${explain(dry)}`).toBe('nothing_to_do');
        continue;
      }
      expect(o.state, `${file}\n${explain(dry)}`).toBe('dry_run');
      expect(o.result?.command, file).toMatch(/\S/);
      // The estimate is the median after/before ratio of the workflow's done results.
      if (learned) expect(o.result?.estimatedBytes, file).toBeGreaterThan(0);
    }
  }

  it(
    'Save space: H.264 shrinks with libx265, HEVC files are left alone',
    async () => {
      await gate('save-space', (one) => {
        const big = one.get('h264-big.mkv');
        expect(big?.state, explain(one)).toBe('done');
        expect(big?.result?.command).toContain('libx265');
        const { beforeBytes, afterBytes } = big?.result ?? {};
        expect(afterBytes).toBeLessThan((beforeBytes ?? 0) * 0.85);
        for (const f of FOLDER.filter((f) => f !== 'h264-big.mkv')) {
          expect(one.get(f)?.state, `${f}\n${explain(one)}`).toBe('nothing_to_do');
        }
        // No default audio, or two: the output has exactly one, the first audio track (no
        // set-default node on this path; the engine normalises the flags before it renders).
        for (const f of DEFAULT_FLAGS) {
          expect(one.get(f)?.state, `${f}\n${explain(one)}`).toBe('done');
          const audio = (one.get(f)?.result?.plan?.streams ?? []).filter((s) => s.type === 'audio');
          expect(
            audio.map((s) => s.default.after),
            f,
          ).toEqual([true, false]);
        }
      });
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'Play everywhere: every fixture already plays on Android TV and is left alone',
    async () => {
      await gate('play-everywhere', (one) => {
        for (const f of FOLDER) {
          expect(one.get(f)?.state, `${f}\n${explain(one)}`).toBe('nothing_to_do');
        }
      });
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'Play everywhere with chrome added to the shared Devices value: HEVC is re-encoded to H.264',
    async () => {
      const example = await loadExample('play-everywhere');
      const graph = syncLinkedSettings({
        ...example,
        values: {
          position: example.values?.position ?? { x: 0, y: 0 },
          entries: (example.values?.entries ?? []).map((v) =>
            v.name === 'Devices' ? { ...v, value: ['android-tv', 'chrome'] } : v,
          ),
        },
      });
      // Both nodes follow the value: the change reached each of them.
      for (const id of ['encode', 'audio']) {
        const settings = graph.nodes.find((x) => x.id === id)?.settings as { targets: string[] };
        expect(settings.targets, id).toEqual(['android-tv', 'chrome']);
      }
      await gateWith('play-everywhere-chrome', graph, ['compliant.mkv'], (one) => {
        const compliant = one.get('compliant.mkv');
        expect(compliant?.state, explain(one)).toBe('done');
        expect(compliant?.result?.command).toContain('libx264');
      });
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'Keep my languages: other languages go, English leads and is the default',
    async () => {
      await gate('keep-my-languages', async (one, folder) => {
        // English only: the German tracks go (compliant, two-defaults, h264-big, pgs-subs) and
        // untagged.mkv is rewritten; ass-fonts.mkv has only English and stays as it is.
        expect(states(one), explain(one)).toEqual({
          'tigger-pooh.mp4': 'done',
          'compliant.mkv': 'done',
          'untagged.mkv': 'done',
          'two-defaults.mkv': 'done',
          'ass-fonts.mkv': 'nothing_to_do',
          'h264-big.mkv': 'done',
          'pgs-subs.mkv': 'done',
        });
        const { ffprobePath } = toolPaths();
        const tigger = await probeFile(join(folder, 'tigger-pooh.mp4'), { ffprobePath });
        const audio = tigger.streams.filter((s) => s.type === 'audio');
        expect(audio[0]?.language).toBe('eng');
        expect(audio.map((s) => s.language)).not.toContain('deu');
        expect(audio.filter((s) => s.default).map((s) => s.language)).toEqual(['eng']);
        // keepCover: the png cover stays.
        expect(tigger.streams.filter((s) => s.attachedPic)).toHaveLength(1);
      });
    },
    GATE_TIMEOUT_MS,
  );

  const at = (i: number) => ({ x: i * 240, y: 0 });

  /** input → <one action> → replace. */
  function oneAction(type: string, settings: Record<string, unknown>): WorkflowGraph {
    return WorkflowGraphSchema.parse({
      formatVersion: 2,
      kind: 'workflow',
      groups: [],
      nodes: [
        { id: 'input', type: 'core:input-manual', typeVersion: 1, settings: {}, position: at(0) },
        { id: 'act', type, typeVersion: 1, settings, position: at(1) },
        {
          id: 'replace',
          type: 'core:replace-original',
          typeVersion: 1,
          settings: {},
          position: at(2),
        },
      ],
      edges: [
        { id: 'e1', from: { node: 'input', port: 'file' }, to: { node: 'act', port: 'file' } },
        { id: 'e2', from: { node: 'act', port: 'file' }, to: { node: 'replace', port: 'file' } },
      ],
    });
  }

  async function defaults(path: string): Promise<{ audio: boolean[]; subtitle: boolean[] }> {
    const probe = await probeFile(path, toolPaths());
    const of = (type: string) => probe.streams.filter((s) => s.type === type).map((s) => s.default);
    return { audio: of('audio'), subtitle: of('subtitle') };
  }

  it(
    'Remux to MP4 of an mkv without a default subtitle: the first subtitle becomes default',
    async () => {
      const graph = oneAction('core:remux', {
        container: 'mp4',
        subtitleConversion: 'convert',
        targets: [],
      });
      await gateWith('remux-mp4', graph, ['no-default-sub.mkv'], async (one, folder) => {
        expect(states(one), explain(one)).toEqual({ 'no-default-sub.mkv': 'done' });
        const plan = one.get('no-default-sub.mkv')?.result?.plan?.streams ?? [];
        const sub = plan.find((s) => s.type === 'subtitle' && s.default.after);
        expect(sub?.note, explain(one)).toContain('mp4');
        // Jan's ruling: a container change keeps the original file name.
        const after = await defaults(join(folder, 'no-default-sub.mkv'));
        expect(after).toEqual({ audio: [true], subtitle: [true, false] });
      });
    },
    GATE_TIMEOUT_MS,
  );

  it(
    'Set default track with no subtitle languages into an mp4: the mp4 keeps its first subtitle default',
    async () => {
      const graph = oneAction('core:set-default-track', {
        audioLanguages: ['en'],
        subtitleLanguages: [],
      });
      await gateWith('clear-default-sub', graph, ['tigger-pooh.mp4'], async (one, folder) => {
        expect(states(one), explain(one)).toEqual({ 'tigger-pooh.mp4': 'done' });
        const after = await defaults(join(folder, 'tigger-pooh.mp4'));
        expect(after.audio.filter(Boolean)).toHaveLength(1);
        expect(after.audio[0]).toBe(true);
        expect(after.subtitle.filter(Boolean)).toHaveLength(1);
        expect(after.subtitle[0]).toBe(true);
      });
    },
    GATE_TIMEOUT_MS,
  );
});
