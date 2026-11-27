// A small tolerant reader for Kodi/Jellyfin `.nfo` sidecars: no XML dependency, never throws.

export type NfoRoot = 'movie' | 'tvshow' | 'episodedetails';

export interface Nfo {
  root: NfoRoot;
  title: string | null;
  showTitle: string | null;
  season: number | null;
  episode: number | null;
  year: number | null;
}

const ROOTS = new Set<string>(['movie', 'tvshow', 'episodedetails']);
const MAX_VALUE_LENGTH = 300;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** Before the root element: an XML declaration, processing instructions, comments, a doctype. */
const PROLOG = /(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|\s+)/iy;
const ROOT = /<([A-Za-z_][\w.-]*)(?=[\s/>]|$)/y;
const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (name !== undefined) return NAMED[name] ?? whole;
    const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** Decoded content: CDATA sections as is, the rest entity-decoded. */
function decodeContent(content: string): string {
  let out = '';
  let last = 0;
  for (const m of content.matchAll(CDATA)) {
    out += decodeEntities(content.slice(last, m.index)) + (m[1] as string);
    last = m.index + m[0].length;
  }
  return out + decodeEntities(content.slice(last));
}

const isSpace = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r';

/** `text` with only A–Z lower-cased, so every index still matches the original. */
const asciiLower = (text: string): string => text.replace(/[A-Z]+/g, (c) => c.toLowerCase());

/**
 * The trimmed text of the first `<tag>…</tag>` whose content holds no element (only text and
 * CDATA), capped at 300 characters; null when there is none or it is empty. `lower` is
 * `asciiLower(body)`. One forward scan: linear in the length of `body`, whatever it holds.
 */
function tagText(body: string, lower: string, tag: string): string | null {
  const open = `<${tag}`;
  const close = `</${tag}`;
  let pos = 0;
  let gt = -1; // the first '>' at or after the current opening (only moves forward)
  for (;;) {
    const start = lower.indexOf(open, pos);
    if (start === -1) return null;
    pos = start + 1;
    const after = lower[start + open.length];
    if (after !== '>' && !isSpace(after)) continue;
    if (gt < start) gt = lower.indexOf('>', start);
    if (gt === -1) return null;
    // An opening tag holds no '<' and is not self-closing.
    const lt = lower.indexOf('<', start + 1);
    if ((lt !== -1 && lt < gt) || body[gt - 1] === '/') continue;
    // The content: text and CDATA up to the next '<', which must be the closing tag.
    let i = gt + 1;
    for (;;) {
      const next = lower.indexOf('<', i);
      if (next === -1) return null;
      if (lower.startsWith('<![cdata[', next)) {
        const end = body.indexOf(']]>', next + 9);
        if (end === -1) return null;
        i = end + 3;
        continue;
      }
      const tail = lower[next + close.length];
      if (lower.startsWith(close, next) && (tail === '>' || isSpace(tail))) {
        const value = decodeContent(body.slice(gt + 1, next)).trim();
        if (value === '') return null;
        return Array.from(value).slice(0, MAX_VALUE_LENGTH).join('');
      }
      pos = next;
      break;
    }
  }
}

function intIn(text: string | null, min: number, max: number): number | null {
  if (text === null || !/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

/** null for anything that is not XML with one of the three roots. Never throws. */
export function readNfo(text: string): Nfo | null {
  try {
    const body = text.replace(/^\uFEFF/, '');
    // Sticky regexes step over the prolog without copying the text.
    let at = 0;
    for (;;) {
      PROLOG.lastIndex = at;
      if (!PROLOG.test(body) || PROLOG.lastIndex === at) break;
      at = PROLOG.lastIndex;
    }
    ROOT.lastIndex = at;
    const root = ROOT.exec(body)?.[1]?.toLowerCase();
    if (root === undefined || !ROOTS.has(root)) return null;
    const lower = asciiLower(body);
    const tag = (name: string): string | null => tagText(body, lower, name);
    const premiered = tag('premiered');
    return {
      root: root as NfoRoot,
      title: tag('title'),
      showTitle: tag('showtitle'),
      season: intIn(tag('season'), 0, 9999),
      episode: intIn(tag('episode'), 0, 9999),
      year:
        intIn(tag('year'), 1800, 2200) ??
        intIn(premiered === null ? null : (/^\d{4}/.exec(premiered)?.[0] ?? null), 1800, 2200),
    };
  } catch {
    return null;
  }
}
