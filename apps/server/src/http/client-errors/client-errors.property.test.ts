import {
  CLIENT_ERROR_LIMITS,
  ClientErrorBatchSchema,
  scrubFrame,
  scrubMessage,
  scrubStack,
} from '@transcoda/shared';
import { fcRuns } from '@transcoda/shared/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The scrubbing rules live in @transcoda/shared (which has no test dependencies); the server parses
// every report with them, so their properties are held here, beside the route.
// A "secret" is anything an error message must never carry: a title, a folder, a host, a person.
const word = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{3,11}$/);
const title = fc.array(word, { minLength: 1, maxLength: 4 }).map((w) => w.join(' '));
const segment = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ()._-]{2,15}[A-Za-z0-9)]$/);
const unixPath = fc.array(segment, { minLength: 1, maxLength: 5 }).map((s) => `/${s.join('/')}`);
const winPath = fc.array(segment, { minLength: 1, maxLength: 4 }).map((s) => `D:\\${s.join('\\')}`);
const host = fc.stringMatching(/^[a-z][a-z0-9-]{3,10}(\.[a-z]{2,5}){0,2}$/);
const ip = fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255), fc.nat(255)).map((p) => p.join('.'));
const email = fc.tuple(word, host).map(([u, h]) => `${u}@${h}.com`);
const prose = fc.stringMatching(/^[a-z ,:;!]{0,40}$/);

/** Text around a secret, so the secret is never at a convenient boundary. */
const around = (secret: fc.Arbitrary<string>, wrap: (s: string) => string) =>
  fc
    .tuple(prose, secret, prose)
    .map(([a, s, b]) => ({ secret: s, message: `${a} ${wrap(s)} ${b}` }));

const cases: [string, fc.Arbitrary<{ secret: string; message: string }>][] = [
  ['a double-quoted title', around(title, (t) => `"${t}"`)],
  ['a single-quoted title', around(title, (t) => `'${t}'`)],
  ['a curly-quoted title', around(title, (t) => `“${t}”`)],
  ['a backtick-quoted title', around(title, (t) => `\`${t}\``)],
  ['a title in an unclosed quote', around(title, (t) => `"${t}`)],
  ['a Unix path', around(unixPath, (p) => p)],
  ['a Windows path', around(winPath, (p) => p)],
  [
    'a URL',
    around(
      fc.tuple(host, unixPath).map(([h, p]) => `https://${h}${p}`),
      (u) => u,
    ),
  ],
  [
    'a host and port',
    around(
      fc.tuple(host, fc.integer({ min: 10, max: 65535 })).map(([h, p]) => `${h}:${p}`),
      (h) => h,
    ),
  ],
  ['an IP address', around(ip, (i) => i)],
  ['an email address', around(email, (e) => e)],
  [
    'a media file',
    around(
      fc
        .tuple(word, fc.constantFrom('mkv', 'mp4', 'srt', 'nfo', 'jpg'))
        .map(([w, x]) => `${w}.${x}`),
      (f) => f,
    ),
  ],
];

describe('scrubMessage, for any message', () => {
  it.each(cases)('never keeps %s', (_, arb) => {
    fc.assert(
      fc.property(arb, ({ secret, message }) => {
        expect(scrubMessage(message)).not.toContain(secret);
      }),
      fcRuns(),
    );
  });

  it('never throws and stays within the limit', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 3000, unit: 'binary' }), (s) => {
        expect(scrubMessage(s).length).toBeLessThanOrEqual(CLIENT_ERROR_LIMITS.message);
      }),
      fcRuns(),
    );
  });
});

describe('scrubFrame and scrubStack, for any input', () => {
  it('never keep the host of a script URL, nor its query', () => {
    fc.assert(
      fc.property(host, fc.nat(9999), word, (h, port, q) => {
        const frame = scrubFrame(`    at f (http://${h}:${port}/assets/i.js?${q}=1:1:2)`);
        expect(frame).toBe('at f (/assets/i.js:1:2)');
      }),
      fcRuns(),
    );
  });

  it('never throw, and every frame scrubs to itself', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (s) => {
        const frames = scrubStack(s);
        expect(frames.length).toBeLessThanOrEqual(CLIENT_ERROR_LIMITS.frames);
        for (const f of frames) {
          expect(f.length).toBeLessThanOrEqual(CLIENT_ERROR_LIMITS.frame);
          expect(scrubFrame(f)).toBe(f);
        }
      }),
      fcRuns(),
    );
  });
});

describe('ClientErrorBatchSchema, for any event a client sends', () => {
  it('scrubs the message and the route as the browser does, whatever the client sends', () => {
    fc.assert(
      fc.property(fc.oneof(...cases.map(([, arb]) => arb)), ({ secret, message }) => {
        const parsed = ClientErrorBatchSchema.parse({
          csrf: 't',
          events: [
            {
              kind: 'error',
              route: `/${secret}`,
              version: '0.9.0',
              name: 'Error',
              message,
              stack: [`at f (https://${secret}/assets/i.js:1:2)`],
              count: 1,
            },
          ],
        });
        expect(JSON.stringify(parsed.events)).not.toContain(secret);
      }),
      fcRuns(),
    );
  });
});
