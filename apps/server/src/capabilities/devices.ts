// The GPUs this machine has, and what the "Encoding device" setting makes of them: which encoders
// Encode video may use and which device the render names.
import { constants } from 'node:fs';
import { type FileHandle, open, readdir, readFile, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { type Capabilities, type Gpu, GpuIdSchema } from '@transcoda/contract';
import { z } from 'zod';
import type { Database } from '../db/open.ts';
import { getSetting, SETTING_DEFAULTS, SETTING_KEYS } from '../db/repos/settings.ts';
import type { RenderDevice } from '../engine/render.ts';
import { defaultExec, type Exec } from './ffmpeg.ts';

export type { Gpu };

/** The setting's value, parsed: `auto`, `cpu`, `nvidia:<index>` or `intel:<pci address>`. */
export type EncodeDevice =
  | { kind: 'auto' }
  | { kind: 'cpu' }
  | { kind: 'nvidia'; index: number }
  | { kind: 'intel'; pci: string };

/** `GPU 0: NVIDIA GeForce RTX 3060 (UUID: GPU-…)` lines of `nvidia-smi -L`; MIG lines are indented. */
export function parseNvidiaSmiList(stdout: string): Gpu[] {
  const gpus: Gpu[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^GPU (\d+): (.+?)(?: \(UUID: [^)]*\))?\s*$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const index = Number(m[1]);
    gpus.push({ id: `nvidia:${index}`, vendor: 'nvidia', index, name: m[2] });
  }
  return gpus;
}

/** The bits of /sys and /dev/dri the Intel probe reads, so tests can stand in for them. */
export interface SysFs {
  /** Names of the render nodes (`renderD128`, …). */
  listRenderNodes(): Promise<string[]>;
  readFile(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  /** Whether the node can be opened for reading (it is closed again at once). */
  canOpen(path: string): Promise<boolean>;
}

const realSysFs: SysFs = {
  listRenderNodes: async () =>
    (await readdir('/sys/class/drm')).filter((n) => /^renderD\d+$/.test(n)),
  readFile: (path) => readFile(path, 'utf8'),
  realpath: (path) => realpath(path),
  canOpen: async (path) => {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY);
      return true;
    } catch {
      return false;
    } finally {
      await handle?.close();
    }
  },
};

/** Intel's PCI vendor id, as the sysfs `device/vendor` file prints it. */
const INTEL_VENDOR = '0x8086';

/** Arc (DG2) device ids, from Intel's public PCI id list. */
const INTEL_NAMES: Record<string, string> = {
  '56a0': 'Intel Arc A770',
  '56a1': 'Intel Arc A750',
  '56a2': 'Intel Arc A580',
  '56a3': 'Intel Arc Xe Graphics',
  '56a4': 'Intel Arc Xe Graphics',
  '56a5': 'Intel Arc A380',
  '56a6': 'Intel Arc A310',
  '56b0': 'Intel Arc Pro A30M',
  '56b1': 'Intel Arc Pro A40/A50',
  '56b2': 'Intel Arc Pro A60M',
  '56b3': 'Intel Arc Pro A60',
};

/** A device id such as `0x56a6` as a name; an unknown one reads `Intel GPU 56a6`. */
export function intelName(deviceId: string): string {
  const id = deviceId.trim().toLowerCase().replace(/^0x/, '');
  return INTEL_NAMES[id] ?? `Intel GPU ${id}`;
}

/**
 * Intel GPUs from the DRM render nodes: vendor 0x8086 and openable. Sorted by PCI address (index
 * 0, 1, …). Never throws: no /sys/class/drm (macOS, some containers) means none detected.
 */
export async function probeIntelGpus(fs: SysFs = realSysFs): Promise<Gpu[]> {
  try {
    const found: Omit<Gpu, 'index'>[] = [];
    for (const node of await fs.listRenderNodes()) {
      try {
        const dev = `/sys/class/drm/${node}/device`;
        if ((await fs.readFile(`${dev}/vendor`)).trim().toLowerCase() !== INTEL_VENDOR) continue;
        const renderNode = `/dev/dri/${node}`;
        if (!(await fs.canOpen(renderNode))) continue;
        const pci = basename(await fs.realpath(dev));
        const name = intelName(await fs.readFile(`${dev}/device`));
        found.push({ id: `intel:${pci}`, vendor: 'intel', name, renderNode, pci });
      } catch {
        // a node that cannot be read is not a usable GPU
      }
    }
    found.sort((a, b) => (a.pci ?? '').localeCompare(b.pci ?? ''));
    return found.map((g, index) => ({ ...g, index }));
  } catch {
    return [];
  }
}

