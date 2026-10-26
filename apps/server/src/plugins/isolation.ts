// Linux-only checks around running plugin hosts as another user. A leaf module: it imports only
// node built-ins and a type (config.ts's ConfigError would make an import cycle).
import * as nodeFs from 'node:fs/promises';
import type { PluginIsolation } from '../config.ts';

/** Raised at start when isolation is configured but cannot work; the server stops (never same-uid). */
export class IsolationError extends Error {
  override readonly name = 'IsolationError';
}

/** CAP_KILL (5), CAP_SETGID (6), CAP_SETUID (7). */
export const REQUIRED_CAPS = (1n << 5n) | (1n << 6n) | (1n << 7n);

type CapField = 'CapEff' | 'CapPrm' | 'CapAmb' | 'CapBnd';

function capsText(status: string, field: CapField): string {
  return new RegExp(`^${field}:\\s*([0-9a-fA-F]+)\\s*$`, 'm').exec(status)?.[1] ?? '';
}

/** One capability mask of a `/proc/<pid>/status` text (0 when the line is missing). */
export function capsFromStatus(status: string, field: CapField): bigint {
  const hex = capsText(status, field);
  return hex === '' ? 0n : BigInt(`0x${hex}`);
}

type IsolationFs = Pick<typeof nodeFs, 'readFile' | 'access' | 'stat'>;

export async function assertIsolationUsable(
  iso: PluginIsolation,
  fs: IsolationFs = nodeFs,
): Promise<void> {
  const status = await fs.readFile('/proc/self/status', 'utf8').catch(() => '');
  if ((capsFromStatus(status, 'CapEff') & REQUIRED_CAPS) !== REQUIRED_CAPS) {
    throw new IsolationError(
      "plugin isolation needs CAP_SETUID, CAP_SETGID and CAP_KILL; start the container as root with the compose file's cap_add list",
    );
  }
  try {
    await fs.access(iso.setprivPath, nodeFs.constants.X_OK);
  } catch {
    throw new IsolationError(`plugin isolation: setpriv not found at ${iso.setprivPath}`);
  }
  try {
    const st = await fs.stat(iso.runDir);
    if (!st.isDirectory()) throw new Error('not a directory');
    await fs.access(iso.runDir, nodeFs.constants.W_OK | nodeFs.constants.X_OK);
  } catch {
    throw new IsolationError(
      `plugin isolation: ${iso.runDir} is not a writable directory (mount a tmpfs at /run/transcoda)`,
    );
  }
}

export interface ProcessIdentity {
  uid: number;
  gid: number;
  capEff: string;
  capPrm: string;
  capAmb: string;
  noNewPrivs: number;
}

/** What the OS says a process is (Linux `/proc/<pid>/status`); null elsewhere or when unreadable. */
export async function processIdentity(
  pid: number | undefined,
  deps: { platform?: NodeJS.Platform; readFile?: (path: string) => Promise<string> } = {},
): Promise<ProcessIdentity | null> {
  if ((deps.platform ?? process.platform) !== 'linux' || pid === undefined) return null;
  let status: string;
  try {
    status = await (deps.readFile ?? ((p: string) => nodeFs.readFile(p, 'utf8')))(
      `/proc/${pid}/status`,
    );
  } catch {
    return null;
  }
  const id = (field: 'Uid' | 'Gid'): number =>
    Number(new RegExp(`^${field}:\\s*(\\d+)`, 'm').exec(status)?.[1] ?? Number.NaN);
  const caps = (field: CapField): string => capsText(status, field).toLowerCase();
  const uid = id('Uid');
  const gid = id('Gid');
  const noNewPrivs = Number(/^NoNewPrivs:\s*(\d+)/m.exec(status)?.[1] ?? Number.NaN);
  if (Number.isNaN(uid) || Number.isNaN(gid) || Number.isNaN(noNewPrivs)) return null;
  return {
    uid,
    gid,
    capEff: caps('CapEff'),
    capPrm: caps('CapPrm'),
    capAmb: caps('CapAmb'),
    noNewPrivs,
  };
}

const ZERO_CAPS = '0000000000000000';

/**
 * Why a running host is not the isolated process it should be (first wrong field), or null. Fails
 * closed: an unreadable identity or a missing capability line is a violation.
 */
export function isolationViolation(
  id: ProcessIdentity | null,
  iso: PluginIsolation,
): string | null {
  if (id === null) return 'identity expected readable, got unreadable';
  if (id.uid !== iso.uid) return `uid expected ${iso.uid}, got ${id.uid}`;
  if (id.gid !== iso.gid) return `gid expected ${iso.gid}, got ${id.gid}`;
  for (const field of ['capEff', 'capPrm', 'capAmb'] as const) {
    const hex = id[field];
    if (!/^[0-9a-f]+$/.test(hex) || BigInt(`0x${hex}`) !== 0n) {
      return `${field} expected ${ZERO_CAPS}, got ${hex}`;
    }
  }
  if (id.noNewPrivs !== 1) return `noNewPrivs expected 1, got ${id.noNewPrivs}`;
  return null;
}
