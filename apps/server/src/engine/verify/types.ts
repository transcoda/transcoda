import type { BuildModel, ProbeResult } from '@transcoda/sdk';
import type { Exec } from '../../capabilities/ffmpeg.ts';
import type { VerifyProgress } from '../encode/progress.ts';

// What verify takes and answers.

export type VerifyFailure = {
  check:
    | 'probe'
    | 'duration'
    | 'stream-count'
    | 'stream-match'
    | 'sidecars'
    | 'defaults'
    | 'decode-start'
    | 'decode-end'
    | 'decode-sample'
    | 'decode-full'
    | 'targets';
  message: string;
};

export interface VerifyInput {
  outputPath: string;
  /** The original; output decode failures are re-checked on it (`source-damaged`). */
  sourcePath: string;
  model: BuildModel;
  sourceProbe: ProbeResult;
  ffmpegPath: string;
  ffprobePath: string;
  exec?: Exec;
  /** One-second spots decoded across the output besides its start and end (default 10). */
  sampleSpots?: number;
  /** Decode the whole output too (the library's `verifyFullDecode`). */
  fullDecode?: boolean;
  /** Aborts every ffprobe/ffmpeg run (cancel, shutdown); the result is then meaningless. */
  signal?: AbortSignal;
  /**
   * Called as each check is done (the output probe, each stream end, each spot decode: `checks`),
   * as the whole-file decode moves (`full-decode`, from its `-progress`), and when the source is
   * re-decoded after a decode failure (`source`).
   */
  onProgress?: (p: VerifyProgress) => void;
}

/**
 * `warnings`: kept non-default audio/subtitle tracks some target cannot play (allowed, controller
 * ruling R1), as `<type> #<output index> won't direct-play on <target>`, and a source header that
 * claims a longer duration than its streams have.
 *
 * `kind` on a failure: `source-damaged` only when every failure is a decode failure of an output
 * stream and its source stream fails the same decode check (`sourceFailures` says how): re-encoding
 * cannot fix it, the pipeline keeps the original without a retry. Otherwise `output-invalid`
 * (duration mismatches always are).
 */
export type VerifyResult =
  | { ok: true; probe: ProbeResult; warnings: string[] }
  | {
      ok: false;
      kind: 'output-invalid' | 'source-damaged';
      failures: VerifyFailure[];
      sourceFailures: VerifyFailure[];
      probe: ProbeResult | null;
      warnings: string[];
    };
