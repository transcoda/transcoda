import type { Capabilities } from '@transcoda/contract';
import { describe, expect, it } from 'vitest';
import { deviceVendor } from '../engine/render.ts';
import {
  devicePlan,
  effectiveCapabilities,
  encodeSlots,
  type Gpu,
  intelName,
  isHardwareEncoder,
  orderGpus,
  parseEncodeDevice,
  parseNvidiaSmiList,
  probeGpus,
  probeIntelGpus,
  type SysFs,
  slotGpuLabel,
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
    expect(await probeGpus(exec, fakeFs({}))).toEqual([rtx, a2000]);
    expect(calls).toEqual([['nvidia-smi', '-L']]);
  });

  it('no nvidia-smi (or a failing one) means no detected GPU, never an error', async () => {
    const exec: Exec = async () => {
      throw new Error('spawn nvidia-smi ENOENT');
    };
    expect(await probeGpus(exec, fakeFs({}))).toEqual([]);
  });
});

/** A fake /sys and /dev/dri: node name -> [vendor, device, PCI address, openable]. */
function fakeFs(nodes: Record<string, [string, string, string, boolean]> | null): SysFs {
  const node = (path: string) => {
    const name = /renderD\d+/.exec(path)?.[0] ?? '';
    const n = nodes?.[name];
    if (!n) throw new Error(`ENOENT ${path}`);
    return n;
  };
  return {
    listRenderNodes: async () => {
      if (!nodes) throw new Error('ENOENT /sys/class/drm');
      return Object.keys(nodes);
    },
    readFile: async (path) => `${path.endsWith('/vendor') ? node(path)[0] : node(path)[1]}\n`,
    realpath: async (path) => `/sys/devices/pci0000:00/0000:00:01.0/${node(path)[2]}`,
    canOpen: async (path) => node(path)[3],
  };
}

describe('probeIntelGpus', () => {
  it('an Intel render node becomes a GPU named from its device id', async () => {
    const fs = fakeFs({ renderD128: ['0x8086', '0x56a6', '0000:07:00.0', true] });
    expect(await probeIntelGpus(fs)).toEqual([
      {
        id: 'intel:0000:07:00.0',
        vendor: 'intel',
        index: 0,
        name: 'Intel Arc A310',
        renderNode: '/dev/dri/renderD128',
        pci: '0000:07:00.0',
      },
    ]);
  });

  it('skips other vendors (NVIDIA comes from nvidia-smi) and nodes that cannot be opened', async () => {
    const fs = fakeFs({
      renderD128: ['0x10de', '0x2504', '0000:01:00.0', true],
      renderD129: ['0x8086', '0x56a6', '0000:07:00.0', false],
    });
    expect(await probeIntelGpus(fs)).toEqual([]);
  });

  it('no /sys/class/drm means none, never an error', async () => {
    expect(await probeIntelGpus(fakeFs(null))).toEqual([]);
  });

  it('sorts by PCI address and numbers them from 0', async () => {
    const fs = fakeFs({
      renderD128: ['0x8086', '0x56a6', '0000:0a:00.0', true],
      renderD129: ['0x8086', '0x56a0', '0000:03:00.0', true],
    });
    const gpus = await probeIntelGpus(fs);
    expect(gpus.map((g) => [g.pci, g.index, g.renderNode])).toEqual([
      ['0000:03:00.0', 0, '/dev/dri/renderD129'],
      ['0000:0a:00.0', 1, '/dev/dri/renderD128'],
    ]);
  });
});

describe('intelName', () => {
  it('names known ids and falls back to the bare id', () => {
    expect(intelName('0x56a6')).toBe('Intel Arc A310');
    expect(intelName('0x9999')).toBe('Intel GPU 9999');
    expect(intelName('0x56a5')).toBe('Intel Arc A380');
  });
});

