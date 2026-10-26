// Intel GPU video-engine load from the i915 driver's per-client counters in /proc/<pid>/fdinfo:
// every process holding the render node open reports the nanoseconds its client kept the engine busy.
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

export interface ParsedFdinfo {
  pdev: string;
  clientId: string;
  videoNs: number;
  videoCapacity: number;
}

/** The video-engine fields of one fdinfo file; null when it has no `drm-engine-video` line. */
export function parseDrmFdinfo(text: string): ParsedFdinfo | null {
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const video = /^(\d+)/.exec(fields.get('drm-engine-video') ?? '');
  const pdev = fields.get('drm-pdev');
  const clientId = fields.get('drm-client-id');
  if (!video || !pdev || !clientId) return null;
  const capacity = Number(fields.get('drm-engine-capacity-video') ?? 1);
  return {
    pdev,
    clientId,
    videoNs: Number(video[1]),
    videoCapacity: Number.isFinite(capacity) && capacity > 0 ? capacity : 1,
  };
}

/** The slice of /proc the reader needs; every call may throw (other users' processes). */
export interface ProcFs {
  readdir(path: string): string[];
  readlink(path: string): string;
  readFile(path: string): string;
}

const realProc: ProcFs = {
  readdir: (p) => readdirSync(p),
  readlink: (p) => readlinkSync(p),
  readFile: (p) => readFileSync(p, 'utf8'),
};

const attempt = <T>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

/** Video-engine load per PCI address, from the change in each client's busy time between two calls. */
export class IntelLoadReader {
  private readonly proc: ProcFs;
  private readonly now: () => number;
  /** Last busy time per `pdev|clientId`; a client missing from a scan is dropped. */
  private previous = new Map<string, number>();
  private previousAt: number | null = null;
  /** PCI addresses that have reported engine counters, so an idle card reads 0 rather than nothing. */
  private readonly known = new Set<string>();

  constructor(opts: { proc?: ProcFs; now?: () => number } = {}) {
    this.proc = opts.proc ?? realProc;
    this.now = opts.now ?? (() => performance.now());
  }

  /** Video-engine % (0-100) for each of `pcis` that exposes engine counters. */
  sample(pcis: string[]): Map<string, number> {
    const at = this.now();
    const wantedPcis = new Map(pcis.map((p) => [p.toLowerCase(), p]));
    const clients = new Map<string, ParsedFdinfo>();
    for (const pid of attempt(() => this.proc.readdir('/proc')) ?? []) {
      if (!/^\d+$/.test(pid)) continue;
      for (const fd of attempt(() => this.proc.readdir(`/proc/${pid}/fd`)) ?? []) {
        const link = attempt(() => this.proc.readlink(`/proc/${pid}/fd/${fd}`));
        if (!link || !/^\/dev\/dri\/renderD\d+$/.test(link)) continue;
        const text = attempt(() => this.proc.readFile(`/proc/${pid}/fdinfo/${fd}`));
        const info = text === undefined ? null : parseDrmFdinfo(text);
        if (!info || !wantedPcis.has(info.pdev.toLowerCase())) continue;
        clients.set(`${info.pdev.toLowerCase()}|${info.clientId}`, info);
      }
    }

    const wallNs = this.previousAt === null ? 0 : (at - this.previousAt) * 1e6;
    const busy = new Map<string, number>();
    const next = new Map<string, number>();
    for (const [key, info] of clients) {
      const pci = info.pdev.toLowerCase();
      this.known.add(pci);
      next.set(key, info.videoNs);
      const before = this.previous.get(key);
      // a first-seen client only sets its baseline
      if (before === undefined || wallNs <= 0) continue;
      const share = Math.max(0, info.videoNs - before) / (wallNs * info.videoCapacity);
      busy.set(pci, (busy.get(pci) ?? 0) + share * 100);
    }
    this.previous = next;
    this.previousAt = at;

    const out = new Map<string, number>();
    for (const [pci, original] of wantedPcis) {
      if (this.known.has(pci)) out.set(original, Math.min(100, Math.max(0, busy.get(pci) ?? 0)));
    }
    return out;
  }
}
