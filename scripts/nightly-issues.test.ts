import { describe, expect, it } from 'vitest';
import {
  idOf,
  MANY_ID,
  MAX_NEW,
  parsePlaywright,
  parseVitest,
  plan,
  RUN_ID,
  type TestResult,
  titleOf,
} from './nightly-issues.ts';

const ctx = { runFailed: false, runUrl: 'https://example.test/run/1', sha: 'abcdef0123' };
const pass = (id: string): TestResult => ({ id, passed: true, error: '' });
const fail = (id: string, error = 'boom'): TestResult => ({ id, passed: false, error });

describe('parseVitest', () => {
  it('names each test by its file and full name, and a file that did not load as one failure', () => {
    const results = parseVitest(
      {
        testResults: [
          {
            name: '/repo/apps/web/src/a.test.ts',
            status: 'failed',
            assertionResults: [
              {
                fullName: 'A works',
                ancestorTitles: ['A'],
                title: 'works',
                status: 'passed',
                failureMessages: [],
              },
              {
                fullName: 'A breaks',
                status: 'failed',
                failureMessages: ['\u001b[31mAssertionError\u001b[39m: no'],
              },
              { fullName: 'A later', status: 'skipped' },
            ],
          },
          {
            name: '/repo/apps/server/src/b.test.ts',
            status: 'failed',
            message: 'Cannot find module x',
            assertionResults: [],
          },
        ],
      },
      '/repo',
    );
    expect(results).toEqual([
      { id: 'apps/web/src/a.test.ts > A > works', passed: true, error: '' },
      { id: 'apps/web/src/a.test.ts > A breaks', passed: false, error: 'AssertionError: no' },
      { id: 'apps/server/src/b.test.ts (the file)', passed: false, error: 'Cannot find module x' },
    ]);
  });
});

describe('parsePlaywright', () => {
  it('names each test per project with its describe titles; flaky passes, skipped is left out', () => {
    const results = parsePlaywright({
      suites: [
        {
          title: '3-visual.e2e.ts',
          file: '3-visual.e2e.ts',
          specs: [
            {
              title: 'main pages',
              file: '3-visual.e2e.ts',
              tests: [
                { projectName: 'light', status: 'expected', results: [{}] },
                {
                  projectName: 'dark',
                  status: 'unexpected',
                  results: [{ error: { message: 'jobs.png: 12 pixels differ' } }],
                },
                { projectName: 'phone', status: 'flaky', results: [{ error: {} }, {}] },
                { projectName: 'other', status: 'skipped', results: [] },
              ],
            },
          ],
          suites: [
            {
              title: 'signed out',
              specs: [
                {
                  title: 'sign-in page',
                  file: '3-visual.e2e.ts',
                  tests: [{ projectName: 'light', status: 'expected', results: [{}] }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(results).toEqual([
      { id: 'e2e/3-visual.e2e.ts > [light] > main pages', passed: true, error: '' },
      {
        id: 'e2e/3-visual.e2e.ts > [dark] > main pages',
        passed: false,
        error: 'jobs.png: 12 pixels differ',
      },
      { id: 'e2e/3-visual.e2e.ts > [phone] > main pages', passed: true, error: '' },
      { id: 'e2e/3-visual.e2e.ts > [light] > signed out > sign-in page', passed: true, error: '' },
    ]);
  });
});

describe('plan', () => {
  it('opens an issue for a new failure, with the marker its test id is found by', () => {
    const [action] = plan([fail('a.test.ts > breaks')], [], ctx);
    expect(action).toMatchObject({
      kind: 'create',
      id: 'a.test.ts > breaks',
      title: 'Nightly: a.test.ts > breaks',
    });
    const body = action?.kind === 'create' ? action.body : '';
    expect(body).toContain('[run](https://example.test/run/1), commit abcdef0');
    expect(body).toContain('```\nboom\n```');
    expect(idOf(body)).toBe('a.test.ts > breaks');
  });

  it('comments on the open issue of a test that still fails, and closes the one that passes', () => {
    const actions = plan(
      [fail('a > still'), pass('b > fixed'), pass('c > never broke')],
      [
        { number: 7, id: 'a > still' },
        { number: 8, id: 'b > fixed' },
        { number: 9, id: 'd > did not run' },
      ],
      ctx,
    );
    expect(actions.map((a) => [a.kind, 'number' in a ? a.number : a.id])).toEqual([
      ['comment', 7],
      ['close', 8],
    ]);
  });

  it('a run that failed without a failing test gets the run issue; a good run closes it', () => {
    expect(plan([pass('a > ok')], [], { ...ctx, runFailed: true })).toMatchObject([
      { kind: 'create', id: RUN_ID, title: 'Nightly: the run failed before its tests' },
    ]);
    expect(plan([pass('a > ok')], [{ number: 3, id: RUN_ID }], ctx)).toMatchObject([
      { kind: 'close', number: 3 },
    ]);
    // A failed run with failing tests: their issues say it, the run issue stays as it is.
    expect(
      plan([fail('a > no')], [{ number: 3, id: RUN_ID }], { ...ctx, runFailed: true }),
    ).toMatchObject([{ kind: 'create', id: 'a > no' }]);
  });

  it(`more than ${MAX_NEW} new failures get one issue listing them; known ones still get comments`, () => {
    const many = Array.from({ length: MAX_NEW + 1 }, (_, i) => fail(`t${i}`));
    const actions = plan([...many, fail('known')], [{ number: 5, id: 'known' }], ctx);
    expect(actions.map((a) => a.kind)).toEqual(['comment', 'create']);
    const create = actions[1];
    expect(create).toMatchObject({ id: MANY_ID, title: 'Nightly: many tests fail' });
    expect(create?.kind === 'create' && create.body).toContain('- `t10`');
    // It closes once nothing fails.
    expect(plan([pass('t0')], [{ number: 6, id: MANY_ID }], ctx)).toMatchObject([
      { kind: 'close', number: 6 },
    ]);
  });

  it('keeps titles within what GitHub allows', () => {
    expect(titleOf('x'.repeat(400)).length).toBeLessThanOrEqual(256);
  });
});
