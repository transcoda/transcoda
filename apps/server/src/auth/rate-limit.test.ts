import { describe, expect, it } from 'vitest';
import { LoginRateLimiter } from './rate-limit.ts';

function make() {
  let t = 1_000_000;
  const limiter = new LoginRateLimiter({ now: () => t });
  return {
    limiter,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const fail = (l: LoginRateLimiter, n: number, keys = ['ip:1.1.1.1']) => {
  for (let i = 0; i < n; i++) l.recordFailure(keys);
};

describe('LoginRateLimiter', () => {
  it('allows 5 failures then blocks the 6th within a minute', () => {
    const { limiter, advance } = make();
    for (let i = 0; i < 4; i++) {
      limiter.recordFailure(['ip:a']);
      advance(1000);
      expect(limiter.check(['ip:a'])).toEqual({ allowed: true });
    }
    limiter.recordFailure(['ip:a']);
    expect(limiter.check(['ip:a'])).toEqual({ allowed: false, retryAfterMs: 60_000 });
  });

  it('failures older than the window do not count', () => {
    const { limiter, advance } = make();
    fail(limiter, 4, ['ip:a']);
    advance(60_001);
    limiter.recordFailure(['ip:a']);
    expect(limiter.check(['ip:a'])).toEqual({ allowed: true });
  });

  it('lockout doubles on consecutive lockouts and caps at 15 min', () => {
    const { limiter, advance } = make();
    const expected = [60_000, 120_000, 240_000, 480_000, 900_000, 900_000];
    for (const ms of expected) {
      fail(limiter, 5, ['ip:a']);
      expect(limiter.check(['ip:a'])).toEqual({ allowed: false, retryAfterMs: ms });
      advance(ms);
      expect(limiter.check(['ip:a'])).toEqual({ allowed: true });
    }
  });

  it('success resets failures, lockout and the backoff level', () => {
    const { limiter, advance } = make();
    fail(limiter, 5, ['ip:a']);
    advance(60_000);
    fail(limiter, 5, ['ip:a']);
    expect(limiter.check(['ip:a'])).toMatchObject({ allowed: false, retryAfterMs: 120_000 });
    limiter.recordSuccess(['ip:a']);
    expect(limiter.check(['ip:a'])).toEqual({ allowed: true });
    fail(limiter, 4, ['ip:a']);
    expect(limiter.check(['ip:a'])).toEqual({ allowed: true });
    limiter.recordFailure(['ip:a']);
    expect(limiter.check(['ip:a'])).toEqual({ allowed: false, retryAfterMs: 60_000 });
  });

  it('a locked ip blocks even a fresh username and vice versa', () => {
    const { limiter } = make();
    fail(limiter, 5, ['ip:a', 'user:x']);
    expect(limiter.check(['ip:a', 'user:fresh']).allowed).toBe(false);
    expect(limiter.check(['ip:fresh', 'user:x']).allowed).toBe(false);
    expect(limiter.check(['ip:fresh', 'user:fresh']).allowed).toBe(true);
  });

  it('retryAfterMs counts down and is the longest among blocked keys', () => {
    const { limiter, advance } = make();
    fail(limiter, 5, ['ip:a']);
    advance(10_000);
    fail(limiter, 5, ['user:x']);
    expect(limiter.check(['ip:a'])).toEqual({ allowed: false, retryAfterMs: 50_000 });
    expect(limiter.check(['ip:a', 'user:x'])).toEqual({ allowed: false, retryAfterMs: 60_000 });
    advance(30_500);
    expect(limiter.check(['ip:a', 'user:x'])).toEqual({ allowed: false, retryAfterMs: 29_500 });
    advance(0.4);
    expect(limiter.check(['user:x'])).toMatchObject({ retryAfterMs: 29_500 });
  });

  it('backoff level resets after the key has been idle longer than maxLockoutMs', () => {
    const { limiter, advance } = make();
    fail(limiter, 5, ['ip:a']);
    advance(60_000);
    advance(15 * 60_000 + 1);
    fail(limiter, 5, ['ip:a']);
    expect(limiter.check(['ip:a'])).toEqual({ allowed: false, retryAfterMs: 60_000 });
  });

  it('prune drops idle keys and keeps active ones', () => {
    const { limiter, advance } = make();
    fail(limiter, 2, ['ip:old']);
    fail(limiter, 5, ['ip:locked']);
    advance(60_001);
    limiter.prune();
    expect(limiter.size()).toBe(1); // locked key expired, but within maxLockoutMs memory
    advance(15 * 60_000);
    limiter.prune();
    expect(limiter.size()).toBe(0);
  });

  it('prune drops a previously locked key that has only stale failures', () => {
    const { limiter, advance } = make();
    fail(limiter, 5, ['user:x']);
    advance(60_000);
    limiter.recordFailure(['user:x']);
    advance(60_000 + 15 * 60_000 + 1);
    limiter.prune();
    expect(limiter.size()).toBe(0);
  });

  it('recordFailure is a no-op while the key is locked', () => {
    const { limiter, advance } = make();
    fail(limiter, 5, ['ip:a']);
    fail(limiter, 10, ['ip:a']);
    expect(limiter.check(['ip:a'])).toEqual({ allowed: false, retryAfterMs: 60_000 });
    advance(60_000);
    fail(limiter, 4, ['ip:a']);
    expect(limiter.check(['ip:a'])).toEqual({ allowed: true });
    limiter.recordFailure(['ip:a']);
    expect(limiter.check(['ip:a'])).toEqual({ allowed: false, retryAfterMs: 120_000 });
  });

  it('idleness is measured from the last failure, not only the lockout end', () => {
    const { limiter, advance } = make();
    fail(limiter, 5, ['ip:a']);
    advance(60_000 + 15 * 60_000 - 30_000); // lock ended 14.5 min ago
    limiter.recordFailure(['ip:a']); // activity now
    advance(90_000); // lock ended > 15 min ago, but key active 90 s ago
    fail(limiter, 5, ['ip:a']);
    expect(limiter.check(['ip:a'])).toEqual({ allowed: false, retryAfterMs: 120_000 });
  });
});
