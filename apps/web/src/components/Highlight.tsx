/**
 * `text` with every case-insensitive occurrence of the trimmed `query` wrapped in a
 * `<mark className="search-hit">` (the same substring match a search filter uses, see
 * `matchesQuery`). A blank query, or one that is not found, gives the text unchanged. The text
 * reads the same to assistive tech; only the look changes.
 */
export function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (q === '') return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: (string | { hit: string; at: number })[] = [];
  let from = 0;
  for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push({ hit: text.slice(at, at + q.length), at });
    from = at + q.length;
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