/** NVIDIA GPUs from `nvidia-smi -L`, then Intel GPUs from the render nodes. Never throws. */
export async function probeGpus(exec: Exec = defaultExec, fs?: SysFs): Promise<Gpu[]> {
  let nvidia: Gpu[] = [];
  try {
    nvidia = parseNvidiaSmiList((await exec('nvidia-smi', ['-L'])).stdout);
  } catch {
    // no nvidia-smi: no NVIDIA GPU detected
  }
  return [...nvidia, ...(await probeIntelGpus(fs))];
}

/**
 * ffmpeg lists every hardware encoder it was built with (jellyfin-ffmpeg has them all), GPU or not,
 * and auto picks the first one it lists. So the ones this machine cannot run are dropped at start,
 * and jobs encode in software from the start instead of failing over on every job (and the job page
 * says what really ran):
 * - NVENC: with an NVIDIA GPU listed by nvidia-smi it is taken as working. Without one, a one-frame
 *   test encode decides: a GPU behind a container without nvidia-smi passes, a machine with no
 *   NVIDIA GPU or driver fails ("Cannot load libcuda.so.1"). A failure drops the NVENC encoders
 *   and the cuda hwaccel.
 * - Quick Sync and VA-API: they need a render node (`/dev/dri/renderD*`) this process can open.
 *   With none (a container without the device passed in) their encoders and hwaccels are dropped.
 * `dropped` says what went and why, for the log. Never throws.
 */
export async function usableHardware(
  caps: Capabilities,
  exec: Exec = defaultExec,
  fs: SysFs = realSysFs,
): Promise<{ capabilities: Capabilities; dropped: string[] }> {
  if (!caps.available) return { capabilities: caps, dropped: [] };
  let { encoders, hwaccels } = caps;
  const dropped: string[] = [];
  const nvencWhy = await nvencFailure(caps, exec);
  if (nvencWhy !== null) {
    encoders = encoders.filter((e) => !e.endsWith('_nvenc'));
    hwaccels = hwaccels.filter((h) => h !== 'cuda');
    dropped.push(`NVENC (${nvencWhy})`);
  }
  const dri = /_(qsv|vaapi)$/;
  if (encoders.some((e) => dri.test(e)) && !(await anyRenderNode(fs))) {
    encoders = encoders.filter((e) => !dri.test(e));
    hwaccels = hwaccels.filter((h) => h !== 'qsv' && h !== 'vaapi');
    dropped.push('Quick Sync and VA-API (no /dev/dri render node)');
  }
  return dropped.length === 0
    ? { capabilities: caps, dropped }
    : { capabilities: { ...caps, encoders, hwaccels }, dropped };
}

/** Why NVENC cannot run here, or null when it can (or there is none to test). */
async function nvencFailure(caps: Capabilities, exec: Exec): Promise<string | null> {
  if (!hasNvenc(caps) || !caps.available) return null;
  if ((caps.gpus ?? []).some((g) => g.vendor === 'nvidia')) return null;
  const nvenc = caps.encoders.filter((e) => e.endsWith('_nvenc'));
  const encoder = nvenc.includes('h264_nvenc') ? 'h264_nvenc' : (nvenc[0] ?? 'h264_nvenc');
  try {
    await exec(
      caps.path,
      [
        ...['-hide_banner', '-nostdin', '-v', 'error'],
        ...['-f', 'lavfi', '-i', 'color=c=black:s=256x144:r=1'],
        ...['-frames:v', '1', '-c:v', encoder, '-f', 'null', '-'],
      ],
      { timeoutMs: 15_000 },
    );
    return null;
  } catch (e) {
    // ffmpeg's first line says why ("Cannot load libcuda.so.1"); the rest follow from it.
    const stderr = (e as { stderr?: unknown }).stderr;
    const first = typeof stderr === 'string' ? stderr.trim().split('\n')[0] : undefined;
    return first?.replace(/^\[[^\]]*\]\s*/, '') || (e instanceof Error ? e.message : String(e));
  }
}

/** Whether any render node can be opened (sysfs may list the host's nodes inside a container). */
async function anyRenderNode(fs: SysFs): Promise<boolean> {
  let nodes: string[];
  try {
    nodes = await fs.listRenderNodes();
  } catch {
    return false;
  }
  for (const n of nodes) if (await fs.canOpen(`/dev/dri/${n}`)) return true;
  return false;
}

