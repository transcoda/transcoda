import type { Capabilities } from '@transcoda/contract';
import { describe, expect, it, vi } from 'vitest';
import { findJob, findJobResult, updateJob } from '../../db/repos/jobs.ts';
import { setSetting } from '../../db/repos/settings.ts';
import { node } from '../../workflows/test-helpers.ts';
import { probeOf } from '../testing/builders.ts';
import {
  caps,
  fake,
  file,
  line,
  queue,
  row,
  serverLog,
  setProfile,
  settled,
  setup,
  spawner,
  t,
  until,
  workflow,
} from './testing.ts';

describe('pipeline', () => {
  it('Encoding device: auto encodes on the chosen GPU (decode too), or on the CPU when set so', async () => {
    const twoGpus: Capabilities = {
      ...caps,
      encoders: [...(caps.available ? caps.encoders : []), 'h264_nvenc'],
      hwaccels: ['cuda'],
      gpus: [
        { id: 'nvidia:0', vendor: 'nvidia', index: 0, name: 'RTX 3060' },
        { id: 'nvidia:1', vendor: 'nvidia', index: 1, name: 'RTX 3060' },
      ],
    };
    await setup({ capabilities: twoGpus });
    const autoH264 = () =>
      node('ev', 'core:encode-video', { codec: 'h264', encoder: 'auto', skipIf: 'never' });
    const wf = workflow(
      line(node('in', 'core:input-manual'), autoH264(), node('ro', 'core:replace-original')),
    );
    await t.deps.engine.start();
    const commandFor = async (device: string) => {
      setSetting(t.db, 'engine.encodeDevice', device, t.clock.now());
      const id = await queue(file(), wf, { dryRun: true, force: true });
      expect((await settled(id)).state).toBe('dry_run');
      return findJobResult(t.db, id)?.command ?? '';
    };
    const gpu1 = await commandFor('nvidia:1');
    expect(gpu1).toContain('-hwaccel cuda -hwaccel_device 1 -i');
    expect(gpu1).toMatch(/-c:0 h264_nvenc .*-gpu:0 1/);
    const cpu = await commandFor('cpu');
    expect(cpu).toContain('-c:0 libx264');
    expect(cpu).not.toContain('-hwaccel');
    // Auto, as before this setting: NVENC on ffmpeg's default GPU, no index.
    const auto = await commandFor('auto');
    expect(auto).toContain('-hwaccel cuda -i');
    expect(auto).not.toMatch(/ -gpu[: ]/);

    // CPU only and a node that names an NVENC encoder: an error, never a quiet GPU encode.
    setSetting(t.db, 'engine.encodeDevice', 'cpu', t.clock.now());
    const pinned = workflow(
      line(
        node('in', 'core:input-manual'),
        node('ev', 'core:encode-video', { codec: 'h264', encoder: 'h264_nvenc', skipIf: 'never' }),
        node('ro', 'core:replace-original'),
      ),
      false,
    );
    expect(t.deps.workflows.activate(pinned, 2, 'u').kind).toBe('invalid');
    setSetting(t.db, 'engine.encodeDevice', 'auto', t.clock.now());
    expect(t.deps.workflows.activate(pinned, 2, 'u').kind).toBe('ok');
  });

  it('two GPUs on auto: a job encodes on the GPU of the slot it got, and its command says so', async () => {
    const twoGpus: Capabilities = {
      ...caps,
      encoders: [...(caps.available ? caps.encoders : []), 'h264_nvenc'],
      hwaccels: ['cuda'],
      gpus: [
        { id: 'nvidia:0', vendor: 'nvidia', index: 0, name: 'RTX 3060' },
        { id: 'nvidia:1', vendor: 'nvidia', index: 1, name: 'RTX 3060' },
      ],
    };
    await setup({ capabilities: twoGpus });
    const wf = workflow(
      line(
        node('in', 'core:input-manual'),
        node('ev', 'core:encode-video', { codec: 'h264', encoder: 'auto', skipIf: 'never' }),
        node('ro', 'core:replace-original'),
      ),
    );
    const id = await queue(file(), wf);
    await t.deps.engine.start();
    await until('spawn', () => spawner.calls.length === 1);
    const args = spawner.calls[0]?.args.join(' ') ?? '';
    expect(args).toContain('-hwaccel cuda -hwaccel_device 0 -i');
    expect(args).toMatch(/-c:0 h264_nvenc .*-gpu:0 0/);
    expect(t.deps.engine.scheduler.status().encodeSlots).toEqual([
      { id: 'gpu:0', label: 'GPU 0 · RTX 3060', jobId: id },
      { id: 'gpu:1', label: 'GPU 1 · RTX 3060', jobId: null },
    ]);
    await spawner.complete({ bytes: 600 });
    expect((await settled(id)).state).toBe('done');
    expect(findJobResult(t.db, id)?.command).toContain('-gpu:0 0');
  });

  describe('an NVIDIA and an Intel GPU on auto', () => {
    const mixed = (hwaccels: string[]): Capabilities => ({
      ...caps,
      encoders: [...(caps.available ? caps.encoders : []), 'hevc_nvenc', 'hevc_qsv', 'h264_qsv'],
      hwaccels,
      gpus: [
        { id: 'nvidia:0', vendor: 'nvidia', index: 0, name: 'RTX 3060' },
        {
          id: 'intel:0000:07:00.0',
          vendor: 'intel',
          index: 0,
          name: 'Intel Arc A310',
          renderNode: '/dev/dri/renderD128',
          pci: '0000:07:00.0',
        },
      ],
    });
    /** Encode video to `codec` with `encoder`; with `profile`, a later node sets it on the video. */
    const flow = (codec: 'hevc' | 'h264', encoder: string, profile?: [string, string]) =>
      workflow(
        line(
          node('in', 'core:input-manual'),
          node('ev', 'core:encode-video', { codec, encoder, skipIf: 'never' }),
          ...(profile
            ? [node('pf', 'test:set-profile', { profile: profile[0], pixelFormat: profile[1] })]
            : []),
          node('ro', 'core:replace-original'),
        ),
      );
    const hevc = (encoder: string) => flow('hevc', encoder);
    /** Runs one job of `wf` to done; its ffmpeg argv, the row's `encodedOn` and the job id. */
    const encode = async (wf: string, intelFirst: boolean, codec: 'hevc' | 'h264' = 'hevc') => {
      fake.outputProbe = probeOf(
        [
          { type: 'video', codec, default: true },
          { type: 'audio', codec: 'aac', language: 'eng', default: true },
        ],
        { sizeBytes: 600 },
      );
      if (intelFirst) {
        setSetting(t.db, 'engine.gpuOrder', ['intel:0000:07:00.0'], t.clock.now());
      }
      const id = await queue(file(), wf);
      await t.deps.engine.start();
      await until('spawn', () => spawner.calls.length === 1);
      const args = spawner.calls[0]?.args.join(' ') ?? '';
      await spawner.complete({ bytes: 600 });
      const job = await settled(id);
      expect(job.state).toBe('done');
      return { args, encodedOn: findJob(t.db, id)?.encodedOn, id };
    };
    const planNote = (id: string) => findJobResult(t.db, id)?.plan?.streams[0]?.note ?? '';

    it('an auto HEVC job on the Intel slot encodes with QSV on that GPU and records it', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const { args, encodedOn } = await encode(hevc('auto'), true);
      expect(args).toContain('-c:0 hevc_qsv');
      expect(args).toContain('child_device=/dev/dri/renderD128');
      expect(args).not.toContain('nvenc');
      expect(args).not.toContain('-hwaccel cuda');
      expect(args).toContain('-hwaccel qsv -hwaccel_output_format qsv -i');
      expect(encodedOn).toBe('Intel Arc A310 · 07:00.0');
    });

    it('the persisted plan names the encoder the job ran with', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const { id } = await encode(hevc('auto'), true);
      expect(planNote(id)).toContain('hevc_qsv');
      expect(planNote(id)).not.toContain('nvenc');
    });

    it('a retargeted stream keeps its profile: main10 renders hevc_qsv -profile main10', async () => {
      await setup({ capabilities: mixed(['cuda']), nodes: [setProfile] });
      const { args } = await encode(flow('hevc', 'auto', ['main10', 'yuv420p10le']), true);
      expect(args).toMatch(/-c:0 hevc_qsv .*-profile:0 main10 -filter:0 vpp_qsv=format=p010/);
    });

    it('an auto job that cannot render for the Intel GPU prepares with fit nvidia and takes GPU 0, even with Intel first', async () => {
      await setup({ capabilities: mixed(['cuda']), nodes: [setProfile] });
      const prepare = vi.spyOn(t.deps.engine.pipeline, 'prepare');
      // h264_qsv has no constrained-baseline profile.
      const wf = flow('h264', 'auto', ['constrained-baseline', 'yuv420p']);
      const { args, encodedOn } = await encode(wf, true, 'h264');
      await expect(prepare.mock.results[0]?.value).resolves.toEqual({
        lane: 'encode',
        fit: 'nvidia',
      });
      expect(args).toMatch(/-c:0 h264_nvenc .*-gpu:0 0/);
      expect(args).not.toContain('h264_qsv');
      expect(serverLog.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ msg: expect.stringContaining('encoding as built') }),
      );
      expect(encodedOn).toBe('GPU 0 · RTX 3060');
    });

    it('a software encode in a GPU slot records no GPU', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const { args, encodedOn } = await encode(hevc('libx265'), false);
      expect(args).toContain('-c:0 libx265');
      expect(encodedOn).toBeNull();
    });

    const NVENC_FAILED =
      '[hevc_nvenc @ 0x1] [error] OpenEncodeSessionEx failed: unsupported device (2)';
    const QSV_FAILED = '[hevc_qsv @ 0x55] [error] Error initializing an MFX session: -9.';
    /** Queues one job of `wf` and waits for its first ffmpeg; the job id. */
    const started = async (wf: string, intelFirst = false) => {
      fake.outputProbe = probeOf(
        [
          { type: 'video', codec: 'hevc', default: true },
          { type: 'audio', codec: 'aac', language: 'eng', default: true },
        ],
        { sizeBytes: 600 },
      );
      if (intelFirst) {
        setSetting(t.db, 'engine.gpuOrder', ['intel:0000:07:00.0'], t.clock.now());
      }
      const id = await queue(file(), wf);
      await t.deps.engine.start();
      await until('spawn', () => spawner.calls.length === 1);
      return id;
    };
    const fails = (line: string) => spawner.complete({ bytes: 0, code: 1, stderr: [line] });
    const warnings = (id: string) => findJobResult(t.db, id)?.warnings ?? [];

    it('an NVENC encode whose output stops growing is treated as a GPU failure: back to the queue for the Intel GPU', async () => {
      await setup({ capabilities: mixed(['cuda']), encodeStallMinutes: 0.001 });
      const id = await started(hevc('auto'));
      expect(spawner.calls[0]?.args).toContain('hevc_nvenc');
      spawner.emitProgress({ outTimeSeconds: 1, speed: 1, fps: 25, sizeBytes: 100 });
      t.clock.advance(70);
      await until('second spawn', () => spawner.calls.length === 2);
      expect(row(id)).toMatchObject({ attempt: 1, failedGpus: ['nvidia:0'] });
      expect(row(id).reason).toMatch(
        /^GPU 0 · RTX 3060 failed \(ffmpeg stopped writing output for 0\.001 minutes and was stopped.*\); trying another GPU$/,
      );
      expect(spawner.calls[1]?.args).toContain('hevc_qsv');
      await spawner.complete({ bytes: 600 });
      expect((await settled(id)).state).toBe('done');
    });

    it('an auto job whose NVENC encode fails on gpu:0 goes back to the queue and encodes on the Intel GPU, with a warning', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const id = await started(hevc('auto'));
      expect(spawner.calls[0]?.args).toContain('hevc_nvenc');
      await fails(NVENC_FAILED);
      await until('second spawn', () => spawner.calls.length === 2);
      expect(row(id)).toMatchObject({
        attempt: 1,
        failedGpus: ['nvidia:0'],
        reason:
          'GPU 0 · RTX 3060 failed (hevc_nvenc: OpenEncodeSessionEx failed: unsupported device (2)); trying another GPU',
      });
      const args = spawner.calls[1]?.args.join(' ') ?? '';
      expect(args).toContain('-c:0 hevc_qsv');
      expect(args).not.toContain('libx265');
      await spawner.complete({ bytes: 600 });
      expect((await settled(id)).state).toBe('done');
      expect(row(id).encodedOn).toBe('Intel Arc A310 · 07:00.0');
      expect(warnings(id)).toEqual([
        'GPU 0 · RTX 3060 failed (hevc_nvenc: OpenEncodeSessionEx failed: unsupported device (2)); trying another GPU',
      ]);
    });

    it('an auto job whose QSV encode fails on the Intel slot goes back to the queue for GPU 0, no software retry', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const id = await started(hevc('auto'), true);
      expect(spawner.calls[0]?.args).toContain('hevc_qsv');
      await fails(QSV_FAILED);
      await until('second spawn', () => spawner.calls.length === 2);
      expect(row(id)).toMatchObject({ attempt: 1, failedGpus: ['intel:0000:07:00.0'] });
      const args = spawner.calls[1]?.args.join(' ') ?? '';
      expect(args).toMatch(/-c:0 hevc_nvenc .*-gpu:0 0/);
      expect(args).not.toContain('libx265');
      await spawner.complete({ bytes: 600 });
      expect((await settled(id)).state).toBe('done');
    });

    it('a job that failed on GPU 0 and then on the Intel slot (CPU decoding too) has no GPU left: software, and records no GPU', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const id = await started(hevc('auto'));
      await fails(NVENC_FAILED);
      await until('Intel spawn', () => spawner.calls.length === 2);
      await until('encodedOn', () => row(id).encodedOn === 'Intel Arc A310 · 07:00.0');
      await fails(QSV_FAILED);
      await until('CPU-decode spawn', () => spawner.calls.length === 3);
      expect(spawner.calls[2]?.args).toContain('hevc_qsv');
      await fails(QSV_FAILED);
      await until('software spawn', () => spawner.calls.length === 4);
      expect(spawner.calls[3]?.args).toContain('libx265');
      await spawner.complete({ bytes: 600 });
      expect((await settled(id)).state).toBe('done');
      expect(row(id)).toMatchObject({
        attempt: 1,
        encodedOn: null,
        failedGpus: ['nvidia:0'],
      });
      expect(planNote(id)).toContain('libx265');
      expect(warnings(id)).toEqual([
        'GPU 0 · RTX 3060 failed (hevc_nvenc: OpenEncodeSessionEx failed: unsupported device (2)); trying another GPU',
        'the Intel GPU encode failed (hevc_qsv: Error initializing an MFX session: -9.); retried with the source decoded on the CPU',
        'the GPU encode failed (hevc_qsv: Error initializing an MFX session: -9.); encoded in software instead',
      ]);
    });

    const intelOnly = (): Capabilities => {
      const both = mixed([]);
      if (!both.available) throw new Error('the test capabilities have ffmpeg');
      return {
        ...both,
        encoders: both.encoders.filter((e) => !e.endsWith('_nvenc')),
        gpus: (both.gpus ?? []).filter((g) => g.vendor === 'intel'),
      };
    };
    const QSV_DECODE_FAILED = '[h264_qsv @ 0x5a] [error] Error querying IO surface';

    it('an Intel-only job whose GPU decode fails retries on the same GPU decoding on the CPU, not in software', async () => {
      await setup({ capabilities: intelOnly() });
      const id = await started(hevc('auto'));
      expect(spawner.calls[0]?.args.join(' ')).toContain('-hwaccel qsv -hwaccel_output_format qsv');
      await fails(QSV_DECODE_FAILED);
      await until('second spawn', () => spawner.calls.length === 2);
      const args = spawner.calls[1]?.args.join(' ') ?? '';
      expect(args).toContain('-c:0 hevc_qsv');
      expect(args).toContain('child_device=/dev/dri/renderD128');
      expect(args).not.toContain('-hwaccel');
      expect(args).not.toContain('libx265');
      await spawner.complete({ bytes: 600 });
      expect((await settled(id)).state).toBe('done');
      expect(row(id)).toMatchObject({
        attempt: 1,
        failedGpus: [],
        encodedOn: 'Intel Arc A310 · 07:00.0',
      });
      expect(planNote(id)).toContain('hevc_qsv');
      expect(warnings(id)).toEqual([
        'the Intel GPU encode failed (h264_qsv: Error querying IO surface); retried with the source decoded on the CPU',
      ]);
    });

    it('an Intel-only job that fails again with CPU decoding goes to software', async () => {
      await setup({ capabilities: intelOnly() });
      const id = await started(hevc('auto'));
      await fails(QSV_DECODE_FAILED);
      await until('CPU-decode spawn', () => spawner.calls.length === 2);
      await fails(QSV_FAILED);
      await until('software spawn', () => spawner.calls.length === 3);
      expect(spawner.calls[2]?.args).toContain('libx265');
      await spawner.complete({ bytes: 600 });
      expect((await settled(id)).state).toBe('done');
      expect(row(id).encodedOn).toBeNull();
      expect(warnings(id)).toHaveLength(2);
      expect(warnings(id)[1]).toMatch(/encoded in software instead$/);
    });

    it('after a restart, a job requeued from a failed GPU still carries its warning (from the row reason)', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      fake.outputProbe = probeOf(
        [
          { type: 'video', codec: 'hevc', default: true },
          { type: 'audio', codec: 'aac', language: 'eng', default: true },
        ],
        { sizeBytes: 600 },
      );
      const id = await queue(file(), hevc('auto'));
      // As the requeue left it before the restart: the warnings map of the old process is gone.
      const reason = 'GPU 0 · RTX 3060 failed (hevc_nvenc: x); trying another GPU';
      updateJob(t.db, id, { failedGpus: ['nvidia:0'], reason }, t.clock.now());
      await t.deps.engine.start();
      await until('spawn', () => spawner.calls.length === 1);
      expect(spawner.calls[0]?.args).toContain('hevc_qsv');
      await spawner.complete({ bytes: 600 });
      expect((await settled(id)).state).toBe('done');
      expect(warnings(id)).toEqual([reason]);
    });

    it('a workflow that names hevc_nvenc and fails on the only NVIDIA GPU goes to software in place, never to the Intel slot', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const id = await started(hevc('hevc_nvenc'));
      await fails(NVENC_FAILED);
      await until('software spawn', () => spawner.calls.length === 2);
      expect(spawner.calls[1]?.args).toContain('libx265');
      await spawner.complete({ bytes: 600 });
      expect((await settled(id)).state).toBe('done');
      expect(row(id).failedGpus).toEqual([]);
      expect(warnings(id)).toEqual([
        'the GPU encode failed (hevc_nvenc: OpenEncodeSessionEx failed: unsupported device (2)); encoded in software instead',
      ]);
      // The Render's work fell back: the warning is told on the Render's node too.
      expect(findJobResult(t.db, id)?.nodeProblems).toEqual([
        {
          workflowPath: [],
          nodeId: 'render-1',
          severity: 'warning',
          message:
            'the GPU encode failed (hevc_nvenc: OpenEncodeSessionEx failed: unsupported device (2)); encoded in software instead',
        },
      ]);
    });

    it('the same job on gpu:0 encodes with NVENC on GPU 0', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const { args, encodedOn } = await encode(hevc('auto'), false);
      expect(args).toMatch(/-c:0 hevc_nvenc .*-gpu:0 0/);
      expect(args).not.toContain('-init_hw_device');
      expect(encodedOn).toBe('GPU 0 · RTX 3060');
    });

    it('the plain Encode slot (no device) records no GPU', async () => {
      await setup({ capabilities: { ...caps, hwaccels: ['cuda'] } });
      const { args, encodedOn } = await encode(flow('h264', 'auto'), false, 'h264');
      expect(args).toContain('-c:0 h264_nvenc');
      expect(t.deps.engine.scheduler.status().encodeSlots.map((s) => s.id)).toEqual(['encode']);
      expect(encodedOn).toBeNull();
    });

    it.each([
      ['intel:0000:07:00.0', '-c:0 hevc_qsv', 'Intel Arc A310 · 07:00.0'],
      ['nvidia:0', '-c:0 hevc_nvenc', 'GPU 0 · RTX 3060'],
    ])('pinned to %s, the one Encode slot records the GPU by name', async (device, codec, name) => {
      await setup({ capabilities: mixed(['cuda']) });
      setSetting(t.db, 'engine.encodeDevice', device, t.clock.now());
      const { args, encodedOn } = await encode(hevc('auto'), false);
      expect(args).toContain(codec);
      expect(t.deps.engine.scheduler.status().encodeSlots).toEqual([
        { id: 'encode', label: 'Encode', jobId: null },
      ]);
      expect(encodedOn).toBe(name);
    });

    it('a workflow that names hevc_nvenc is not retargeted to Quick Sync, even with Intel first', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const { args } = await encode(hevc('hevc_nvenc'), true);
      expect(args).toContain('-c:0 hevc_nvenc');
      expect(args).not.toContain('hevc_qsv');
    });

    it('a workflow that names hevc_nvenc prepares with fit nvidia and takes the NVIDIA slot, even with Intel first', async () => {
      await setup({ capabilities: mixed(['cuda']) });
      const prepare = vi.spyOn(t.deps.engine.pipeline, 'prepare');
      const { args, encodedOn } = await encode(hevc('hevc_nvenc'), true);
      await expect(prepare.mock.results[0]?.value).resolves.toEqual({
        lane: 'encode',
        fit: 'nvidia',
      });
      expect(args).toMatch(/-c:0 hevc_nvenc .*-gpu:0 0/);
      expect(encodedOn).toBe('GPU 0 · RTX 3060');
    });

    it.each([
      ['auto', 'gpu'],
      ['libx265', 'software'],
    ])('a %s job prepares with fit %s', async (encoder, fit) => {
      await setup({ capabilities: mixed(['cuda']) });
      const prepare = vi.spyOn(t.deps.engine.pipeline, 'prepare');
      await encode(hevc(encoder), false);
      await expect(prepare.mock.results[0]?.value).resolves.toEqual({ lane: 'encode', fit });
    });

    it('without the CUDA hwaccel an auto QSV job prepares with fit intel and takes the Intel slot, even with GPU 0 first', async () => {
      await setup({ capabilities: mixed([]) });
      const prepare = vi.spyOn(t.deps.engine.pipeline, 'prepare');
      const { args, encodedOn } = await encode(hevc('auto'), false);
      await expect(prepare.mock.results[0]?.value).resolves.toEqual({
        lane: 'encode',
        fit: 'intel',
      });
      expect(args).toContain('-c:0 hevc_qsv');
      expect(args).toContain('child_device=/dev/dri/renderD128');
      expect(args).not.toContain('nvenc');
      expect(encodedOn).toBe('Intel Arc A310 · 07:00.0');
    });
  });
});
