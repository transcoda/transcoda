// The GPU's video engines over the last hour, for the Jobs page: `nvidia-smi` every few seconds,
// kept in memory only (nothing is stored, so the graph starts empty after a restart).
import type { GpuLoadOutput } from '@transcoda/contract';
import type { Logger } from '../logger.ts';
import type { Gpu } from './devices.ts';
import { type Exec, makeExec } from './ffmpeg.ts';

const QUERY = [
  '--query-gpu=index,utilization.encoder,utilization.decoder',
  '--format=csv,noheader,nounits',
];
const sampleExec: Exec = makeExec({ timeout: 4000, maxBuffer: 64 * 1024 });

type Reading = { index: number; encoder: number; decoder: number };
type Sample = GpuLoadOutput['gpus'][number]['samples'][number];

/** `0, 97, 41` lines (index, encoder %, decoder %); a line with `[N/A]` or garbage is skipped. */
export function parseGpuLoad(stdout: string): Reading[] {
  const out: Reading[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\s*$/.exec(line);
    if (!m) continue;
    out.push({ index: Number(m[1]), encoder: Number(m[2]), decoder: Number(m[3]) });
  }
  return out;
}

export interface GpuLoadSamplerOptions {
  /** The GPUs found at startup; none means the sampler never runs. */
  gpus: () => Gpu[];
  exec?: Exec;
  intervalMs?: number;
  windowMs?: number;
  now?: () => Date;
  log?: Logger;
}

/** Samples NVENC/NVDEC load every `intervalMs` and keeps the last `windowMs` per GPU. */
export class GpuLoadSampler {
  private readonly exec: Exec;
  private readonly intervalMs: number;
  private readonly windowMs: number;
  private readonly now: () => Date;
  private readonly samples = new Map<number, Sample[]>();
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private failing = false;

  constructor(private readonly opts: GpuLoadSamplerOptions) {
    this.exec = opts.exec ?? sampleExec;
    this.intervalMs = opts.intervalMs ?? 5000;
    this.windowMs = opts.windowMs ?? 3_600_000;
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer || this.opts.gpus().length === 0) return;
    this.timer = setInterval(() => void this.sampleOnce(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One reading of every GPU; never throws, and skips while the previous one still runs. */
  async sampleOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const { stdout } = await this.exec('nvidia-smi', QUERY);
      const at = this.now();
      const cutoff = at.getTime() - this.windowMs;
      for (const r of parseGpuLoad(stdout)) {
        const list = this.samples.get(r.index) ?? [];
        list.push({ at: at.toISOString(), encoder: r.encoder, decoder: r.decoder });
        while (list.length > 0 && Date.parse(list[0]?.at ?? '') <= cutoff) list.shift();
        this.samples.set(r.index, list);
      }
      this.failing = false;
    } catch (err) {
      if (!this.failing) {
        this.opts.log?.warn(
          `GPU load: nvidia-smi failed (${err instanceof Error ? err.message : 'unknown error'}); retrying quietly`,
        );
      }
      this.failing = true;
    } finally {
      this.inFlight = false;
    }
  }

  snapshot(): GpuLoadOutput {
    const gpus: GpuLoadOutput['gpus'] = [];
    for (const gpu of this.opts.gpus()) {
      const samples = this.samples.get(gpu.index);
      if (samples && samples.length > 0) {
        gpus.push({ index: gpu.index, name: gpu.name, samples: [...samples] });
      }
    }
    return { intervalMs: this.intervalMs, gpus };
  }
}
