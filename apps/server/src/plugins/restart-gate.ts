/**
 * Lets the engine wait for plugins that are coming back (starting, or in restart backoff after a
 * crash). Late-bound like the hook runner: the engine is built before the plugin service.
 */
export interface RestartTarget {
  /** ms from now by which every returning plugin should be running; null when none is returning. */
  comingBackIn(): number | null;
}

const POLL_MS = 100;

export class PluginRestartGate {
  private target: RestartTarget | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  attachTarget(target: RestartTarget): void {
    this.target = target;
  }

  /**
   * Waits until no plugin is starting or restarting, at most until the deadline the supervisor
   * gives (next restart plus start timeout). Resolves true when it had to wait at all, false when
   * nothing was coming back (a stopped, disabled or removed plugin is not waited for). An abort
   * ends the wait early.
   */
  async waitForRestarts(signal?: AbortSignal): Promise<boolean> {
    let waited = false;
    let by = 0;
    for (;;) {
      const left = this.target?.comingBackIn() ?? null;
      if (left === null || signal?.aborted) return waited;
      // The deadline is fixed by the first answer: a plugin that crashes again meanwhile does not extend it.
      if (!waited) by = this.now() + left;
      waited = true;
      if (this.now() >= by) return waited;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(POLL_MS, Math.max(1, by - this.now())));
        function done() {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          resolve();
        }
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }
}
