import { BlockList, isIP } from 'node:net';
import { ConfigError } from '../config.ts';

function family(addr: string): 'ipv4' | 'ipv6' | null {
  const v = isIP(addr);
  return v === 4 ? 'ipv4' : v === 6 ? 'ipv6' : null;
}

/** Strip an IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4` -> `1.2.3.4`). */
function normalizeAddr(addr: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  return m?.[1] ?? addr;
}

export function parseTrustedProxies(cidrs: string[]): BlockList {
  const list = new BlockList();
  for (const raw of cidrs) {
    const entry = raw.trim();
    if (entry === '') continue;
    const [addr, prefix, ...rest] = entry.split('/');
    const fam = addr === undefined ? null : family(normalizeAddr(addr));
    if (addr === undefined || fam === null || rest.length > 0) {
      throw new ConfigError(`TRANSCODA_TRUSTED_PROXIES: invalid address or CIDR "${entry}"`);
    }
    const normalized = normalizeAddr(addr);
    if (prefix === undefined) {
      list.addAddress(normalized, fam);
      continue;
    }
    const max = fam === 'ipv4' ? 32 : 128;
    if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max) {
      throw new ConfigError(`TRANSCODA_TRUSTED_PROXIES: invalid prefix length in "${entry}"`);
    }
    list.addSubnet(normalized, Number(prefix), fam);
  }
  return list;
}

export function isTrustedProxy(list: BlockList, remoteAddr: string): boolean {
  const addr = normalizeAddr(remoteAddr.trim());
  const fam = family(addr);
  return fam !== null && list.check(addr, fam);
}

export function clientIp(req: Request, remoteAddr: string, trusted: BlockList): string {
  if (!isTrustedProxy(trusted, remoteAddr)) return remoteAddr;
  const header = req.headers.get('x-forwarded-for');
  if (!header) return remoteAddr;
  const hops = header
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = normalizeAddr(hops[i] as string);
    if (family(hop) === null) return remoteAddr; // garbage: do not trust the header
    if (!isTrustedProxy(trusted, hop)) return hop;
  }
  return remoteAddr;
}

export function isHttps(req: Request, remoteAddr: string, trusted: BlockList): boolean {
  if (isTrustedProxy(trusted, remoteAddr)) {
    const proto = req.headers.get('x-forwarded-proto');
    if (proto !== null) return proto.split(',')[0]?.trim().toLowerCase() === 'https';
  }
  return new URL(req.url).protocol === 'https:';
}

/**
 * The Host the client addressed: the first `X-Forwarded-Host` value when the peer is a trusted
 * proxy (a proxy that rewrites Host, e.g. to its upstream name), else the `Host` header.
 */
export function requestHost(req: Request, remoteAddr: string, trusted: BlockList): string | null {
  if (isTrustedProxy(trusted, remoteAddr)) {
    const forwarded = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  return req.headers.get('host');
}
