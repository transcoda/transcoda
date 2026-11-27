// Turns the nightly run's test reports into GitHub issues: one per failing test, labelled `nightly`.
// A test that already has an open issue gets a comment instead of a second issue; a test that passes
// again gets its issue closed. A run that failed before any report said why (install, build) gets
// one "the nightly run failed" issue. Used by .github/workflows/nightly.yml, and by
// transcoda-plugins' nightly from its checkout of this repo:
//   node scripts/nightly-issues.ts <report.json>...
// Each report is vitest's or Playwright's JSON report (told apart by their shape).
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/name), RUN_URL, SHA, RUN_FAILED ("true" when a step
// failed), TEST_ROOT (where the tests ran, to make vitest's paths relative; default: here).
// A missing report counts as "nothing ran there": none of its issues are closed, and the run counts
// as failed. DRY_RUN=true prints what it would do and writes nothing.
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';

export const LABEL = 'nightly';
/** The id of the "the run failed before its tests" issue. */
export const RUN_ID = 'the nightly run';
/** The id of the one issue that stands in for more than {@link MAX_NEW} new failing tests. */
export const MANY_ID = 'many tests';
/** More new failures than this at once (a broken build, a changed page) get one issue, not one each. */
export const MAX_NEW = 10;
const MARKER = /<!-- nightly-test: (.+?) -->/;
const MAX_ERROR = 3000;

export interface TestResult {
  /** `apps/web/src/x.test.ts > describe > test`, or `e2e/x.e2e.ts > [project] > test`. */
  id: string;
  passed: boolean;
  /** The failure's message, colour codes removed; empty for a pass. */
  error: string;
}

export interface OpenIssue {
  number: number;
  /** The test id from the issue body's marker. */
  id: string;
}

export type Action =
  | { kind: 'create'; id: string; title: string; body: string }
  | { kind: 'comment'; number: number; body: string }
  | { kind: 'close'; number: number; body: string };

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes start with ESC.
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

const clip = (s: string) =>
  s.length > MAX_ERROR ? `${s.slice(0, MAX_ERROR)}\n… (cut; the full output is in the run)` : s;

interface VitestReport {
  testResults: {
    name: string;
    status: string;
    message?: string;
    assertionResults: {
      fullName: string;
      ancestorTitles?: string[];
      title?: string;
      status: string;
      failureMessages?: string[];
    }[];
  }[];
}

/** The vitest JSON reporter's results; a file that failed to load is one failing "test". */
export function parseVitest(report: VitestReport, root: string): TestResult[] {
  const out: TestResult[] = [];
  for (const file of report.testResults) {
    const path = relative(root, file.name);
    for (const t of file.assertionResults) {
      if (t.status !== 'passed' && t.status !== 'failed') continue;
      out.push({
        id: [path, ...(t.title ? [...(t.ancestorTitles ?? []), t.title] : [t.fullName])].join(
          ' > ',
        ),
        passed: t.status === 'passed',
        error: stripAnsi((t.failureMessages ?? []).join('\n')),
      });
    }
    if (file.status === 'failed' && !file.assertionResults.some((t) => t.status === 'failed')) {
      out.push({ id: `${path} (the file)`, passed: false, error: stripAnsi(file.message ?? '') });
    }
  }
  return out;
}

interface PwSuite {
  title: string;
  file?: string;
  specs?: {
    title: string;
    file: string;
    tests: {
      projectName: string;
      status: 'expected' | 'unexpected' | 'flaky' | 'skipped';
      results: { error?: { message?: string } }[];
    }[];
  }[];
  suites?: PwSuite[];
}

/** Playwright's JSON reporter: each test in each project; a flaky one (passed on retry) passes. */
export function parsePlaywright(report: { suites?: PwSuite[] }): TestResult[] {
  const out: TestResult[] = [];
  const walk = (suite: PwSuite, titles: string[]) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        if (t.status === 'skipped') continue;
        const path = [...titles, spec.title].join(' > ');
        const last = t.results.at(-1)?.error?.message ?? '';
        out.push({
          id: `e2e/${spec.file} > [${t.projectName}] > ${path}`,
          passed: t.status !== 'unexpected',
          error: stripAnsi(last),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  // The top suites are the files; their titles are already in each spec's `file`.
  for (const file of report.suites ?? []) walk(file, []);
  return out;
}

/** The issue title for a test id (GitHub allows 256 characters). */
export function titleOf(id: string): string {
  const named: Record<string, string> = {
    [RUN_ID]: 'Nightly: the run failed outside its tests',
    [MANY_ID]: 'Nightly: many tests fail',
  };
  const title = named[id] ?? `Nightly: ${id}`;
  return title.length > 250 ? `${title.slice(0, 249)}…` : title;
}

/**
 * What to do with GitHub: create an issue for a failing test without one, comment on one that has
 * one, close the open issue of a test that passed. `runFailed` without a failing test means the run
 * broke before its tests (or a report is missing): that gets the run issue. A passing run closes it.
 */
export function plan(
  results: TestResult[],
  open: OpenIssue[],
  ctx: { runFailed: boolean; runUrl: string; sha: string },
): Action[] {
  const actions: Action[] = [];
  const byId = new Map(open.map((i) => [i.id, i.number]));
  const failing = results.filter((r) => !r.passed);
  const where = `[run](${ctx.runUrl}), commit ${ctx.sha.slice(0, 7)}`;
  const fail = (id: string, error: string) => {
    const number = byId.get(id);
    const output = error ? `\n\n\`\`\`\n${clip(error)}\n\`\`\`` : '';
    if (number !== undefined) {
      actions.push({
        kind: 'comment',
        number,
        body: `Still failing in the nightly ${where}.${output}`,
      });
      return;
    }
    const whats: Record<string, string> = {
      [RUN_ID]:
        'The nightly run failed in a step that is not a test (install, build, fixtures or a check script): its log says which.',
      [MANY_ID]:
        'The nightly run found more failing tests than it opens issues for: look for one cause first (the build, a shared helper, a page every screenshot shows).',
    };
    const what = whats[id] ?? `The nightly run found this test failing:\n\n\`${id}\``;
    actions.push({
      kind: 'create',
      id,
      title: titleOf(id),
      body: `${what}\n\nFirst seen in the ${where}.${output}\n\nThe nightly closes this issue once it passes again.\n\n<!-- nightly-test: ${id} -->`,
    });
  };
  const fresh = failing.filter((r) => !byId.has(r.id));
  if (fresh.length > MAX_NEW) {
    for (const r of failing) if (byId.has(r.id)) fail(r.id, r.error);
    const list = fresh.map((r) => `- \`${r.id}\``).join('\n');
    fail(MANY_ID, `${fresh.length} tests without an issue fail:\n${list}`);
  } else {
    for (const r of failing) fail(r.id, r.error);
  }
  if (ctx.runFailed && failing.length === 0) fail(RUN_ID, '');

  const passed = new Set(results.filter((r) => r.passed).map((r) => r.id));
  if (!ctx.runFailed) passed.add(RUN_ID);
  if (failing.length === 0 && !ctx.runFailed) passed.add(MANY_ID);
  for (const issue of open) {
    if (passed.has(issue.id)) {
      actions.push({
        kind: 'close',
        number: issue.number,
        body: `Passes again in the nightly ${where}.`,
      });
    }
  }
  return actions;
}

/** The test id an issue body was opened for; null for an issue without the marker. */
export function idOf(body: string | null): string | null {
  return MARKER.exec(body ?? '')?.[1] ?? null;
}

async function github(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function openIssues(): Promise<OpenIssue[]> {
  const out: OpenIssue[] = [];
  for (let page = 1; ; page++) {
    const batch = (await github(
      `/issues?state=open&labels=${LABEL}&per_page=100&page=${page}`,
    )) as { number: number; body: string | null; pull_request?: unknown }[];
    for (const i of batch) {
      const id = i.pull_request ? null : idOf(i.body);
      if (id !== null) out.push({ number: i.number, id });
    }
    if (batch.length < 100) return out;
  }
}

/**
 * The results of every report: vitest's (it has `testResults`) or Playwright's (`suites`). A
 * report that is missing (null) or neither marks the run as failed.
 */
export function readReports(
  reports: unknown[],
  root: string,
): { results: TestResult[]; missing: boolean } {
  const results: TestResult[] = [];
  let missing = false;
  for (const r of reports) {
    if (r && typeof r === 'object' && 'testResults' in r) {
      results.push(...parseVitest(r as VitestReport, root));
    } else if (r && typeof r === 'object' && 'suites' in r) {
      results.push(...parsePlaywright(r as { suites?: PwSuite[] }));
    } else {
      missing = true;
    }
  }
  return { results, missing };
}

function readJson(path: string): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

async function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) throw new Error('usage: nightly-issues.ts <report.json>...');
  const { results, missing } = readReports(
    paths.map(readJson),
    process.env.TEST_ROOT ?? process.cwd(),
  );
  const runFailed = process.env.RUN_FAILED === 'true' || missing;
  const actions = plan(results, await openIssues(), {
    runFailed,
    runUrl: process.env.RUN_URL ?? '',
    sha: process.env.SHA ?? '',
  });
  console.log(`${results.length} tests, ${results.filter((r) => !r.passed).length} failing`);
  if (process.env.DRY_RUN === 'true') {
    for (const a of actions) {
      console.log(a.kind === 'create' ? `would open: ${a.title}` : `would ${a.kind} #${a.number}`);
    }
    return;
  }
  for (const a of actions) {
    if (a.kind === 'create') {
      const issue = (await github('/issues', {
        method: 'POST',
        body: { title: a.title, body: a.body, labels: [LABEL] },
      })) as { number: number };
      console.log(`opened #${issue.number}: ${a.title}`);
    } else {
      await github(`/issues/${a.number}/comments`, { method: 'POST', body: { body: a.body } });
      if (a.kind === 'close') {
        await github(`/issues/${a.number}`, {
          method: 'PATCH',
          body: { state: 'closed', state_reason: 'completed' },
        });
      }
      console.log(`${a.kind === 'close' ? 'closed' : 'commented on'} #${a.number}`);
    }
  }
}

if (import.meta.main) await main();
