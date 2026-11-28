// Which encode slot a job takes: its fit (any GPU, one vendor's, software) against the free slots.
import type { EncodeSlot } from '../../capabilities/devices.ts';
import { deviceVendor } from '../model/model.ts';

/**
 * The encode slots a job fits: any GPU (its encoders were auto-picked), one vendor's (a node named
 * that vendor's encoder), or any slot, preferring the last (software only).
 */
export type SlotFit = 'gpu' | 'nvidia' | 'intel' | 'software';

/**
 * The slot a job with `fit` takes from `free` (`all`: every slot, in GPU order), skipping the GPUs
 * in `failed`; undefined when none fits. A slot with no device fits everything. A vendor job takes
 * the first free slot of its vendor, or the first free slot when there is no slot of its vendor
 * at all (none when its vendor's slots all failed: it never moves to the other vendor).
 */
export function pickSlot(
  free: EncodeSlot[],
  all: EncodeSlot[],
  fit: SlotFit,
  failed: readonly string[] = [],
): EncodeSlot | undefined {
  const usable = (s: EncodeSlot) => s.gpuId === null || !failed.includes(s.gpuId);
  const open = free.filter(usable);
  if (fit === 'gpu') return open[0];
  if (fit === 'software') return open.at(-1);
  const fits = (s: EncodeSlot) => s.device === null || deviceVendor(s.device) === fit;
  return all.some(fits) ? open.find(fits) : open[0];
}
