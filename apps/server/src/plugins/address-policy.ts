import { isIP } from 'node:net';

/**
 * Which network a fetch-proxy target address belongs to (sandbox review M1).
 * - `loopback`, `link-local`, `metadata`, `reserved`: never reachable by a plugin.
 * - `private`: RFC 1918, CGNAT/Tailscale (100.64/10), IPv6 ULA; only for a private origin.
 * - `public`: everything else.
 */
export type AddressKind =
  | 'loopback'
  | 'link-local'
  | 'metadata'
  | 'reserved'
  | 'private'
  | 'public';

const v4ToInt = (ip: string): number =>
  ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);

const inV4 = (n: number, base: string, bits: number): boolean => {
  const size = 2 ** (32 - bits);
  return Math.floor(n / size) === Math.floor(v4ToInt(base) / size);
};

function classifyV4(ip: string): AddressKind {
  const n = v4ToInt(ip);
  // Cloud metadata endpoints: AWS/GCP/Azure (169.254.169.254) and Alibaba (100.100.100.200).
  if (ip === '169.254.169.254' || ip === '100.100.100.200') return 'metadata';
  if (inV4(n, '127.0.0.0', 8) || inV4(n, '0.0.0.0', 8)) return 'loopback';
  if (inV4(n, '169.254.0.0', 16)) return 'link-local';
  if (inV4(n, '224.0.0.0', 4) || inV4(n, '240.0.0.0', 4)) return 'reserved';
  if (
    inV4(n, '10.0.0.0', 8) ||
    inV4(n, '172.16.0.0', 12) ||
    inV4(n, '192.168.0.0', 16) ||
    inV4(n, '100.64.0.0', 10)
  ) {
    return 'private';
  }
  return 'public';
}

/** Eight 16-bit words of an IPv6 address (zone id dropped), or null when it does not parse. */
function v6Words(ip: string): number[] | null {
  let text = ip.split('%')[0] ?? '';
  const tail: number[] = [];
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1] && dotted[2]) {
    if (isIP(dotted[2]) !== 4) return null;
    const n = v4ToInt(dotted[2]);
    tail.push(Math.floor(n / 65536), n % 65536);
    text = dotted[1].endsWith('::') ? dotted[1] : dotted[1].slice(0, -1);
  }
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((w) => Number.parseInt(w, 16));
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const fill = 8 - head.length - rest.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
  const words = [...head, ...Array<number>(fill).fill(0), ...rest, ...tail];
  return words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

function classifyV6(ip: string): AddressKind {
  const w = v6Words(ip);
  if (!w) return 'reserved';
  const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = w;
  const embeddedV4 = () => `${w6 >> 8}.${w6 & 255}.${w7 >> 8}.${w7 & 255}`;
  const zeroTo = (n: number) => w.slice(0, n).every((x) => x === 0);
  if (zeroTo(7) && (w7 === 0 || w7 === 1)) return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d).
  if (zeroTo(5) && w5 === 0xffff) return classifyV4(embeddedV4());
  if (zeroTo(6)) return classifyV4(embeddedV4());
  if (w0 === 0x64 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    return classifyV4(embeddedV4());
  }
  // AWS IPv6 metadata endpoint (fd00:ec2::254), inside the ULA range.
  if (w.join(':') === [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x254].join(':')) return 'metadata';
  if ((w0 & 0xffc0) === 0xfe80) return 'link-local';
  if ((w0 & 0xff00) === 0xff00) return 'reserved';
  if ((w0 & 0xfe00) === 0xfc00) return 'private';
  return 'public';
}

/** Anything that is not a valid IP literal is `reserved`, so it is refused. */
export function classifyAddress(ip: string): AddressKind {
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const family = isIP(bare.split('%')[0] ?? '');
  if (family === 4) return classifyV4(bare);
  if (family === 6) return classifyV6(bare);
  return 'reserved';
}

/** Names that only resolve inside a LAN, a container network or a tailnet. */
const PRIVATE_SUFFIXES = [
  '.local',
  '.lan',
  '.home',
  '.home.arpa',
  '.internal',
  '.intranet',
  '.localdomain',
  '.corp',
  '.private',
  '.ts.net',
];

/**
 * Whether an allow-listed origin's host is itself private: a private IP literal, a single-label
 * name (a Docker service such as `sonarr`) or a LAN-only suffix. Only such an origin may reach
 * private addresses; a public name that resolves into the LAN is refused.
 */
export function isPrivateHost(
  hostname: string,
  classify: (address: string) => AddressKind = classifyAddress,
): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(bare.split('%')[0] ?? '') !== 0) return classify(bare) === 'private';
  if (!bare.includes('.')) return true;
  return PRIVATE_SUFFIXES.some((suffix) => bare.endsWith(suffix));
}

const REFUSED_ALWAYS: Partial<Record<AddressKind, string>> = {
  loopback: 'a loopback address',
  'link-local': 'a link-local address',
  metadata: 'a cloud metadata address',
  reserved: 'a reserved or multicast address',
};

/** null when a plugin may connect to an address of this kind; otherwise why not. */
export function addressVerdict(kind: AddressKind, originIsPrivate: boolean): string | null {
  const always = REFUSED_ALWAYS[kind];
  if (always) return `${always}, which plugins cannot reach`;
  if (kind === 'private' && !originIsPrivate) {
    return 'a private network address, which only an integration configured with a private address or LAN name may reach';
  }
  return null;
}
