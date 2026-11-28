import { describe, expect, it } from 'vitest';
import { type CapturedError, ClientErrorReporter, REPORTER_LIMITS } from './reporter.ts';

function setup(opts: { csrf?: string | null } = {}) {
  let now = 0;
  const sent: { csrf: string; events: { message: string; count: number; kind: string }[] }[] = [];
  const timers = new Map<number, () => void>();
  let next = 1;
  const reporter = new ClientErrorReporter({
    send: (body) => sent.push(JSON.parse(body)),
    csrf: () => (opts.csrf === undefined ? 'tok' : opts.csrf),
    route: () => '/jobs/:id',
    version: '0.9.0',
    now: () => now,
    setTimer: (fn) => {
      timers.set(next, fn);
      return next++;
    },
    clearTimer: (h) => timers.delete(h as number),
  });
  return {
    reporter,
    sent,
    timers,
    fire: () => {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const err = (message: string, over: Partial<CapturedError> = {}): CapturedError => ({
  kind: 'error',
  name: 'TypeError',
  message,
  stack: 'TypeError: x\n    at f (http://h/assets/i.js:1:2)',
  ...over,
});

describe('ClientErrorReporter', () => {
  it('sends nothing at once, then one batch when the timer fires', () => {
    const { reporter, sent, fire, timers } = setup();
    reporter.capture(err('a'));
    reporter.capture(err('b'));
    expect(sent).toEqual([]);
    expect(timers.size).toBe(1);
    fire();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.csrf).toBe('tok');
    expect(sent[0]?.events.map((e) => e.message)).toEqual(['a', 'b']);
  });

  it('turns repeats of a queued error into a count', () => {
    const { reporter, sent, fire } = setup();
    for (let i = 0; i < 5; i += 1) reporter.capture(err('same'));
    reporter.capture(err('same', { kind: 'rejection' }));
    fire();
    expect(sent[0]?.events.map((e) => [e.kind, e.count])).toEqual([
      ['error', 5],
      ['rejection', 1],
    ]);
  });

  it('takes at most 10 new errors a minute and 100 for the page', () => {
    const { reporter, sent, fire, advance } = setup();
    for (let i = 0; i < 15; i += 1) reporter.capture(err(`e${i}`));
    fire();
    expect(sent[0]?.events).toHaveLength(REPORTER_LIMITS.perMinute);
    for (let m = 1; m < 20; m += 1) {
      advance(60_000);
      for (let i = 0; i < 15; i += 1) reporter.capture(err(`m${m}-${i}`));
      fire();
    }
    expect(sent.flatMap((b) => b.events)).toHaveLength(REPORTER_LIMITS.perPage);
  });

  it('sends a batch of 20 as soon as it is full', () => {
    const { reporter, sent, advance } = setup();
    for (let i = 0; i < 10; i += 1) reporter.capture(err(`a${i}`));
    advance(60_000);
    for (let i = 0; i < 10; i += 1) reporter.capture(err(`b${i}`));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events).toHaveLength(20);
  });

  it('drops noise and scrubs what it keeps', () => {
    const { reporter, sent, fire } = setup();
    reporter.capture(err('ResizeObserver loop completed with undelivered notifications.'));
    reporter.capture(err('x', { stack: 'f@chrome-extension://abc/x.js:1:2' }));
    reporter.capture(err('Cannot open "Harbor Lights"'));
    fire();
    expect(sent[0]?.events).toEqual([
      {
        kind: 'error',
        route: '/jobs/:id',
        version: '0.9.0',
        name: 'TypeError',
        message: 'Cannot open "…"',
        stack: ['at f (/assets/i.js:1:2)'],
        count: 1,
      },
    ]);
  });

  it('sends nothing while signed out', () => {
    const { reporter, sent, fire } = setup({ csrf: null });
    reporter.capture(err('a'));
    fire();
    expect(sent).toEqual([]);
  });

  it('flushes on close and then ignores errors until the page is shown again', () => {
    const { reporter, sent, fire } = setup();
    reporter.capture(err('before'));
    reporter.close();
    expect(sent).toHaveLength(1);
    reporter.capture(err('Failed to fetch, the page is unloading'));
    fire();
    expect(sent).toHaveLength(1);
    reporter.reopen();
    reporter.capture(err('after'));
    fire();
    expect(sent[1]?.events.map((e) => e.message)).toEqual(['after']);
  });
});