/** A stored setting value; anything unknown reads as `auto`. */
export function parseEncodeDevice(value: string): EncodeDevice {
  if (value === 'cpu') return { kind: 'cpu' };
  const m = /^nvidia:(\d+)$/.exec(value);
  if (m?.[1]) return { kind: 'nvidia', index: Number(m[1]) };
  const i = /^intel:([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7])$/.exec(value);
  return i?.[1] ? { kind: 'intel', pci: i[1] } : { kind: 'auto' };
}

/** The stored "GPU order"; a missing or corrupt row is the default (empty). */
export function readGpuOrder(db: Database): string[] {
  try {
    return (
      getSetting(db, SETTING_KEYS.gpuOrder, z.array(GpuIdSchema).max(16)) ?? [
        ...SETTING_DEFAULTS.gpuOrder,
      ]
    );
  } catch {
    return [];
  }
}

/** `gpus` in the given order: listed ids first (unknown ones skipped), then the rest as they were. */
export function orderGpus(gpus: Gpu[], order: string[]): Gpu[] {
  const out: Gpu[] = [];
  for (const id of order) {
    const g = gpus.find((x) => x.id === id);
    if (g && !out.includes(g)) out.push(g);
  }
  return [...out, ...gpus.filter((g) => !out.includes(g))];
}

/** The stored "Encoding device"; a missing or corrupt row is `auto`. */
export function readEncodeDevice(db: Database): EncodeDevice {
  try {
    return parseEncodeDevice(
      getSetting(db, SETTING_KEYS.encodeDevice, z.string()) ?? SETTING_DEFAULTS.encodeDevice,
    );
  } catch {
    return { kind: 'auto' };
  }
}

const HARDWARE = /_(nvenc|qsv|vaapi|amf|videotoolbox|v4l2m2m|mf|vulkan)$/;

/** An encoder that runs on a GPU (or other media engine) rather than the CPU. */
export function isHardwareEncoder(encoder: string): boolean {
  return HARDWARE.test(encoder);
}

/** ffmpeg's NVENC encoders mean an NVIDIA GPU is there even when nvidia-smi is not. */
function hasNvenc(caps: Capabilities): boolean {
  return caps.available && caps.encoders.some((e) => e.endsWith('_nvenc'));
}

/** An Intel GPU only encodes when ffmpeg has a QSV encoder. */
function hasQsv(caps: Capabilities): boolean {
  return caps.available && caps.encoders.some((e) => e.endsWith('_qsv'));
}

function intelDevice(g: Gpu): RenderDevice | null {
  return g.renderNode ? { kind: 'qsv', renderNode: g.renderNode } : null;
}

/**
 * What the setting means on this machine: the device to render (null: ffmpeg's default, or none),
 * and whether a chosen GPU is missing (it then acts as CPU only). GPU 0 counts as present when
 * ffmpeg has NVENC but nvidia-smi listed nothing (a container without the utility).
 */
export function devicePlan(
  caps: Capabilities,
  setting: EncodeDevice,
): { device: RenderDevice | null; missing: boolean } {
  const gpus = caps.available ? (caps.gpus ?? []) : [];
  if (setting.kind === 'intel') {
    const gpu = gpus.find((g) => g.vendor === 'intel' && g.pci === setting.pci);
    const device = gpu ? intelDevice(gpu) : null;
    return device ? { device, missing: false } : { device: null, missing: true };
  }
  if (setting.kind !== 'nvidia') return { device: null, missing: false };
  const nvidia = gpus.filter((g) => g.vendor === 'nvidia');
  const found =
    nvidia.some((g) => g.index === setting.index) ||
    (nvidia.length === 0 && setting.index === 0 && hasNvenc(caps));
  return found
    ? { device: { kind: 'cuda', index: setting.index }, missing: false }
    : { device: null, missing: true };
}

/**
 * The capabilities Encode video and validation see under the setting: CPU only (or a missing GPU)
 * drops every hardware encoder and hwaccel; an NVIDIA GPU keeps NVENC and CUDA only, an Intel GPU
 * QSV only. Auto: as is.
 */
export function effectiveCapabilities(caps: Capabilities, setting: EncodeDevice): Capabilities {
  if (!caps.available || setting.kind === 'auto') return caps;
  const present =
    (setting.kind === 'nvidia' || setting.kind === 'intel') && !devicePlan(caps, setting).missing;
  const [suffix, hwaccel] = setting.kind === 'intel' ? ['_qsv', 'qsv'] : ['_nvenc', 'cuda'];
  return {
    ...caps,
    encoders: caps.encoders.filter((e) => !isHardwareEncoder(e) || (present && e.endsWith(suffix))),
    hwaccels: present ? caps.hwaccels.filter((h) => h === hwaccel) : [],
  };
}

