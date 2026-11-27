import type { RecycledEntry } from '@transcoda/contract';

/**
 * The Recycle page's rows: each subtitle file (`sidecar`) sits under its job's `original` (it
 * comes back with it); one without that original is a row of its own. Rows keep the entries'
 * order, a group taking the place of its original.
 */
export function groupRecycled(
  entries: RecycledEntry[],
): { entry: RecycledEntry; sidecars: RecycledEntry[] }[] {
  const originals = new Map<string, RecycledEntry>();
  for (const e of entries) {
    if (e.kind === 'original' && !originals.has(e.jobId)) originals.set(e.jobId, e);
  }
  const groups = new Map<RecycledEntry, RecycledEntry[]>();
  const order: RecycledEntry[] = [];
  for (const e of entries) {
    const owner = e.kind === 'sidecar' ? originals.get(e.jobId) : undefined;
    if (owner) {
      if (!groups.has(owner)) {
        groups.set(owner, []);
        order.push(owner);
      }
      groups.get(owner)?.push(e);
    } else if (!groups.has(e)) {
      groups.set(e, []);
      order.push(e);
    }
  }
  return order.map((entry) => ({ entry, sidecars: groups.get(entry) ?? [] }));
}
