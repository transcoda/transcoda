import { describe, expect, it } from 'vitest';
import { encodeStopped, type QueueState } from './useQueue.ts';

const status = (over: Partial<QueueState> = {}): QueueState => ({
  paused: false,
  lanes: { encode: 'enc', quick: 'qk' },
  encodeSlots: [
    { id: 'gpu:0', label: 'GPU 0', jobId: 'gpu0' },
    { id: 'gpu:1', label: 'GPU 1', jobId: null },
  ],
  ...over,
});
const encoding = (id: string) => ({ id, state: 'encoding' as const });

describe('encodeStopped', () => {
  it('an encode holding a lane or a GPU slot works while the queue runs', () => {
    expect(['enc', 'qk', 'gpu0'].map((id) => encodeStopped(status(), encoding(id)))).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('a paused queue stops every encode', () => {
    expect(encodeStopped(status({ paused: true }), encoding('enc'))).toBe(true);
    expect(encodeStopped(status({ paused: true }), encoding('gpu0'))).toBe(true);
  });

  it('a resumed encode waiting for its lane (another job took it) stands still', () => {
    expect(encodeStopped(status(), encoding('waiting'))).toBe(true);
  });

  it('verify, replace and preparation go on, paused queue or not; nothing before the status loads', () => {
    for (const state of ['verifying', 'replacing', 'probing'] as const) {
      expect(encodeStopped(status({ paused: true }), { id: 'qk', state })).toBe(false);
    }
    expect(encodeStopped(null, encoding('enc'))).toBe(false);
  });
});
