import type { HookJob } from '@transcoda/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { JobRow } from '../db/repos/jobs.ts';
import type { Logger } from '../logger.ts';
import { type HookName, type HookTarget, hookJobOf, PluginHooksRunner } from './hooks.ts';

const job = (over: Partial<HookJob> = {}): HookJob => ({
  id: 'j1',
  runId: 'r1',
  workflowId: 'w1',
  workflowName: 'W',
  workflowVersion: 2,
  path: '/lib/a.mkv',
  outcome: 'done',
  reason: null,
  beforeBytes: 10,
  afterBytes: 5,
  replacedTo: 'recycle',
  problems: [],
  dryRun: false,
  jobUrl: null,
  ...over,
});

function logger() {
  const warn = vi.fn();
  const log: Logger = { info: vi.fn(), warn, error: vi.fn() };
  return { warn, log };
}

function target(
  declared: Record<string, HookName[]>,
  hook: HookTarget['hook'],
  running = Object.keys(declared),
): HookTarget {
  return { running: () => running, declaredHooks: (n) => declared[n] ?? [], hook };
}

describe('PluginHooksRunner', () => {
  it('runs onJobDone on the plugins that declare it, not the others', async () => {
    const { log } = logger();
    const runner = new PluginHooksRunner({ log, now: () => new Date(), timeoutMs: 1000 });
    const calls: string[] = [];
    runner.attachTarget(
      target(
        { a: ['onJobDone'], b: ['onJobDone', 'onJobFailed'], c: ['afterReplace'] },
        async (name, hook) => {
          calls.push(`${name}:${hook}`);
          return { ok: true };
        },
      ),
    );
    await runner.run('onJobDone', job());
    expect(calls.sort()).toEqual(['a:onJobDone', 'b:onJobDone']);
  });

  it('does not call a plugin that is not running', async () => {
    const { log } = logger();
    const runner = new PluginHooksRunner({ log, now: () => new Date(), timeoutMs: 1000 });
    const hook = vi.fn(async () => ({ ok: true }));
    runner.attachTarget(target({ a: ['onJobDone'] }, hook, []));
    await runner.run('onJobDone', job());
    expect(hook).not.toHaveBeenCalled();
  });

  it('logs a throwing or failing target once and resolves', async () => {
    const { log, warn } = logger();
    const runner = new PluginHooksRunner({ log, now: () => new Date(), timeoutMs: 1000 });
    runner.attachTarget(
      target({ a: ['onJobFailed'], b: ['onJobFailed'] }, async (name) => {
        if (name === 'a') throw new Error('boom');
        return { ok: false, error: { message: 'nope' } };
      }),
    );
    await expect(runner.run('onJobFailed', job({ outcome: 'failed' }))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: 'plugin hook failed',
        plugin: 'a',
        hook: 'onJobFailed',
        jobId: 'j1',
        error: 'boom',
      }),
    );
  });

  it('bounds a hanging target by timeoutMs', async () => {
    const { log, warn } = logger();
    const runner = new PluginHooksRunner({ log, now: () => new Date(), timeoutMs: 20 });
    runner.attachTarget(target({ a: ['onJobDone'] }, () => new Promise(() => {})));
    await runner.run('onJobDone', job());
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ plugin: 'a' }));
  });

  it('runs nothing for a dry-run job', async () => {
    const { log } = logger();
    const runner = new PluginHooksRunner({ log, now: () => new Date(), timeoutMs: 1000 });
    const hook = vi.fn(async () => ({ ok: true }));
    runner.attachTarget(target({ a: ['onJobDone'] }, hook));
    await runner.run('onJobDone', job({ dryRun: true }));
    expect(hook).not.toHaveBeenCalled();
  });

  it('run() before attachTarget is a no-op', async () => {
    const { log } = logger();
    const runner = new PluginHooksRunner({ log, now: () => new Date(), timeoutMs: 1000 });
    await expect(runner.run('onJobDone', job())).resolves.toBeUndefined();
  });
});

describe('hookJobOf', () => {
  it('maps a job row and its result', () => {
    const row: Pick<JobRow, 'id' | 'runId' | 'workflowId' | 'workflowVersion' | 'path' | 'dryRun'> =
      {
        id: 'j1',
        runId: 'r1',
        workflowId: 'w1',
        workflowVersion: 3,
        path: '/lib/a.mkv',
        dryRun: false,
      };
    expect(
      hookJobOf(
        row,
        {
          outcome: 'done',
          reason: null,
          beforeBytes: 10,
          afterBytes: 5,
          replacedTo: 'recycle',
          problems: ['x'],
        },
        'Name',
        'https://t.example.net/jobs/j1',
      ),
    ).toEqual(
      job({
        workflowVersion: 3,
        workflowName: 'Name',
        problems: ['x'],
        jobUrl: 'https://t.example.net/jobs/j1',
      }),
    );
  });
});
