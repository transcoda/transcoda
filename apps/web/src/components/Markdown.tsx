// A small Markdown subset for notes on the canvas: headings, paragraphs, bullet and numbered
// lists, **bold**, *italic*, `code` and [links](https://…). Everything becomes React elements;
// raw HTML is shown as text, so an imported workflow's note can never run script.
import { Fragment, type ReactNode } from 'react';

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] };

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;

function blocks(text: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) out.push({ kind: 'para', text: para.join(' ') });
    para = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (line.trim() === '') {
      flush();
    } else if (heading) {
      flush();
      out.push({ kind: 'heading', text: heading[1] ?? '' });
    } else if (bullet || numbered) {
      flush();
      const ordered = numbered !== null;
      const item = (bullet ?? numbered)?.[1] ?? '';
      const last = out.at(-1);
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(item);
      else out.push({ kind: 'list', ordered, items: [item] });
    } else {
      para.push(line.trim());
    }
  }
  flush();
  return out;
}

/** `**bold**`, `*italic*`, `` `code` `` and `[text](http…)`; anything else is plain text. */
const INLINE = /\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    const start = m.index ?? 0;
    if (start > at) out.push(text.slice(at, start));
    const key = out.length;
    if (m[1] !== undefined) out.push(<strong key={key}>{inline(m[1])}</strong>);
    else if (m[2] !== undefined) out.push(<em key={key}>{inline(m[2])}</em>);
    else if (m[3] !== undefined) out.push(<code key={key}>{m[3]}</code>);
    else if (m[4] !== undefined && /^https?:\/\//i.test(m[5] ?? '')) {
      out.push(
        <a key={key} href={m[5]} target="_blank" rel="noreferrer noopener">
          {m[4]}
        </a>,
      );
    } else out.push(m[4] ?? '');
    at = start + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function block(b: Block): ReactNode {
  if (b.kind === 'heading') return <h4>{inline(b.text)}</h4>;
  if (b.kind === 'para') return <p>{inline(b.text)}</p>;
  const items = b.items.map((item, j) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: list items have no id; the text is re-rendered whole.
    <li key={j}>{inline(item)}</li>
  ));
  return b.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      {blocks(text).map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no id; the text is re-rendered whole.
        <Fragment key={i}>{block(b)}</Fragment>
      ))}
    </div>
  );
}
