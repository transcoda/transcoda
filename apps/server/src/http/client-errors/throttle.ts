/**
 * At most `limit` log lines a minute for the web UI's error reports, whichever tab sends them, so a
 * page stuck in an error loop cannot fill the log. The metric still counts every report.
 */
export class LogThrottle {
  private windowStart = Number.NEGATIVE_INFINITY;
  private used = 0;

  constructor(
    private readonly limit: number,
    private readonly now: () => number,
    private readonly windowMs = 60_000,
  ) {}

  /**
   * `log`: write this line. `first-drop`: the first line refused in this window (say so once).
   * `drop`: refused.
   */
  take(): 'log' | 'first-drop' | 'drop' {
    const now = this.now();
    if (now - this.windowStart >= this.windowMs || now < this.windowStart) {
      this.windowStart = now;
      this.used = 0;
    }
    this.used += 1;
    if (this.used <= this.limit) return 'log';
    return this.used === this.limit + 1 ? 'first-drop' : 'drop';
  }
}
