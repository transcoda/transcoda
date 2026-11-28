import { describe, expect, it } from 'vitest';
import {
  CLIENT_ERROR_LIMITS,
  ClientErrorBatchSchema,
  clientErrorEvent,
  isNoise,
  type RawClientError,
  scrubFrame,
  scrubMessage,
  scrubName,
  scrubRoute,
  scrubStack,
  scrubVersion,
} from './client-errors.ts';

const raw = (over: Partial<RawClientError> = {}): RawClientError => ({
  kind: 'error',
  route: '/jobs/:id',
  version: '0.9.0',
  message: 'x is not a function',
  ...over,
});

describe('scrubMessage', () => {
  it.each([
    ['Cannot open /media/Movies/Harbor Lights (2020)/Harbor Lights.mkv', 'Cannot open <path>'],
    ['Cannot open C:\\Media\\Harbor Lights.mkv now', 'Cannot open <path>'],
    ['Probe failed: Harbor Lights.mkv is damaged', 'Probe failed: <file> is damaged'],
    ['Cannot open Harbor Lights.mkv', '<file>'],
    ['no poster (Otter and Finch poster.jpg) here', 'no poster (<file>) here'],
    ['Cannot open \\\\nas\\media\\x now', 'Cannot open <path>'],
    ['see ~/media/x and more', 'see <path>'],
    ['x and/or y', 'x <path>'],
    ['a / b is 1/2', 'a / b is <path>'],
    ['folder Movies/Otter and Finch is gone', 'folder <path>'],
    ['Failed to fetch http://192.168.1.20:8080/rpc/jobs/list?x=1', 'Failed to fetch <url>'],
    ['No reply from 10.0.0.5:8080 or nas.local:9000', 'No reply from <ip> or <host>'],
    ['Signed in as someone@example.com', 'Signed in as <email>'],
    ['Workflow "Harbor Lights" not found', 'Workflow "…" not found'],
    [
      'Unexpected token \'H\', "Harbor Lig"... is not valid JSON',
      'Unexpected token "…", "…"... is not valid JSON',
    ],
    ['Title “Otter and Finch” is missing', 'Title "…" is missing'],
    ['Unclosed "Otter and Finch is cut off', 'Unclosed "…'],
    ['job 3f2a91c0-1234-4abc-9def-0123456789ab failed', 'job <id> failed'],
    ['token tcd_abcDEF123_xyz leaked', 'token <token> leaked'],
    [
      'Cannot read properties of undefined (reading x)',
      'Cannot read properties of undefined (reading x)',
    ],
    ["can't reach the server", "can't reach the server"],
    ['  many\n\n  lines\there ', 'many lines here'],
  ])('%j becomes %j', (input, expected) => {
    expect(scrubMessage(input)).toBe(expected);
  });

  it('keeps at most 200 characters without cutting a placeholder in half', () => {
    const long = `${'a '.repeat(98)}"Harbor Lights" and more`;
    const out = scrubMessage(long);
    expect(out.length).toBeLessThanOrEqual(CLIENT_ERROR_LIMITS.message);
    expect(out.endsWith('…')).toBe(true);
    expect(out.replace(/"…"/g, '')).not.toContain('"');
  });
});

describe('scrubFrame', () => {
  it.each([
    [
      '    at JobPage (http://transcoda.lan:8080/assets/index-abc123.js:1:2345)',
      'at JobPage (/assets/index-abc123.js:1:2345)',
    ],
    [
      '    at http://transcoda.lan:8080/assets/index-abc123.js:1:2345',
      'at /assets/index-abc123.js:1:2345',
    ],
    [
      '    at async load (https://x.example/assets/a.js?v=2:3:4)',
      'at async load (/assets/a.js:3:4)',
    ],
    [
      '    at new Foo (http://localhost:5173/src/jobs/JobPage.tsx?t=1:10:5)',
      'at new Foo (/src/jobs/JobPage.tsx:10:5)',
    ],
    ['render@http://h:1/assets/index-abc.js:1:99', 'at render (/assets/index-abc.js:1:99)'],
    ['@http://h:1/assets/index-abc.js:1:99', 'at /assets/index-abc.js:1:99'],
    ['    at f (https://cdn.example/some/page:1:2)', 'at f (<url>:1:2)'],
    ['    at f (blob:http://h/3f2a:1:2)', 'at f (<url>:1:2)'],
    ['    at <anonymous>:1:2', 'at <anonymous>:1:2'],
    ['    at f (/assets/a.js:1:2)', 'at f (/assets/a.js:1:2)'],
    ['    at Harbor Lights (/assets/a.js:1:2)', 'at ? (/assets/a.js:1:2)'],
  ])('%j becomes %j', (input, expected) => {
    expect(scrubFrame(input)).toBe(expected);
  });

  it('is null for a line that is not a frame', () => {
    expect(scrubFrame('TypeError: x is not a function')).toBeNull();
    expect(scrubFrame('')).toBeNull();
  });

  it('a scrubbed frame scrubs to itself', () => {
    const f = scrubFrame('    at JobPage (http://h:8080/assets/index-abc123.js:1:2345)') ?? '';
    expect(scrubFrame(f)).toBe(f);
  });
});

