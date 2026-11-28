import { describe, expect, it } from 'vitest';
import { LogThrottle } from './throttle.ts';

describe('LogThrottle', () => {
  it('lets `limit` lines through a window, says the first drop, then drops quietly', () => {
    let now = 0;
    const th = new LogThrottle(2, () => now);
    expect([th.take(), th.take(), th.take(), th.take()]).toEqual([
      'log',
      'log',
      'first-drop',
      'drop',
    ]);
    now = 59_999;
    expect(th.take()).toBe('drop');
    now = 60_000;
    expect([th.take(), th.take(), th.take()]).toEqual(['log', 'log', 'first-drop']);
  });

  it('starts a new window when the clock moves backward', () => {
    let now = 100_000;
    const th = new LogThrottle(1, () => now);
    expect([th.take(), th.take()]).toEqual(['log', 'first-drop']);
    now = 0;
    expect(th.take()).toBe('log');
  });
});
