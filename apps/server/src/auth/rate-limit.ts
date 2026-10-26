export interface RateLimitOptions {
  maxFailures: number;
  windowMs: number;
  baseLockoutMs: number;
  maxLockoutMs: number;
  now?: () => number;
}

interface KeyState {
  failures: number[];
  lockedUntil: number;
  consecutiveLockouts: number;
  lastFailureAt: number;
}

const DEFAULTS = {
  maxFailures: 5,
  windowMs: 60_000,
  baseLockoutMs: 60_000,
  maxLockoutMs: 15 * 60_000,
};

/** In-memory login throttle (single process, no persistence). Keys look like `ip:<ip>` / `user:<name>`. */
export class LoginRateLimiter {
  private readonly opts: Required<RateLimitOptions>;
  private readonly states = new Map<string, KeyState>();

  constructor(opts: Partial<RateLimitOptions> = {}) {
    this.opts = { ...DEFAULTS, now: Date.now, ...stripUndefined(opts) };
  }

  check(keys: string[]): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = this.opts.now();
    let longest = 0;
    for (const key of keys) {
      const s = this.states.get(key);
      if (s && s.lockedUntil > now) longest = Math.max(longest, s.lockedUntil - now);
    }
    if (longest > 0) return { allowed: false, retryAfterMs: Math.max(1, Math.ceil(longest)) };
    return { allowed: true };
  }

  recordFailure(keys: string[]): void {
    const now = this.opts.now();
    for (const key of new Set(keys)) {
      let s = this.states.get(key);
      if (!s) {
        s = { failures: [], lockedUntil: 0, consecutiveLockouts: 0, lastFailureAt: 0 };
        this.states.set(key, s);
      }
      if (s.lockedUntil > now) continue; // locked: failures are not counted
      this.trim(s, now);
      if (this.idleLongerThanMaxLockout(s, now)) s.consecutiveLockouts = 0;
      s.failures.push(now);
      s.lastFailureAt = now;
      if (s.failures.length >= this.opts.maxFailures) {
        const lockout = Math.min(
          this.opts.baseLockoutMs * 2 ** s.consecutiveLockouts,
          this.opts.maxLockoutMs,
        );
        s.lockedUntil = now + lockout;
        s.consecutiveLockouts += 1;
        s.failures = [];
      }
    }
  }

  recordSuccess(keys: string[]): void {
    for (const key of keys) this.states.delete(key);
  }

  /** Drop keys with an empty window and an expired lockout; keep backoff memory until idle > maxLockoutMs. */
  prune(): void {
    const now = this.opts.now();
    for (const [key, s] of this.states) {
      this.trim(s, now);
      if (s.failures.length > 0 || s.lockedUntil > now) continue;
      if (s.consecutiveLockouts === 0 || this.idleLongerThanMaxLockout(s, now)) {
        this.states.delete(key);
      }
    }
  }

  /** Number of tracked keys (for tests and diagnostics). */
  size(): number {
    return this.states.size;
  }

  private idleLongerThanMaxLockout(s: KeyState, now: number): boolean {
    if (s.lockedUntil > now || s.failures.length > 0) return false;
    return now - Math.max(s.lockedUntil, s.lastFailureAt) > this.opts.maxLockoutMs;
  }

  private trim(s: KeyState, now: number): void {
    s.failures = s.failures.filter((t) => now - t < this.opts.windowMs);
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
