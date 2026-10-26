// The GPUs this machine has, and what the "Encoding device" setting makes of them: which encoders
// Encode video may use and which device the render names.
import type { Capabilities, Gpu } from '@transcoda/contract';
import { z } from 'zod';
import type { Database } from '../db/open.ts';
import { getSetting, SETTING_DEFAULTS, SETTING_KEYS } from '../db/repos/settings.ts';
import type { RenderDevice } from '../engine/render.ts';
import { defaultExec, type Exec } from './ffmpeg.ts';

export type { Gpu };

/** The setting's value, parsed: `auto`, `cpu` or `nvidia:<index>`. */
export type EncodeDevice = { kind: 'auto' } | { kind: 'cpu' } | { kind: 'nvidia'; index: number };

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

/** NVIDIA GPUs from `nvidia-smi -L`. Never throws: no nvidia-smi means none detected. */
export async function probeGpus(exec: Exec = defaultExec): Promise<Gpu[]> {
  try {
    return parseNvidiaSmiList((await exec('nvidia-smi', ['-L'])).stdout);
  } catch {
    return [];
  }
}

/** A stored setting value; anything unknown reads as `auto`. */
export function parseEncodeDevice(value: string): EncodeDevice {
  if (value === 'cpu') return { kind: 'cpu' };
  const m = /^nvidia:(\d+)$/.exec(value);
  return m?.[1] ? { kind: 'nvidia', index: Number(m[1]) } : { kind: 'auto' };
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

/**
 * What the setting means on this machine: the device to render (null: ffmpeg's default, or none),
 * and whether a chosen GPU is missing (it then acts as CPU only). GPU 0 counts as present when
 * ffmpeg has NVENC but nvidia-smi listed nothing (a container without the utility).
 */
export function devicePlan(
  caps: Capabilities,
  setting: EncodeDevice,
): { device: RenderDevice | null; missing: boolean } {
  if (setting.kind !== 'nvidia') return { device: null, missing: false };
  const gpus = caps.available ? (caps.gpus ?? []) : [];
  const found =
    gpus.some((g) => g.index === setting.index) ||
    (gpus.length === 0 && setting.index === 0 && hasNvenc(caps));
  return found
    ? { device: { kind: 'cuda', index: setting.index }, missing: false }
    : { device: null, missing: true };
}

/**
 * The capabilities Encode video and validation see under the setting: CPU only (or a missing GPU)
 * drops every hardware encoder and hwaccel; an NVIDIA GPU keeps NVENC and CUDA only. Auto: as is.
 */
export function effectiveCapabilities(caps: Capabilities, setting: EncodeDevice): Capabilities {
  if (!caps.available || setting.kind === 'auto') return caps;
  const gpu = setting.kind === 'nvidia' && !devicePlan(caps, setting).missing;
  return {
    ...caps,
    encoders: caps.encoders.filter((e) => !isHardwareEncoder(e) || (gpu && e.endsWith('_nvenc'))),
    hwaccels: gpu ? caps.hwaccels.filter((h) => h === 'cuda') : [],
  };
}

/** Where an encode job can run: its own job at a time, on `device` when it encodes with NVENC. */
export interface EncodeSlot {
  id: string;
  label: string;
  /** The GPU the job decodes and encodes on; null: ffmpeg's default (or the CPU). */
  device: RenderDevice | null;
}

/**
 * The encode lane's slots: with `auto` and two or more NVIDIA GPUs (and NVENC in ffmpeg), one per
 * GPU, so encodes run side by side. Otherwise the one slot there always was, on the pinned GPU
 * if the setting names one. A software encode takes any free slot (its device flags do nothing).
 */
export function encodeSlots(caps: Capabilities, setting: EncodeDevice): EncodeSlot[] {
  const gpus = caps.available ? (caps.gpus ?? []) : [];
  if (setting.kind === 'auto' && gpus.length >= 2 && hasNvenc(caps)) {
    return gpus.map((g) => ({
      id: `gpu:${g.index}`,
      label: `GPU ${g.index} · ${g.name}`,
      device: { kind: 'cuda', index: g.index },
    }));
  }
  return [{ id: 'encode', label: 'Encode', device: devicePlan(caps, setting).device }];
}
