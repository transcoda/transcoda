// Is there a newer Transcoda? Asks GitHub for the latest release a minute after start and then every
// 6 hours, and fetches that release's changelog.json for the notes of every version in between.
// Notice only: nothing is downloaded or installed (the person updates their container).
import type { AppUpdateOutput, ReleaseNotes } from '@transcoda/contract';
import { ReleaseNotesSchema } from '@transcoda/contract';
import semver from 'semver';
import { z } from 'zod';
import type { EngineEvents } from '../engine/events.ts';
import type { Logger } from '../logger.ts';
import { readLimited } from '../plugins/token-hosts.ts';

const REPO = 'transcoda/transcoda';
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
/** The release's own changelog.json: the notes as data, written by `pnpm release`. */
export const changelogUrl = (tag: string): string =>
  `https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(tag)}/apps/server/src/changelog.json`;
export const CHANGELOG_PAGE_URL = `https://github.com/${REPO}/blob/main/CHANGELOG.md`;

/** The first check waits this long after start, so it never competes with boot. */
export const APP_UPDATE_DELAY_MS = 60_000;
/** Then GitHub is asked this often (4 calls a day, far below its limit for unauthenticated calls). */
export const APP_UPDATE_INTERVAL_MS = 6 * 3_600_000;
/** Versions shown with their notes; older ones are only counted (the full changelog is linked). */
export const SHOWN_RELEASES = 5;
const FETCH_TIMEOUT_MS = 10_000;
/** A changelog grows by a few kB a release; anything far larger is not ours. */
const MAX_BODY_BYTES = 1_000_000;

const LatestReleaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.url(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
});
const ChangelogSchema = z.array(ReleaseNotesSchema);

export interface AppUpdateCheckerOptions {
  /** The running version (`VERSION`). */
  version: string;
  /** TRANSCODA_UPDATE_CHECK; false never calls GitHub. */
  enabled: boolean;
  events: Pick<EngineEvents, 'publish'>;
  log: Logger;
  fetch?: typeof fetch;
  now?: () => Date;
  delayMs?: number;
  intervalMs?: number;
}

/** `v0.3.0` → `0.3.0`; null for anything that is not a plain release version. */
function releaseVersion(tag: string): string | null {
  const v = semver.valid(tag.replace(/^v/, ''));
  return v !== null && semver.prerelease(v) === null ? v : null;
}

/**
 * Checks for a newer release in the background and keeps the last answer in memory (so a restart
 * starts without one). A build from source (`0.0.0-dev`, or any pre-release version) never checks.
 */
export class AppUpdateChecker {
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;
  private readonly active: boolean;
  private update: AppUpdateOutput['update'] = null;
  private checkedAt: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: AppUpdateCheckerOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.active = opts.enabled && releaseVersion(opts.version) !== null;
  }

  start(): void {
    if (!this.active || this.timer !== null) return;
    this.stopped = false;
    this.schedule(this.opts.delayMs ?? APP_UPDATE_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  status(): AppUpdateOutput {
    return {
      current: this.opts.version,
      checking: this.active,
      checkedAt: this.checkedAt,
      update: this.update,
    };
  }

  /**
   * One check; never throws. A failed check keeps the answer last known (GitHub being down says
   * nothing about the release), and a newer release whose notes cannot be read still shows, without
   * them.
   */
  async checkOnce(): Promise<void> {
    if (!this.active) return;
    try {
      const latest = LatestReleaseSchema.parse(await this.getJson(LATEST_RELEASE_URL));
      const version = releaseVersion(latest.tag_name);
      const next =
        version !== null &&
        !latest.draft &&
        !latest.prerelease &&
        semver.gt(version, this.opts.version)
          ? {
              version,
              url: latest.html_url,
              changelogUrl: CHANGELOG_PAGE_URL,
              ...(await this.notesBetween(latest.tag_name, version)),
            }
          : null;
      this.checkedAt = this.now().toISOString();
      if (this.stopped) return;
      const changed = next?.version !== this.update?.version;
      this.update = next;
      if (changed) this.opts.events.publish({ type: 'app.update', version: next?.version ?? null });
    } catch (err) {
      this.opts.log.warn({
        msg: 'update check failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The notes of every version after the running one up to `version`, newest first. */
  private async notesBetween(
    tag: string,
    version: string,
  ): Promise<{ releases: ReleaseNotes[]; olderReleases: number }> {
    let all: ReleaseNotes[];
    try {
      all = ChangelogSchema.parse(await this.getJson(changelogUrl(tag)));
    } catch (err) {
      this.opts.log.warn({
        msg: 'release notes could not be read',
        error: err instanceof Error ? err.message : String(err),
      });
      return { releases: [], olderReleases: 0 };
    }
    const missed = all
      .filter(
        (r) =>
          semver.valid(r.version) !== null &&
          semver.gt(r.version, this.opts.version) &&
          semver.lte(r.version, version),
      )
      .sort((a, b) => semver.rcompare(a.version, b.version));
    return {
      releases: missed.slice(0, SHOWN_RELEASES),
      olderReleases: Math.max(0, missed.length - SHOWN_RELEASES),
    };
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await this.fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `transcoda/${this.opts.version}`,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    // Read with the cap, so a huge answer is cut off instead of held in memory.
    const body = await readLimited(res, MAX_BODY_BYTES);
    if (body === null) throw new Error(`${url} answered more than 1 MB`);
    return JSON.parse(body.toString('utf8'));
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      void this.checkOnce().then(() => {
        if (!this.stopped) this.schedule(this.opts.intervalMs ?? APP_UPDATE_INTERVAL_MS);
      });
    }, ms);
    this.timer.unref();
  }
}
