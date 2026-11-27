// What the engine lends a core node: the tools on `ctx.core` and the shapes of their answers.
// Declared here, where the nodes use them; the engine implements them (engine/pipeline-prepare.ts).
import type { JsonValue } from '@transcoda/shared';

/**
 * What Check source's pass found. `damaged`: a source decoder reported an error the source
 * reproduces, or the file is cut off (`CUT_OFF_SECONDS` in engine/check-source.ts); `stream` names
 * the stream when the error says which. `error`: the pass could not tell (a read error on a disk or network share, a timeout, a
 * demuxer error without a decoder error, ffmpeg failed without a source error, ffmpeg stopped by
 * the memory guard): never damage. `final`: another try would end the same way (the memory guard
 * stopped ffmpeg), so the job is not retried.
 */
export type CheckSourceResult =
  | { kind: 'ok'; warnings: string[] }
  | { kind: 'damaged'; reason: string; stream?: string }
  | { kind: 'error'; message: string; final?: true };

/** What Already processed asks: a workflow (null: the job's own) and a version (null: any). */
export interface AlreadyProcessedQuery {
  workflowId: string | null;
  version: number | null;
}

export interface AlreadyProcessedAnswer {
  processed: boolean;
  reason: string;
  findings: Record<string, JsonValue>;
}

/**
 * Engine tools a core node may use from its hook context (`ctx.core`, server-side only: never sent
 * to a plugin). The pipeline binds them to the job's file, probe and cancel signal.
 */
export interface CoreTools {
  checkSource(opts: { decodeVideo: boolean }): Promise<CheckSourceResult>;
  /**
   * Already processed: the job's history by fingerprint, then by content hash
   * (engine/already-processed.ts).
   */
  alreadyProcessed(q: AlreadyProcessedQuery): Promise<AlreadyProcessedAnswer>;
}
