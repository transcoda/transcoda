import type { Capabilities } from '@transcoda/contract';
import { describe, expect, it } from 'vitest';
import {
  devicePlan,
  effectiveCapabilities,
  encodeSlots,
  type Gpu,
  isHardwareEncoder,
  parseEncodeDevice,
  parseNvidiaSmiList,
  probeGpus,
} from './devices.ts';
import type { Exec } from './ffmpeg.ts';

const SMI = [
  'GPU 0: NVIDIA GeForce RTX 3060 (UUID: GPU-11111111-2222-3333-4444-555555555555)',
  '  MIG 1g.5gb     Device  0: (UUID: MIG-aaaaaaaa)',
  'GPU 1: NVIDIA RTX A2000 12GB (UUID: GPU-66666666-7777-8888-9999-000000000000)',
  '',
].join('\n');

const rtx: Gpu = { id: 'nvidia:0', vendor: 'nvidia', index: 0, name: 'NVIDIA GeForce RTX 3060' };
const a2000: Gpu = { id: 'nvidia:1', vendor: 'nvidia', index: 1, name: 'NVIDIA RTX A2000 12GB' };

const caps = (gpus?: Gpu[]): Capabilities => ({
  available: true,
  path: '/usr/bin/ffmpeg',
  version: '7.1',
  encoders: ['libx265', 'libx264', 'hevc_nvenc', 'h264_nvenc', 'hevc_qsv', 'hevc_vaapi', 'aac'],
  hwaccels: ['cuda', 'vaapi', 'qsv'],
  filters: ['scale'],
  ...(gpus ? { gpus } : {}),
});

describe('parseNvidiaSmiList', () => {
  it('reads each GPU line (index and name), not MIG lines', () => {
    expect(parseNvidiaSmiList(SMI)).toEqual([rtx, a2000]);
  });

  it('nothing for empty or foreign output', () => {
    expect(parseNvidiaSmiList('')).toEqual([]);
    expect(parseNvidiaSmiList('NVIDIA-SMI has failed')).toEqual([]);
  });
});

describe('probeGpus', () => {
  it('runs nvidia-smi -L', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (file, args) => {
      calls.push([file, ...args]);
      return { stdout: SMI, stderr: '' };
    };
    expect(await probeGpus(exec)).toEqual([rtx, a2000]);
    expect(calls).toEqual([['nvidia-smi', '-L']]);
  });

  it('no nvidia-smi (or a failing one) means no detected GPU, never an error', async () => {
    const exec: Exec = async () => {
      throw new Error('spawn nvidia-smi ENOENT');
    };
    expect(await probeGpus(exec)).toEqual([]);
  });
});

describe('parseEncodeDevice', () => {
  it('auto, cpu and nvidia:<n>; anything else is auto', () => {
    expect(parseEncodeDevice('auto')).toEqual({ kind: 'auto' });
    expect(parseEncodeDevice('cpu')).toEqual({ kind: 'cpu' });
    expect(parseEncodeDevice('nvidia:1')).toEqual({ kind: 'nvidia', index: 1 });
    expect(parseEncodeDevice('nvidia:x')).toEqual({ kind: 'auto' });
    expect(parseEncodeDevice('gpu')).toEqual({ kind: 'auto' });
  });
});

describe('isHardwareEncoder', () => {
  it('names the GPU encoder families', () => {
    for (const e of ['hevc_nvenc', 'h264_qsv', 'av1_vaapi', 'hevc_amf', 'h264_videotoolbox']) {
      expect(isHardwareEncoder(e)).toBe(true);
    }
    for (const e of ['libx265', 'libsvtav1', 'aac', 'srt'])
      expect(isHardwareEncoder(e)).toBe(false);
  });
});

