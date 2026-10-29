import type { ReleaseNotes } from '@transcoda/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger.ts';
import {
  AppUpdateChecker,
  type AppUpdateCheckerOptions,
  CHANGELOG_PAGE_URL,
  changelogUrl,
  LATEST_RELEASE_URL,
} from './app-update.ts';

const NOW = new Date('2026-10-29T12:00:00.000Z');

const notes = (version: string, ...entries: ReleaseNotes['entries']): ReleaseNotes => ({
  version,
  date: '2026-10-28',
  entries,
});

const CHANGELOG: ReleaseNotes[] = [
  notes('0.4.0', { type: 'new', text: 'Four.' }),
  notes(
    '0.3.0',
    { type: 'fixed', text: 'Three.' },
    { type: 'breaking', text: 'Rename a variable.' },
  ),
  notes('0.2.0', { type: 'new', text: 'Two.' }),
  notes('0.1.0', { type: 'new', text: 'One.' }),
];

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/transcoda/transcoda/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  ...extra,
});

/** A fetch that answers per URL; a missing URL is a 404. */
function fakeFetch(answers: Record<string, unknown>) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (!(url in answers)) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(answers[url]), { status: 200 });
  });
}

let checker: AppUpdateChecker | undefined;
afterEach(() => {
  checker?.stop();
  checker = undefined;
  vi.useRealTimers();
});

function make(opts: Partial<AppUpdateCheckerOptions> & { fetch: typeof fetch }) {
  const publish = vi.fn();
  const warn = vi.fn<Logger['warn']>();
  checker = new AppUpdateChecker({
    version: '0.2.0',
    enabled: true,
    events: { publish },
    log: { info: vi.fn(), warn, error: vi.fn() },
    now: () => NOW,
    ...opts,
  });
  return { checker, publish, warn };
}

describe('AppUpdateChecker', () => {
  it('a newer release: the version, its page and the notes of every missed version, newest first', async () => {
    const fetch = fakeFetch({
      [LATEST_RELEASE_URL]: release('v0.4.0'),
      [changelogUrl('v0.4.0')]: CHANGELOG,
    });
    const { checker, publish } = make({ fetch });
    await checker.checkOnce();
    expect(checker.status()).toEqual({
      current: '0.2.0',
      checking: true,
      checkedAt: NOW.toISOString(),
      update: {
        version: '0.4.0',
        url: 'https://github.com/transcoda/transcoda/releases/tag/v0.4.0',
        changelogUrl: CHANGELOG_PAGE_URL,
        releases: [CHANGELOG[0], CHANGELOG[1]],
        olderReleases: 0,
      },
    });
    expect(publish).toHaveBeenCalledWith({ type: 'app.update', version: '0.4.0' });
    // GitHub sees who asks, and the call can never hang a check.
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ 'user-agent': 'transcoda/0.2.0' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('the same or an older release: no update, no event', async () => {
    for (const tag of ['v0.2.0', 'v0.1.0']) {
      const { checker, publish } = make({
        fetch: fakeFetch({ [LATEST_RELEASE_URL]: release(tag) }),
      });
      await checker.checkOnce();
      expect(checker.status().update).toBeNull();
      expect(checker.status().checkedAt).toBe(NOW.toISOString());
      expect(publish).not.toHaveBeenCalled();
    }
  });

  it('a draft, a pre-release or a pre-release tag is not offered', async () => {
    for (const latest of [
      release('v0.4.0', { draft: true }),
      release('v0.4.0', { prerelease: true }),
      release('v0.4.0-rc.1'),
      release('nightly'),
    ]) {
      const { checker } = make({ fetch: fakeFetch({ [LATEST_RELEASE_URL]: latest }) });
      await checker.checkOnce();
      expect(checker.status().update).toBeNull();
    }
  });

  it('shows the five newest missed versions and counts the older ones', async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      notes(`0.${10 - i}.0`, { type: 'new', text: `v${10 - i}` }),
    );
    const { checker } = make({
      fetch: fakeFetch({
        [LATEST_RELEASE_URL]: release('v0.10.0'),
        [changelogUrl('v0.10.0')]: many,
      }),
    });
    await checker.checkOnce();
    const update = checker.status().update;
    expect(update?.releases.map((r) => r.version)).toEqual([
      '0.10.0',
      '0.9.0',
      '0.8.0',
      '0.7.0',
      '0.6.0',
    ]);
    expect(update?.olderReleases).toBe(3);
  });

  it('notes that cannot be read: the update still shows, without them', async () => {
    const { checker, warn } = make({
      fetch: fakeFetch({
        [LATEST_RELEASE_URL]: release('v0.4.0'),
        [changelogUrl('v0.4.0')]: { not: 'a list' },
      }),
    });
    await checker.checkOnce();
    expect(checker.status().update).toMatchObject({
      version: '0.4.0',
      releases: [],
      olderReleases: 0,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'release notes could not be read' }),
    );
  });

  it('a failed check keeps the answer last known and logs a warning', async () => {
    const answers: Record<string, unknown> = {
      [LATEST_RELEASE_URL]: release('v0.4.0'),
      [changelogUrl('v0.4.0')]: CHANGELOG,
    };
    const { checker, publish, warn } = make({ fetch: fakeFetch(answers) });
    await checker.checkOnce();
    delete answers[LATEST_RELEASE_URL];
    await checker.checkOnce();
    expect(checker.status().update?.version).toBe('0.4.0');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: 'update check failed' }));
  });

  it('after the update lands (the same release again) nothing is published twice', async () => {
    const { checker, publish } = make({
      fetch: fakeFetch({
        [LATEST_RELEASE_URL]: release('v0.4.0'),
        [changelogUrl('v0.4.0')]: CHANGELOG,
      }),
    });
    await checker.checkOnce();
    await checker.checkOnce();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('off (TRANSCODA_UPDATE_CHECK=false) or a build from source never asks GitHub', async () => {
    for (const opts of [{ enabled: false }, { version: '0.0.0-dev' }, { version: 'local' }]) {
      const fetch = fakeFetch({ [LATEST_RELEASE_URL]: release('v0.4.0') });
      const { checker } = make({ fetch, ...opts });
      checker.start();
      await checker.checkOnce();
      expect(fetch).not.toHaveBeenCalled();
      expect(checker.status()).toMatchObject({ checking: false, checkedAt: null, update: null });
    }
  });

  it('checks a minute after start, then on every interval', async () => {
    vi.useFakeTimers();
    const fetch = fakeFetch({ [LATEST_RELEASE_URL]: release('v0.2.0') });
    const { checker } = make({ fetch, delayMs: 60_000, intervalMs: 1_000_000 });
    checker.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    checker.stop();
    await vi.advanceTimersByTimeAsync(5_000_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
