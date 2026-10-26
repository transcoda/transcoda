import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { getSetting } from '../db/repos/settings.ts';

export const ALWAYS_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];

/** Lowercased hostname without port; IPv6 brackets stripped. Null when empty/invalid. */
export function hostnameOf(hostHeader: string | null): string | null {
  if (hostHeader === null) return null;
  const h = hostHeader.trim().toLowerCase();
  if (h === '' || /[\s/\\@?#]/.test(h)) return null;
  let name: string;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end < 0) return null;
    if (h.slice(end + 1) !== '' && !/^:\d*$/.test(h.slice(end + 1))) return null;
    name = h.slice(1, end);
  } else {
    const colons = h.split(':').length - 1;
    // A bare IPv6 address (several colons, no brackets) has no port to strip.
    name = colons === 1 ? (h.split(':')[0] as string) : h;
  }
  return name === '' ? null : name;
}

/** `host` is the request's effective Host (see `requestHost`), not necessarily the Host header. */
export function checkHost(
  host: string | null,
  allowed: string[],
): 'ok' | 'missing' | 'not-allowed' {
  const name = hostnameOf(host);
  if (name === null) return 'missing';
  return ALWAYS_ALLOWED_HOSTS.includes(name) || allowed.includes(name) ? 'ok' : 'not-allowed';
}

export function checkOrigin(req: Request, allowed: string[]): 'ok' | 'absent' | 'mismatch' {
  const raw = req.headers.get('origin') ?? req.headers.get('referer');
  if (raw === null) return 'absent';
  let host: string | null = null;
  try {
    host = hostnameOf(new URL(raw).host);
  } catch {
    host = null;
  }
  return host !== null && (ALWAYS_ALLOWED_HOSTS.includes(host) || allowed.includes(host))
    ? 'ok'
    : 'mismatch';
}

/** settings `allowed_hosts` ∪ config.allowedHosts ∪ ALWAYS_ALLOWED_HOSTS; a corrupt setting counts as empty. */
export function createAllowedHosts(db: Database, config: Config): () => string[] {
  return () => {
    let stored: string[] = [];
    try {
      stored = getSetting(db, 'allowed_hosts', z.array(z.string())) ?? [];
    } catch {
      stored = [];
    }
    return [
      ...new Set([
        ...stored.map((h) => h.toLowerCase()),
        ...config.allowedHosts,
        ...ALWAYS_ALLOWED_HOSTS,
      ]),
    ];
  };
}
