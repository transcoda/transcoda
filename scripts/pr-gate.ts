// The `pr-gate` commit status on a pull request's head commit. Two rules:
// 1. A change to a high-risk path (RISKY below: CI, release and build tooling, dependencies, the
//    pinned plugin keys) needs the `risk-approved` label, added by a maintainer after the head
//    commit was pushed. Every push removes the label (pr-gate.yml), so an approved change cannot
//    be changed afterwards.
// 2. An external pull request (from a fork, or by anyone but OWNER) needs approving reviews on its
//    current head commit from both CodeRabbit and OWNER. A later push makes both stale. Renovate's
//    own pull requests (the renovate[bot] app, on a branch of this repository) need only OWNER's.
// Runs from main's copy only (pull_request_target, workflow_run, workflow_dispatch on main), reads
// the pull request through the API and never checks out or runs its code. Rules and setup:
// docs/dev/ci-release.md, "The pr-gate check".
// Exports the decision and its inputs for tests; the CLI runs only when executed directly.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const OWNER = 'jhadenfeldt';
export const LABEL = 'risk-approved';
export const CONTEXT = 'pr-gate';
export const CODERABBIT = 'coderabbitai[bot]';
export const RENOVATE = 'renovate[bot]';
const ACTIONS_BOT = 'github-actions[bot]';
const MAINTAINER_PERMISSIONS = ['admin', 'maintain', 'write'];

/** Paths whose change needs the label: what runs in CI or ships in a release beyond the app code. */
export const RISKY: RegExp[] = [
  /^\.github\//,
  /^scripts\//,
  /^docker\//,
  /(^|\/)Dockerfile[^/]*$/,
  /(^|\/)\.dockerignore$/,
  /^e2e\//,
  /(^|\/)package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /(^|\/)\.npmrc$/,
  /^\.node-version$/,
  /^renovate\.json$/,
  /^\.coderabbit\.ya?ml$/,
  /^apps\/server\/src\/platform\/official-plugins\.ts$/,
];

export interface PullFile {
  filename: string;
  previous_filename?: string;
}

/** The changed paths (a rename counts with both names) that match RISKY. */
export function riskyPaths(files: PullFile[]): string[] {
  const paths = files.flatMap((f) =>
    f.previous_filename ? [f.filename, f.previous_filename] : [f.filename],
  );
  return [...new Set(paths.filter((p) => RISKY.some((re) => re.test(p))))];
}

export interface Pull {
  number: number;
  state: string;
  user: { login: string; type: string } | null;
  head: { sha: string; repo: { full_name: string } | null };
  labels: { name: string }[];
  changed_files: number;
}

/**
 * Who opened the pull request. `owner`: OWNER, from a branch of this repository. `renovate`: the
 * Renovate app (login exactly RENOVATE and a Bot account), from a branch of this repository.
 * Anything else, a fork or a look-alike name included, is `external`.
 */
export type Author = 'owner' | 'renovate' | 'external';

export function authorOf(pr: Pull, repository: string): Author {
  if (pr.head.repo?.full_name !== repository) return 'external';
  if (pr.user?.login === OWNER && pr.user.type === 'User') return 'owner';
  if (pr.user?.login === RENOVATE && pr.user.type === 'Bot') return 'renovate';
  return 'external';
}

export interface IssueEvent {
  event: string;
  created_at: string;
  actor: { login: string; type: string } | null;
  label?: { name: string };
}

/** The last time the label was added, and by whom; null when the label is not on the pull request now. */
export function labelAdded(
  pr: Pull,
  events: IssueEvent[],
): { at: string; by: string; bot: boolean } | null {
  if (!pr.labels.some((l) => l.name === LABEL)) return null;
  const added = events
    .filter((e) => e.event === 'labeled' && e.label?.name === LABEL)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .at(-1);
  if (!added) return null;
  return { at: added.created_at, by: added.actor?.login ?? '', bot: added.actor?.type !== 'User' };
}

export interface Status {
  context: string;
  created_at: string;
  creator: { login: string } | null;
}

/**
 * When this workflow first saw the head commit: its earliest own `pr-gate` status there. A push
 * runs the gate, so this is just after the push. Only this workflow's token can write it.
 */
