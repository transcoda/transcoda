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
const PROLOG = /^(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|\s+)/i;
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

/**
 * The trimmed text of the first `<tag>…</tag>` whose content holds no element (only text and
 * CDATA), capped at 300 characters; null when there is none or it is empty.
 */
function tagText(body: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*?)?(?<!/)>([\\s\\S]*?)</${tag}\\s*>`, 'gi');
  for (const m of body.matchAll(re)) {
    const content = m[1] as string;
    if (content.replace(CDATA, '').includes('<')) continue;
    const value = decodeContent(content).trim();
    if (value === '') return null;
    return Array.from(value).slice(0, MAX_VALUE_LENGTH).join('');
  }
  return null;
}

function intIn(text: string | null, min: number, max: number): number | null {
  if (text === null || !/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

/** null for anything that is not XML with one of the three roots. Never throws. */
export function readNfo(text: string): Nfo | null {
  try {
    let rest = text.replace(/^﻿/, '');
    for (let m = PROLOG.exec(rest); m !== null && m[0] !== ''; m = PROLOG.exec(rest)) {
      rest = rest.slice(m[0].length);
    }
    const root = /^<([A-Za-z_][\w.-]*)(?=[\s/>]|$)/.exec(rest)?.[1]?.toLowerCase();
    if (root === undefined || !ROOTS.has(root)) return null;
    const premiered = tagText(rest, 'premiered');
    return {
      root: root as NfoRoot,
      title: tagText(rest, 'title'),
      showTitle: tagText(rest, 'showtitle'),
      season: intIn(tagText(rest, 'season'), 0, 9999),
      episode: intIn(tagText(rest, 'episode'), 0, 9999),
      year:
        intIn(tagText(rest, 'year'), 1800, 2200) ??
        intIn(premiered === null ? null : (/^\d{4}/.exec(premiered)?.[0] ?? null), 1800, 2200),
    };
  } catch {
    return null;
  }
}