/** Where an encode job can run: its own job at a time, on `device` when it encodes on that GPU. */
export interface EncodeSlot {
  id: string;
  label: string;
  /** The GPU the job decodes and encodes on; null: ffmpeg's default (or the CPU). */
  device: RenderDevice | null;
  /** The `Gpu.id` it runs on; null for the plain `encode` slot without a device. */
  gpuId: string | null;
}

/** A GPU's name with what tells identical cards apart, as the encode slots label them. */
export function gpuLabel(g: Gpu): string {
  if (g.vendor === 'nvidia') return g.name ? `GPU ${g.index} · ${g.name}` : `GPU ${g.index}`;
  return `${g.name} · ${(g.pci ?? '').replace(/^0000:/, '')}`;
}

/**
 * The name of the GPU a slot encodes on, for the job's "Encoded on": a per-GPU slot's label, or
 * the pinned GPU's name for the one plain slot (whose label is only "Encode").
 */
export function slotGpuLabel(slot: EncodeSlot, caps: Capabilities): string {
  if (slot.id !== 'encode' || slot.gpuId === null) return slot.label;
  const gpu = (caps.available ? (caps.gpus ?? []) : []).find((g) => g.id === slot.gpuId);
  if (gpu) return gpuLabel(gpu);
  // NVENC without nvidia-smi: an unnamed GPU
  return slot.device?.kind === 'cuda' ? `GPU ${slot.device.index}` : slot.label;
}

/** The GPU ids of a slot's device, when the device names one. */
function deviceGpuId(device: RenderDevice | null, caps: Capabilities): string | null {
  if (device?.kind === 'cuda') return `nvidia:${device.index}`;
  if (device?.kind !== 'qsv') return null;
  const node = device.renderNode;
  return (caps.available ? caps.gpus : undefined)?.find((g) => g.renderNode === node)?.id ?? null;
}

/**
 * The GPUs auto can encode on, in the GPU order: NVIDIA ones when ffmpeg has NVENC (GPU 0 unnamed
 * when nvidia-smi listed none, as devicePlan counts it), Intel ones with a render node when ffmpeg
 * has a QSV encoder.
 */
export function usableGpus(caps: Capabilities, order: string[] = []): Gpu[] {
  const listed = caps.available ? (caps.gpus ?? []) : [];
  const unnamed: Gpu[] =
    hasNvenc(caps) && !listed.some((g) => g.vendor === 'nvidia')
      ? [{ id: 'nvidia:0', vendor: 'nvidia', index: 0, name: '' }]
      : [];
  return orderGpus([...unnamed, ...listed], order).filter((g) =>
    g.vendor === 'nvidia' ? hasNvenc(caps) : hasQsv(caps) && g.renderNode !== undefined,
  );
}

/**
 * The encode lane's slots: with `auto` and two or more usable GPUs (NVIDIA with NVENC in ffmpeg,
 * Intel with a QSV encoder), one per GPU in the GPU order, so encodes run side by side. Otherwise
 * the one slot there always was, on the pinned GPU if the setting names one (or on the only usable
 * Intel GPU). A software encode takes any free slot (its device flags do nothing).
 */
export function encodeSlots(
  caps: Capabilities,
  setting: EncodeDevice,
  order: string[] = [],
): EncodeSlot[] {
  const gpus = usableGpus(caps, order);
  if (setting.kind === 'auto' && gpus.length >= 2) {
    return gpus.flatMap((g): EncodeSlot[] => {
      if (g.vendor === 'nvidia') {
        return [
          {
            id: `gpu:${g.index}`,
            label: gpuLabel(g),
            device: { kind: 'cuda', index: g.index },
            gpuId: g.id,
          },
        ];
      }
      const device = intelDevice(g);
      return device
        ? [
            {
              id: `gpu:${g.id}`,
              label: gpuLabel(g),
              device,
              gpuId: g.id,
            },
          ]
        : [];
    });
  }
  const only = gpus[0];
  if (setting.kind === 'auto' && gpus.length === 1 && only?.vendor === 'intel') {
    return [{ id: 'encode', label: 'Encode', device: intelDevice(only), gpuId: only.id }];
  }
  const { device } = devicePlan(caps, setting);
  return [{ id: 'encode', label: 'Encode', device, gpuId: deviceGpuId(device, caps) }];
}
