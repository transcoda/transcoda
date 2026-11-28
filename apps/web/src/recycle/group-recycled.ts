import type { RecycledEntry } from '@transcoda/contract';

/** Name order with numbers read as numbers, so episode 9 comes before episode 10. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byPath = (a: RecycledEntry, b: RecycledEntry): number =>
  byName.compare(a.relativePath, b.relativePath);

/**
 * The Recycle page's rows: each subtitle file (`sidecar`) sits under its job's `original` (it
 * comes back with it); one without that original is a row of its own. Rows are in name order of
 * where each file came from, and so are the subtitle files under an original; entries with the
 * same name keep the server's order (oldest recycled first).
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
  return order
    .sort(byPath)
    .map((entry) => ({ entry, sidecars: (groups.get(entry) ?? []).sort(byPath) }));
}