describe('probeGpus with Intel', () => {
  it('lists NVIDIA first, then Intel', async () => {
    const exec: Exec = async () => ({ stdout: SMI, stderr: '' });
    const fs = fakeFs({ renderD128: ['0x8086', '0x56a6', '0000:07:00.0', true] });
    expect((await probeGpus(exec, fs)).map((g) => g.id)).toEqual([
      'nvidia:0',
      'nvidia:1',
      'intel:0000:07:00.0',
    ]);
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

const arc: Gpu = {
  id: 'intel:0000:07:00.0',
  vendor: 'intel',
  index: 0,
  name: 'Intel Arc A310',
  renderNode: '/dev/dri/renderD128',
  pci: '0000:07:00.0',
};

describe('Intel GPUs', () => {
  const ids = (c: Capabilities, order?: string[]) =>
    encodeSlots(c, { kind: 'auto' }, order).map((s) => s.id);

  it('NVIDIA plus Intel under auto: one slot each, NVIDIA first', () => {
    expect(ids(caps([rtx, arc]))).toEqual(['gpu:0', 'gpu:intel:0000:07:00.0']);
    expect(encodeSlots(caps([rtx, arc]), { kind: 'auto' })[1]).toEqual({
      id: 'gpu:intel:0000:07:00.0',
      label: 'Intel Arc A310 · 07:00.0',
      device: { kind: 'qsv', renderNode: '/dev/dri/renderD128' },
      gpuId: 'intel:0000:07:00.0',
    });
  });

  it('the GPU order puts Intel first; a gone id is skipped', () => {
    expect(ids(caps([rtx, arc]), ['intel:0000:07:00.0', 'nvidia:0'])).toEqual([
      'gpu:intel:0000:07:00.0',
      'gpu:0',
    ]);
    expect(ids(caps([rtx, arc]), ['intel:0000:09:00.0', 'nvidia:0'])).toEqual([
      'gpu:0',
      'gpu:intel:0000:07:00.0',
    ]);
  });

  it('without a QSV encoder Intel is not usable: the one encode slot', () => {
    const c = caps([rtx, arc]);
    const noQsv: Capabilities = c.available ? { ...c, encoders: ['libx265', 'hevc_nvenc'] } : c;
    expect(encodeSlots(noQsv, { kind: 'auto' })).toEqual([
      { id: 'encode', label: 'Encode', device: null, gpuId: null },
    ]);
  });

  it('NVENC without nvidia-smi plus Intel: an unnamed GPU 0, then Intel', () => {
    const slots = encodeSlots(caps([arc]), { kind: 'auto' });
    expect(slots.map((s) => [s.id, s.label, s.gpuId])).toEqual([
      ['gpu:0', 'GPU 0', 'nvidia:0'],
      ['gpu:intel:0000:07:00.0', 'Intel Arc A310 · 07:00.0', 'intel:0000:07:00.0'],
    ]);
  });

  it('names the GPU a slot encodes on: the per-GPU label, or the pinned GPU for the plain slot', () => {
    const c = caps([rtx, arc]);
    const name = (d: Parameters<typeof encodeSlots>[1]) =>
      encodeSlots(c, d).map((s) => slotGpuLabel(s, c));
    expect(name({ kind: 'auto' })).toEqual([
      'GPU 0 · NVIDIA GeForce RTX 3060',
      'Intel Arc A310 · 07:00.0',
    ]);
    expect(name({ kind: 'intel', pci: '0000:07:00.0' })).toEqual(['Intel Arc A310 · 07:00.0']);
    expect(name({ kind: 'nvidia', index: 0 })).toEqual(['GPU 0 · NVIDIA GeForce RTX 3060']);
    // NVENC without nvidia-smi, pinned: an unnamed GPU 0; no device: the slot's own label
    const [pinned] = encodeSlots(caps([]), { kind: 'nvidia', index: 0 });
    expect(pinned && slotGpuLabel(pinned, caps([]))).toBe('GPU 0');
    const [plain] = encodeSlots(caps([]), { kind: 'auto' });
    expect(plain && slotGpuLabel(plain, caps([]))).toBe('Encode');
  });

  it('NVENC without nvidia-smi and no Intel: the one encode slot as before', () => {
    expect(encodeSlots(caps([]), { kind: 'auto' })).toEqual([
      { id: 'encode', label: 'Encode', device: null, gpuId: null },
    ]);
  });

  it('a single usable Intel GPU gets the one encode slot with its device', () => {
    const c = caps([arc]);
    const noNvenc: Capabilities = c.available
      ? { ...c, encoders: ['libx265', 'hevc_qsv'], hwaccels: ['qsv'] }
      : c;
    expect(encodeSlots(noNvenc, { kind: 'auto' })).toEqual([
      {
        id: 'encode',
        label: 'Encode',
        device: { kind: 'qsv', renderNode: '/dev/dri/renderD128' },
        gpuId: 'intel:0000:07:00.0',
      },
    ]);
  });

  it('pinned to Intel: one slot on it; effective capabilities keep QSV only', () => {
    const d = { kind: 'intel', pci: '0000:07:00.0' } as const;
    const c = caps([rtx, arc]);
    expect(encodeSlots(c, d)).toEqual([
      {
        id: 'encode',
        label: 'Encode',
        device: { kind: 'qsv', renderNode: '/dev/dri/renderD128' },
        gpuId: 'intel:0000:07:00.0',
      },
    ]);
    const e = effectiveCapabilities(c, d);
    expect(e.available && e.encoders).toEqual(['libx265', 'libx264', 'hevc_qsv', 'aac']);
    expect(e.available && e.hwaccels).toEqual(['qsv']);
  });

  it('pinned to a missing Intel GPU: CPU only', () => {
    const d = { kind: 'intel', pci: '0000:09:00.0' } as const;
    const c = caps([rtx, arc]);
    expect(devicePlan(c, d)).toEqual({ device: null, missing: true });
    const e = effectiveCapabilities(c, d);
    expect(e.available && e.encoders).toEqual(['libx265', 'libx264', 'aac']);
    expect(e.available && e.hwaccels).toEqual([]);
  });

  it('an Intel card does not satisfy nvidia:0', () => {
    const c = { ...caps([arc]), encoders: ['libx265'], hwaccels: [] };
    expect(devicePlan(c, { kind: 'nvidia', index: 0 })).toEqual({ device: null, missing: true });
  });

  it('parseEncodeDevice reads intel:<pci>', () => {
    expect(parseEncodeDevice('intel:0000:07:00.0')).toEqual({ kind: 'intel', pci: '0000:07:00.0' });
    expect(parseEncodeDevice('intel:7')).toEqual({ kind: 'auto' });
  });

  it('orderGpus: listed first in list order, unknown skipped, then the rest', () => {
    expect(
      orderGpus([rtx, a2000, arc], ['intel:0000:07:00.0', 'nvidia:9', 'nvidia:1']).map((g) => g.id),
    ).toEqual(['intel:0000:07:00.0', 'nvidia:1', 'nvidia:0']);
  });

  it('deviceVendor', () => {
    expect(deviceVendor({ kind: 'cuda', index: 0 })).toBe('nvidia');
    expect(deviceVendor({ kind: 'qsv', renderNode: '/dev/dri/renderD128' })).toBe('intel');
    expect(deviceVendor(null)).toBeNull();
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
  const one = [{ id: 'encode', label: 'Encode', device: null, gpuId: null }];

  it('auto with two NVIDIA GPUs: one slot per GPU, each on its own CUDA index', () => {
    expect(encodeSlots(caps([rtx, a2000]), { kind: 'auto' })).toEqual([
      {
        id: 'gpu:0',
        label: 'GPU 0 · NVIDIA GeForce RTX 3060',
        device: { kind: 'cuda', index: 0 },
        gpuId: 'nvidia:0',
      },
      {
        id: 'gpu:1',
        label: 'GPU 1 · NVIDIA RTX A2000 12GB',
        device: { kind: 'cuda', index: 1 },
        gpuId: 'nvidia:1',
      },
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
      { id: 'encode', label: 'Encode', device: { kind: 'cuda', index: 1 }, gpuId: 'nvidia:1' },
    ]);
  });
});
