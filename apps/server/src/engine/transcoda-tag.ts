import type { ProbeResult } from '@transcoda/sdk';

/**
 * The container-level tag every encode Transcoda writes carries: which workflows (and versions)
 * produced the file. Its value lists `<workflowId>@<version>` entries separated by commas, oldest
 * first and newest last; a file processed by workflow A and then B lists both. Matroska writes it
 * as a global tag (and upper-cases names), MP4 and MOV as a custom `mdta` key, which needs
 * `-movflags use_metadata_tags` (see renderArgs).
 */
export const TRANSCODA_TAG = 'TRANSCODA';
/** The most entries the tag keeps; older ones fall off the front. */
export const MAX_TAG_ENTRIES = 16;

export interface TagEntry {
  workflowId: string;
  version: number;
}

const ENTRY = /^([^\s,@]+)@([1-9]\d{0,8})$/;

/** The entries of a tag value, oldest first; malformed entries are skipped. */
export function parseTranscodaTag(value: string | null | undefined): TagEntry[] {
  if (!value) return [];
  const out: TagEntry[] = [];
  for (const part of value.split(',')) {
    const m = ENTRY.exec(part.trim());
    if (m) out.push({ workflowId: m[1] as string, version: Number(m[2]) });
  }
  return out;
}

export function formatTranscodaTag(entries: readonly TagEntry[]): string {
  return entries.map((e) => `${e.workflowId}@${e.version}`).join(',');
}

/** The value of the file's `TRANSCODA` format tag (any case, as Matroska upper-cases names). */
export function transcodaTagOf(probe: Pick<ProbeResult, 'raw'>): string | null {
  const raw = probe.raw;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const format = (raw as Record<string, unknown>).format;
  if (format === null || typeof format !== 'object' || Array.isArray(format)) return null;
  const tags = (format as Record<string, unknown>).tags;
  if (tags === null || typeof tags !== 'object' || Array.isArray(tags)) return null;
  for (const [k, v] of Object.entries(tags as Record<string, unknown>)) {
    if (k.toUpperCase() === TRANSCODA_TAG && typeof v === 'string') return v;
  }
  return null;
}

/**
 * The tag an output of `workflowId@version` made from this source carries: the source's entries
 * with this one appended (an earlier identical entry moves to the end), capped to the newest
 * MAX_TAG_ENTRIES.
 */
export function nextTranscodaTag(
  probe: Pick<ProbeResult, 'raw'>,
  workflowId: string,
  version: number,
): string {
  const entry: TagEntry = { workflowId, version };
  const entries = parseTranscodaTag(transcodaTagOf(probe)).filter(
    (e) => !(e.workflowId === workflowId && e.version === version),
  );
  entries.push(entry);
  return formatTranscodaTag(entries.slice(-MAX_TAG_ENTRIES));
}
