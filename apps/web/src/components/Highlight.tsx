/**
 * `text` with every case-insensitive occurrence of the trimmed `query` wrapped in a
 * `<mark className="search-hit">` (the same substring match a search filter uses, see
 * `matchesQuery`). A blank query, or one that is not found, gives the text unchanged. The text
 * reads the same to assistive tech; only the look changes.
 */
export function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (q === '') return <>{text}</>;
  // Matched on the original text: offsets taken from `text.toLowerCase()` drift where lowercasing
  // changes a character's length (e.g. "İ").
  const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const parts: (string | { hit: string; at: number })[] = [];
  let from = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > from) parts.push(text.slice(from, m.index));
    parts.push({ hit: m[0], at: m.index });
    from = m.index + m[0].length;
  }
  if (parts.length === 0) return <>{text}</>;
  if (from < text.length) parts.push(text.slice(from));
  return (
    <>
      {parts.map((p) =>
        typeof p === 'string' ? (
          p
        ) : (
          <mark key={p.at} className="search-hit">
            {p.hit}
          </mark>
        ),
      )}
    </>
  );
}
