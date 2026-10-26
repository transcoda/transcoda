// Job hooks: after a job's final state is written (or a replace landed) every running plugin that
// declares the hook is told, in parallel and bounded. A failing hook is one log line, never a
// change to the job.
import type { HookJob } from '@transcoda/sdk';
import type { JobRow } from '../db/repos/jobs.ts';
import type { Logger } from '../logger.ts';

export type HookName = 'onJobDone' | 'onJobFailed' | 'afterReplace';

/** The part of the supervisor the runner needs (PluginService hands in a supervisor-backed one). */
export interface HookTarget {
  running(): string[];
  declaredHooks(name: string): HookName[];
  hook(
    name: string,
    hookName: string,
    job: HookJob,
  ): Promise<{ ok: boolean; error?: { message: string } }>;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class PluginHooksRunner {
  private target: HookTarget | null = null;

  constructor(
    private readonly deps: {
      log: Logger;
      now(): Date;
      /** The `hookTimeoutMs` limit: one hook call of one plugin. */
      timeoutMs: number;
    },
  ) {}

  /**
   * Late-bound: the engine (and its events) are built first, the runner before them without a
   * target, and PluginService (which needs the engine's events) last. `run` without a target is a
   * no-op.
   */
  attachTarget(target: HookTarget): void {
    this.target = target;
  }

  async run(hookName: HookName, job: HookJob): Promise<void> {
    const target = this.target;
    if (target === null || job.dryRun) return;
    let names: string[];
    try {
      names = target.running().filter((n) => target.declaredHooks(n).includes(hookName));
    } catch (err) {
      this.deps.log.warn({
        msg: 'plugin hook failed',
        hook: hookName,
        jobId: job.id,
        error: message(err),
      });
      return;
    }
    await Promise.allSettled(names.map((name) => this.runOne(target, name, hookName, job)));
  }

  private async runOne(
    target: HookTarget,
    plugin: string,
    hook: HookName,
    job: HookJob,
  ): Promise<void> {
    const fail = (error: string): void =>
      this.deps.log.warn({ msg: 'plugin hook failed', plugin, hook, jobId: job.id, error });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.deps.timeoutMs);
    });
    try {
      const res = await Promise.race([target.hook(plugin, hook, job), timeout]);
      if (res === 'timeout') fail(`timed out after ${this.deps.timeoutMs} ms`);
      else if (!res.ok) fail(res.error?.message ?? 'the hook failed');
    } catch (err) {
      fail(message(err));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The hook payload of a job: `result` is what its result row says (or will say). */
export function hookJobOf(
  job: Pick<JobRow, 'id' | 'runId' | 'workflowId' | 'workflowVersion' | 'path' | 'dryRun'>,
  result: {
    outcome: string;
    reason: string | null;
    beforeBytes: number | null;
    afterBytes: number | null;
    replacedTo: 'recycle' | 'deleted' | null;
    problems: string[];
  },
  workflowName: string,
  jobUrl: string | null,
): HookJob {
  return {
    id: job.id,
    runId: job.runId,
    workflowId: job.workflowId,
    workflowName,
    workflowVersion: job.workflowVersion,
    path: job.path,
    outcome: result.outcome,
    reason: result.reason,
    beforeBytes: result.beforeBytes,
    afterBytes: result.afterBytes,
    replacedTo: result.replacedTo,
    problems: result.problems,
    dryRun: job.dryRun,
    jobUrl,
  };
}