export function headSeenAt(statuses: Status[]): string | null {
  const ours = statuses
    .filter((s) => s.context === CONTEXT && s.creator?.login === ACTIONS_BOT)
    .map((s) => s.created_at)
    .sort();
  return ours[0] ?? null;
}

export interface Review {
  user: { login: string } | null;
  state: string;
  commit_id: string | null;
  submitted_at?: string | null;
}

/** Whether `login`'s latest approve, request-changes or dismissal on the head commit is an approval. */
export function approvedOnHead(reviews: Review[], headSha: string, login: string): boolean {
  const verdicts = reviews
    .filter(
      (r) =>
        r.user?.login === login &&
        r.commit_id === headSha &&
        ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state),
    )
    .sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''));
  return verdicts.at(-1)?.state === 'APPROVED';
}

export interface Facts {
  /** High-risk paths the pull request changes. */
  risky: string[];
  /** The file list was cut short (GitHub lists at most 3000), so assume a risky path. */
  truncated: boolean;
  /** The label as it is now, with whether its adder is a maintainer; null when it is not on. */
  label: { at: string; by: string; maintainer: boolean } | null;
  /** When the gate first saw the head commit; now when it never has. */
  headSeenAt: string;
  author: Author;
  /** Approving reviews on the head commit. */
  coderabbitApproved: boolean;
  ownerApproved: boolean;
}

export interface Verdict {
  state: 'success' | 'failure';
  description: string;
}

export function decide(f: Facts): Verdict {
  const problems: string[] = [];
  if (f.risky.length > 0 || f.truncated) {
    const what = f.truncated
      ? 'too many files to check'
      : `changes ${f.risky[0]}${f.risky.length > 1 ? ` and ${f.risky.length - 1} more` : ''}`;
    if (!f.label) problems.push(`${what}: needs the ${LABEL} label`);
    else if (!f.label.maintainer)
      problems.push(`${LABEL} was added by ${f.label.by}, not a maintainer`);
    else if (Date.parse(f.label.at) <= Date.parse(f.headSeenAt))
      problems.push(`${LABEL} predates the last push: add it again`);
  }
  if (f.author === 'external') {
    const missing = [f.coderabbitApproved ? '' : 'CodeRabbit', f.ownerApproved ? '' : OWNER].filter(
      Boolean,
    );
    if (missing.length > 0)
      problems.push(`external: needs ${missing.join(' and ')} to approve the head commit`);
  }
  if (f.author === 'renovate' && !f.ownerApproved) {
    problems.push(`Renovate: needs ${OWNER} to approve the head commit`);
  }
  if (problems.length === 0) {
    const notes = [
      f.risky.length > 0 || f.truncated ? `${LABEL} by ${f.label?.by}` : 'no high-risk paths',
    ];
    if (f.author === 'external') notes.push(`CodeRabbit and ${OWNER} approved`);
    if (f.author === 'renovate') notes.push(`${OWNER} approved`);
    return { state: 'success', description: notes.join('; ') };
  }
  const text = problems.join('; ');
  return { state: 'failure', description: text.length > 140 ? `${text.slice(0, 139)}…` : text };
}

// ---- The API and the CLI ----

type Api = (path: string, init?: { method?: string; body?: unknown }) => Promise<Response>;

function api(token: string): Api {
  return (path, init = {}) => {
    // The token only ever goes to the API: a next-page link must point there too.
    const url = path.startsWith('/') ? `https://api.github.com${path}` : path;
    if (!url.startsWith('https://api.github.com/')) throw new Error(`refusing to call ${url}`);
    return fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'transcoda-pr-gate',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  };
}

