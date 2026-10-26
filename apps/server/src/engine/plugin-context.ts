import type { FinishRunContext, HookContextBase } from '@transcoda/sdk';

/** What the pipeline knows after the write, added to the walk's base context for a plugin `run`. */
export function finishRunContext(
  base: HookContextBase,
  p: {
    originalPath: string;
    newPath: string;
    replacedTo: FinishRunContext['replacedTo'];
    beforeBytes: number;
    afterBytes: number;
    outcome: FinishRunContext['outcome'];
    containerChanged: boolean;
    problemsSoFar: string[];
    gate: FinishRunContext['gate'];
    jobUrl: string | null;
    workflowName: string;
  },
): FinishRunContext {
  return { ...base, ...p };
}

/** The job's page, from `TRANSCODA_PUBLIC_URL` (an origin without a trailing slash); null when unset. */
export function jobUrl(publicUrl: string | null, jobId: string): string | null {
  return publicUrl === null ? null : `${publicUrl}/jobs/${jobId}`;
}
