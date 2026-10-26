import type { Capabilities } from '@transcoda/contract';
import type { RegisteredNode } from './registry.ts';

export type Availability = { available: true } | { available: false; reason: string };

/** Server settings that decide availability besides ffmpeg. */
export interface AvailabilityEnv {
  outputRoots: string[];
}

export const MOVE_COPY_TYPE = 'core:move-copy';
/** The size gate: `pass` continues, `else` keeps the original and runs the non-writing steps. */
export const SIZE_GATE_TYPE = 'core:size-gate';
export const SIZE_GATE_ELSE_PORT = 'else';

/** Callers pass the registry entry: a plugin node can be unavailable because its process is down. */
export function nodeAvailability(
  entry: RegisteredNode,
  caps: Capabilities,
  env: AvailabilityEnv,
): Availability {
  const { def } = entry;
  const down = entry.unavailable?.() ?? null;
  if (down !== null) return { available: false, reason: down };
  if (def.type === MOVE_COPY_TYPE && env.outputRoots.length === 0) {
    return { available: false, reason: 'no output roots configured (TRANSCODA_OUTPUT_ROOTS)' };
  }
  const { encoders = [], filters = [], hwaccels = [] } = def.requires ?? {};
  if (encoders.length + filters.length + hwaccels.length === 0) return { available: true };
  if (!caps.available) return { available: false, reason: 'ffmpeg is not available' };
  const missing = [
    ...encoders.filter((e) => !caps.encoders.includes(e)).map((e) => `encoder ${e}`),
    ...filters.filter((f) => !caps.filters.includes(f)).map((f) => `filter ${f}`),
    ...hwaccels.filter((h) => !caps.hwaccels.includes(h)).map((h) => `hwaccel ${h}`),
  ];
  return missing.length === 0
    ? { available: true }
    : { available: false, reason: `missing ${missing.join(', ')}` };
}