async function json<T>(call: Api, path: string): Promise<T> {
  const res = await call(path);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function all<T>(call: Api, path: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  while (next) {
    const res = await call(next);
    if (!res.ok) throw new Error(`GET ${next}: ${res.status} ${await res.text()}`);
    out.push(...((await res.json()) as T[]));
    next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
  }
  return out;
}

async function maintainer(call: Api, repo: string, login: string): Promise<boolean> {
  const res = await call(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
  if (!res.ok) return false;
  const body = (await res.json()) as { permission?: string };
  return MAINTAINER_PERMISSIONS.includes(body.permission ?? '');
}

/** Evaluates one pull request and posts the status on its head commit. */
async function gate(call: Api, repo: string, number: number, removeLabel: boolean): Promise<void> {
  if (removeLabel) {
    const res = await call(`/repos/${repo}/issues/${number}/labels/${LABEL}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404)
      throw new Error(`removing ${LABEL}: ${res.status} ${await res.text()}`);
    if (res.ok) console.log(`#${number}: removed ${LABEL} after a push`);
  }
  const pr = await json<Pull>(call, `/repos/${repo}/pulls/${number}`);
  if (pr.state !== 'open') {
    console.log(`#${number} is ${pr.state}; nothing to do`);
    return;
  }
  const sha = pr.head.sha;
  const [files, events, reviews, statuses] = await Promise.all([
    all<PullFile>(call, `/repos/${repo}/pulls/${number}/files`),
    all<IssueEvent>(call, `/repos/${repo}/issues/${number}/events`),
    all<Review>(call, `/repos/${repo}/pulls/${number}/reviews`),
    all<Status>(call, `/repos/${repo}/commits/${sha}/statuses`),
  ]);
  const added = labelAdded(pr, events);
  const facts: Facts = {
    risky: riskyPaths(files),
    truncated: files.length < pr.changed_files,
    label: added && {
      at: added.at,
      by: added.by,
      maintainer: !added.bot && (await maintainer(call, repo, added.by)),
    },
    headSeenAt: headSeenAt(statuses) ?? new Date().toISOString(),
    author: authorOf(pr, repo),
    coderabbitApproved: approvedOnHead(reviews, sha, CODERABBIT),
    ownerApproved: approvedOnHead(reviews, sha, OWNER),
  };
  const verdict = decide(facts);
  console.log(`#${number} at ${sha}: ${verdict.state}: ${verdict.description}`);
  console.log(JSON.stringify(facts));
  const res = await call(`/repos/${repo}/statuses/${sha}`, {
    method: 'POST',
    body: { state: verdict.state, context: CONTEXT, description: verdict.description },
  });
  if (!res.ok) throw new Error(`posting the status: ${res.status} ${await res.text()}`);
}

/**
 * Which pull requests to evaluate, from the event. The payload is only a hint: a number must be a
 * positive integer, a commit 40 hex digits, and the pull request itself is always read from the API.
 */
export function targets(
  eventName: string,
  payload: Record<string, unknown>,
  input: string | undefined,
): { numbers?: number[]; headSha?: string; removeLabel: boolean } {
  const num = (v: unknown) => {
    const n = typeof v === 'string' && /^[1-9]\d{0,9}$/.test(v) ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1)
      throw new Error('no valid pull request number');
    return n;
  };
  if (eventName === 'pull_request_target') {
    const pr = payload.pull_request as { number?: unknown } | undefined;
    const action = payload.action;
    const changes = payload.changes as { base?: unknown } | undefined;
    const pushed = action === 'synchronize' || (action === 'edited' && changes?.base !== undefined);
    return { numbers: [num(pr?.number)], removeLabel: pushed };
  }
  if (eventName === 'workflow_run') {
    const run = payload.workflow_run as { head_sha?: unknown } | undefined;
    const sha = run?.head_sha;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha))
      throw new Error('no valid head commit');
    return { headSha: sha, removeLabel: false };
  }
  if (eventName === 'workflow_dispatch') return { numbers: [num(input)], removeLabel: false };
  throw new Error(`unexpected event ${eventName}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, PR_NUMBER } =
    process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_EVENT_NAME || !GITHUB_EVENT_PATH) {
    throw new Error(
      'run in GitHub Actions: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_NAME and GITHUB_EVENT_PATH',
    );
  }
  const call = api(GITHUB_TOKEN);
  const payload = JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf8')) as Record<string, unknown>;
  const t = targets(GITHUB_EVENT_NAME, payload, PR_NUMBER);
  let numbers = t.numbers ?? [];
  if (t.headSha) {
    // A review changed: every open pull request whose head is that commit, as the API lists them.
    const open = await all<Pull>(call, `/repos/${GITHUB_REPOSITORY}/pulls?state=open`);
    numbers = open.filter((p) => p.head.sha === t.headSha).map((p) => p.number);
    if (numbers.length === 0) console.log(`no open pull request has head ${t.headSha}`);
  }
  for (const n of numbers) await gate(call, GITHUB_REPOSITORY, n, t.removeLabel);
}
