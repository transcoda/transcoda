import { describe, expect, it } from 'vitest';
import { EngineEventSchema, JobsListInputSchema } from '../index.ts';

describe('events router', () => {
  it('EngineEventSchema accepts ping and resync and rejects an unknown type', () => {
    const at = '2026-10-16T18:00:00.000Z';
    expect(EngineEventSchema.safeParse({ type: 'ping', at }).success).toBe(true);
    expect(EngineEventSchema.safeParse({ type: 'resync', at }).success).toBe(true);
    expect(EngineEventSchema.safeParse({ type: 'job.deleted', jobId: 'j' }).success).toBe(false);
    expect(
      EngineEventSchema.safeParse({
        type: 'job.changed',
        jobId: 'j',
        runId: 'r',
        libraryId: 'l',
        workflowId: 'w',
        state: 'encoding',
        paused: false,
        progress: null,
        lane: 'encode',
        currentNode: { workflowPath: [], nodeId: 'ev' },
        problems: ['finished with a problem: x'],
        reason: 'waiting for 5.40 GB free on /media (5.10 GB free)',
      }).success,
    ).toBe(true);
    expect(
      EngineEventSchema.safeParse({
        type: 'plugins.changed',
        name: 'example',
        state: 'stopped',
        stateReason: 'crashed 3 times in 10 minutes',
      }).success,
    ).toBe(true);
    expect(
      EngineEventSchema.safeParse({
        type: 'plugins.changed',
        name: 'example',
        state: 'running',
        stateReason: null,
      }).success,
    ).toBe(true);
    expect(JobsListInputSchema.parse({ problems: true }).problems).toBe(true);
    expect(JobsListInputSchema.parse({ dryRun: false }).dryRun).toBe(false);
    expect(
      EngineEventSchema.safeParse({
        type: 'queue.changed',
        paused: true,
        lanes: { encode: null, quick: 'j' },
        encodeSlots: [{ id: 'gpu:0', label: 'GPU 0', jobId: null }],
      }).success,
    ).toBe(true);
  });
});