describe('scrubStack', () => {
  it('drops the message line and keeps the frames, top first', () => {
    const stack = [
      'TypeError: Cannot read /media/x.mkv',
      '    at a (http://h/assets/i.js:1:1)',
      '    at b (http://h/assets/i.js:1:2)',
    ].join('\n');
    expect(scrubStack(stack)).toEqual(['at a (/assets/i.js:1:1)', 'at b (/assets/i.js:1:2)']);
  });

  it('keeps at most 15 frames', () => {
    const stack = Array.from(
      { length: 40 },
      (_, i) => `    at f${i} (http://h/assets/i.js:1:${i})`,
    );
    expect(scrubStack(stack.join('\n'))).toHaveLength(CLIENT_ERROR_LIMITS.frames);
  });
});

describe('noise', () => {
  it.each([
    raw({ message: 'ResizeObserver loop completed with undelivered notifications.' }),
    raw({ message: 'ResizeObserver loop limit exceeded' }),
    raw({ name: 'AbortError', message: 'signal is aborted without reason' }),
    raw({ kind: 'rejection', message: 'The operation was aborted.' }),
    raw({ message: 'Script error.' }),
    raw({ stack: 'Error: x\n    at f (chrome-extension://abcdef/content.js:1:2)' }),
    raw({ stack: 'f@moz-extension://abcdef/content.js:1:2' }),
    raw({ kind: 'csp', message: 'script-src blocked safari-web-extension://x/y.js' }),
  ])('%j is noise', (e) => {
    expect(isNoise(e)).toBe(true);
    expect(clientErrorEvent(e)).toBeNull();
  });

  it('a real error is not', () => {
    expect(isNoise(raw())).toBe(false);
  });
});

describe('clientErrorEvent', () => {
  it('scrubs every field', () => {
    expect(
      clientErrorEvent(
        raw({
          route: '/libraries/3f2a/files/Harbor Lights',
          version: 'v 1',
          name: 'Harbor Lights',
          message: 'Cannot open "Harbor Lights"',
          stack: 'Error\n    at f (http://h/assets/i.js:1:2)',
        }),
      ),
    ).toEqual({
      kind: 'error',
      route: '<unknown>',
      version: 'unknown',
      name: 'Error',
      message: 'Cannot open "…"',
      stack: ['at f (/assets/i.js:1:2)'],
      count: 1,
    });
  });
});

describe('route, name and version', () => {
  it('keeps one of the web UI’s route patterns and refuses anything else', () => {
    for (const r of ['/', '/jobs', '/jobs/:id', '/settings/:section?/:sub?', '/*']) {
      expect(scrubRoute(r)).toBe(r);
    }
    for (const r of ['/libraries/Movies', '/movies', '/jobs/3f2a', 'jobs', '/a b', '/x?y=1', '']) {
      expect(scrubRoute(r)).toBe('<unknown>');
    }
  });

  it('keeps a class name', () => {
    expect(scrubName('TypeError')).toBe('TypeError');
    expect(scrubName('Harbor Lights')).toBe('Error');
    expect(scrubName(42)).toBe('Error');
  });

  it('keeps a version', () => {
    expect(scrubVersion('0.9.0-dev+abc1234')).toBe('0.9.0-dev+abc1234');
    expect(scrubVersion('<script>')).toBe('unknown');
  });
});

describe('ClientErrorBatchSchema', () => {
  const event = {
    kind: 'api',
    route: '/jobs',
    version: '0.9.0',
    name: 'ORPCError',
    message: 'jobs.list 500 INTERNAL_SERVER_ERROR',
    stack: [],
    count: 3,
  };

  it('accepts a batch', () => {
    expect(ClientErrorBatchSchema.parse({ csrf: 't', events: [event] }).events).toEqual([event]);
  });

  it('scrubs what it parses, so a hand-made request logs nothing the browser would not send', () => {
    const parsed = ClientErrorBatchSchema.parse({
      csrf: 't',
      events: [
        {
          ...event,
          route: '/libraries/Movies',
          message: 'open /media/Harbor Lights.mkv',
          stack: ['at f (http://h/assets/i.js:1:2)', 'not a frame'],
        },
      ],
    });
    expect(parsed.events[0]).toMatchObject({
      route: '<unknown>',
      message: 'open <path>',
      stack: ['at f (/assets/i.js:1:2)'],
    });
  });

  it.each([
    ['an unknown kind', { ...event, kind: 'pageview' }],
    ['an extra field', { ...event, url: 'http://h/jobs/1' }],
    ['a zero count', { ...event, count: 0 }],
    ['a huge count', { ...event, count: 1_000_000 }],
    ['a long message', { ...event, message: 'x'.repeat(5000) }],
  ])('refuses %s', (_, bad) => {
    expect(ClientErrorBatchSchema.safeParse({ csrf: 't', events: [bad] }).success).toBe(false);
  });

  it('refuses an empty or oversized batch', () => {
    expect(ClientErrorBatchSchema.safeParse({ csrf: 't', events: [] }).success).toBe(false);
    const many = Array.from({ length: CLIENT_ERROR_LIMITS.batch + 1 }, () => event);
    expect(ClientErrorBatchSchema.safeParse({ csrf: 't', events: many }).success).toBe(false);
  });
});