describe('devicePlan / effectiveCapabilities', () => {
  it('auto changes nothing and names no device', () => {
    const c = caps([rtx, a2000]);
    expect(devicePlan(c, { kind: 'auto' })).toEqual({ device: null, missing: false });
    expect(effectiveCapabilities(c, { kind: 'auto' })).toBe(c);
  });

  it('cpu: no hardware encoder and no hwaccel, so auto picks software', () => {
    const c = effectiveCapabilities(caps([rtx]), { kind: 'cpu' });
    expect(c.available && c.encoders).toEqual(['libx265', 'libx264', 'aac']);
    expect(c.available && c.hwaccels).toEqual([]);
    expect(devicePlan(caps([rtx]), { kind: 'cpu' })).toEqual({ device: null, missing: false });
  });

  it('a detected NVIDIA GPU: NVENC only (no QSV/VAAPI), rendered on that CUDA index', () => {
    const d = { kind: 'nvidia', index: 1 } as const;
    const c = effectiveCapabilities(caps([rtx, a2000]), d);
    expect(c.available && c.encoders).toEqual([
      'libx265',
      'libx264',
      'hevc_nvenc',
      'h264_nvenc',
      'aac',
    ]);
    expect(c.available && c.hwaccels).toEqual(['cuda']);
    expect(devicePlan(caps([rtx, a2000]), d)).toEqual({
      device: { kind: 'cuda', index: 1 },
      missing: false,
    });
  });

  it('a GPU that is not detected acts as CPU only and says so', () => {
    const d = { kind: 'nvidia', index: 3 } as const;
    expect(devicePlan(caps([rtx]), d)).toEqual({ device: null, missing: true });
    const c = effectiveCapabilities(caps([rtx]), d);
    expect(c.available && c.encoders).toEqual(['libx265', 'libx264', 'aac']);
  });

  it('GPU 0 without nvidia-smi output still works when ffmpeg has NVENC (one unnamed GPU)', () => {
    const d = { kind: 'nvidia', index: 0 } as const;
    expect(devicePlan(caps(), d)).toEqual({ device: { kind: 'cuda', index: 0 }, missing: false });
  });

  it('ffmpeg missing: nothing to filter', () => {
    const none: Capabilities = { available: false, path: 'ffmpeg', error: 'ENOENT' };
    expect(effectiveCapabilities(none, { kind: 'cpu' })).toBe(none);
  });
});

describe('encodeSlots', () => {
  const one = [{ id: 'encode', label: 'Encode', device: null }];

  it('auto with two NVIDIA GPUs: one slot per GPU, each on its own CUDA index', () => {
    expect(encodeSlots(caps([rtx, a2000]), { kind: 'auto' })).toEqual([
      { id: 'gpu:0', label: 'GPU 0 · NVIDIA GeForce RTX 3060', device: { kind: 'cuda', index: 0 } },
      { id: 'gpu:1', label: 'GPU 1 · NVIDIA RTX A2000 12GB', device: { kind: 'cuda', index: 1 } },
    ]);
  });

  it('one GPU, none, or no NVENC in ffmpeg: the one encode slot of before', () => {
    expect(encodeSlots(caps([rtx]), { kind: 'auto' })).toEqual(one);
    expect(encodeSlots(caps([]), { kind: 'auto' })).toEqual(one);
    const both = caps([rtx, a2000]);
    const noNvenc: Capabilities = both.available ? { ...both, encoders: ['libx265'] } : both;
    expect(encodeSlots(noNvenc, { kind: 'auto' })).toEqual(one);
    const none: Capabilities = { available: false, path: 'ffmpeg', error: 'ENOENT' };
    expect(encodeSlots(none, { kind: 'auto' })).toEqual(one);
  });

  it('CPU only: one slot; a pinned GPU: one slot on that GPU', () => {
    expect(encodeSlots(caps([rtx, a2000]), { kind: 'cpu' })).toEqual(one);
    expect(encodeSlots(caps([rtx, a2000]), { kind: 'nvidia', index: 1 })).toEqual([
      { id: 'encode', label: 'Encode', device: { kind: 'cuda', index: 1 } },
    ]);
  });
});
