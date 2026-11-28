// Collects the web UI's errors and sends them to the Transcoda server in batches: repeats of one
// error become a count, new errors are rate-limited, and the queue is sent within a few seconds,
// when it is full, when the tab is hidden and when the page goes away. Plain TypeScript; the
// browser hooks are in client-errors.ts.
import {
  CLIENT_ERROR_LIMITS,
  type ClientErrorEvent,
  clientErrorEvent,
  type RawClientError,
} from '@transcoda/shared';

export const REPORTER_LIMITS = {
  /** A queued error waits at most this long before it is sent. */
  flushMs: 5_000,
  /** New errors a minute (repeats of a queued one are free: they only raise its count). */
  perMinute: 10,
  /** New errors for the life of the page, so a loop cannot report forever. */
  perPage: 100,
} as const;

export interface ReporterDeps {
  /** Hands one request body to the browser (sendBeacon); never throws. */
  send: (body: string) => void;
  /** The session's CSRF token; null while signed out (then nothing is sent). */
  csrf: () => string | null;
  /** The current route pattern. */
  route: () => string;
  version: string;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export type CapturedError = Omit<RawClientError, 'route' | 'version'>;

export class ClientErrorReporter {
  private readonly pending = new Map<string, ClientErrorEvent>();
  private timer: unknown = null;
  private windowStart = Number.NEGATIVE_INFINITY;
  private inWindow = 0;
  private total = 0;
  private closed = false;

  constructor(private readonly deps: ReporterDeps) {}

  capture(error: CapturedError): void {
    if (this.closed) return;
    const e = clientErrorEvent({ ...error, route: this.deps.route(), version: this.deps.version });
    if (!e) return;
    const key = [e.kind, e.route, e.name, e.message, e.stack[0] ?? ''].join('\n');
    const queued = this.pending.get(key);
    if (queued) {
      queued.count = Math.min(queued.count + 1, CLIENT_ERROR_LIMITS.count);
      return;
    }
    if (!this.allowNew()) return;
    this.pending.set(key, e);
    if (this.pending.size >= CLIENT_ERROR_LIMITS.batch) this.flush();
    else if (this.timer === null) {
      this.timer = this.deps.setTimer(() => this.flush(), REPORTER_LIMITS.flushMs);
    }
  }

  private allowNew(): boolean {
    const now = this.deps.now();
    if (now - this.windowStart >= 60_000 || now < this.windowStart) {
      this.windowStart = now;
      this.inWindow = 0;
    }
    if (this.inWindow >= REPORTER_LIMITS.perMinute || this.total >= REPORTER_LIMITS.perPage) {
      return false;
    }
    this.inWindow += 1;
    this.total += 1;
    return true;
  }

  /** Sends what is queued, as one request. Signed out, the queue is dropped. */
  flush(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    const events = [...this.pending.values()];
    this.pending.clear();
    const csrf = this.deps.csrf();
    if (csrf === null) return;
    this.deps.send(JSON.stringify({ csrf, events }));
  }

  /**
   * The page is going away (`pagehide`): send now, then ignore errors until it is shown again,
   * since requests cut off by the unload fail and are not Transcoda's errors.
   */
  close(): void {
    this.flush();
    this.closed = true;
  }

  /** The page came back from the back-forward cache. */
  reopen(): void {
    this.closed = false;
  }
}
