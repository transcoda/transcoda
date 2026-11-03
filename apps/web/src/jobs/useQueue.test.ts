import { describe, expect, it } from 'vitest';
import { frozenByQueue, type QueueState } from './useQueue.ts';

const status = (over: Partial<QueueState> = {}): QueueState => ({
  paused: true,
  lanes: { encode: 'enc', quick: 'qk' },
  encodeSlots: [
    { id: 'gpu:0', label: 'GPU 0', jobId: 'gpu0' },
    { id: 'gpu:1', label: 'GPU 1', jobId: null },
  ],
  ...over,
});

describe('frozenByQueue', () => {
  it('a paused queue freezes the jobs holding a lane or a GPU slot, and no other', () => {
    expect(['enc', 'qk', 'gpu0'].map((id) => frozenByQueue(status(), id))).toEqual([
      true,
      true,
      true,
    ]);
    // A verifying job that gave its encode slot up, or one still probing, goes on working.
    expect(frozenByQueue(status(), 'verifying-after-release')).toBe(false);
  });

  it('nothing is frozen while the queue runs, or before its status loads', () => {
    expect(frozenByQueue(status({ paused: false }), 'enc')).toBe(false);
    expect(frozenByQueue(null, 'enc')).toBe(false);
  });
});
