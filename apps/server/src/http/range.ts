/**
 * Reads a `Range` header for a file of `size` bytes. Only one `bytes=` range is honoured
 * (`a-b`, `a-`, `-n`; the end is clamped to the last byte). No header, a malformed one or several
 * ranges → null (serve the whole file with 200). A range that starts past the end, a zero-length
 * suffix or any range on an empty file → `'unsatisfiable'` (416).
 */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const n = Number(b);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (b !== '' && Number(b) < start) return null;
  if (size === 0 || start >= size) return 'unsatisfiable';
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  return { start, end };
}
