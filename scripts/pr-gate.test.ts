import { describe, expect, it } from 'vitest';
import {
  approvedOnHead,
  CODERABBIT,
  decide,
  type Facts,
  headSeenAt,
  type IssueEvent,
  isExternal,
  LABEL,
  labelAdded,
  OWNER,
  type Pull,
  type Review,
  riskyPaths,
  targets,
} from './pr-gate.ts';

const REPO = 'transcoda/transcoda';
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const PUSHED = '2026-11-28T10:00:00Z';
const BEFORE = '2026-11-28T09:59:59Z';
const AFTER = '2026-11-28T10:05:00Z';

const facts = (over: Partial<Facts> = {}): Facts => ({
  risky: [],
  truncated: false,
  label: null,
  headSeenAt: PUSHED,
  external: false,
  coderabbitApproved: false,
  ownerApproved: false,
  ...over,
});
const label = (at = AFTER, maintainer = true) => ({ at, by: OWNER, maintainer });
const review = (login: string, state: string, commit = HEAD, at = AFTER): Review => ({
  user: { login },
  state,
  commit_id: commit,
  submitted_at: at,
});
const approvals = (reviews: Review[]) => ({
  coderabbitApproved: approvedOnHead(reviews, HEAD, CODERABBIT),
  ownerApproved: approvedOnHead(reviews, HEAD, OWNER),
});

describe('decide', () => {
  it('passes our own pull request with no high-risk paths', () => {
    expect(decide(facts())).toEqual({ state: 'success', description: 'no high-risk paths' });
  });

  it('fails a high-risk path without the label', () => {
    const v = decide(facts({ risky: ['.github/workflows/ci.yml'] }));
    expect(v.state).toBe('failure');
    expect(v.description).toBe(`changes .github/workflows/ci.yml: needs the ${LABEL} label`);
  });

  it('passes a high-risk path with the label added after the last push', () => {
    expect(decide(facts({ risky: ['pnpm-lock.yaml'], label: label() }))).toEqual({
      state: 'success',
      description: `${LABEL} by ${OWNER}`,
    });
  });

  it('fails when the label predates the last push', () => {
    const v = decide(facts({ risky: ['pnpm-lock.yaml'], label: label(BEFORE) }));
    expect(v).toEqual({
      state: 'failure',
      description: `${LABEL} predates the last push: add it again`,
    });
  });

  it('fails a label added by someone who is not a maintainer', () => {
    expect(decide(facts({ risky: ['scripts/x.ts'], label: label(AFTER, false) })).state).toBe(
      'failure',
    );
  });

  it('treats a cut-short file list as high-risk', () => {
    expect(decide(facts({ truncated: true })).description).toMatch(
      /too many files to check: needs the/,
    );
  });

  it('fails an external pull request with only CodeRabbit approving', () => {
    const v = decide(facts({ external: true, ...approvals([review(CODERABBIT, 'APPROVED')]) }));
    expect(v).toEqual({
      state: 'failure',
      description: `external: needs ${OWNER} to approve the head commit`,
    });
  });

  it('fails an external pull request with only the owner approving', () => {
    const v = decide(facts({ external: true, ...approvals([review(OWNER, 'APPROVED')]) }));
    expect(v).toEqual({
      state: 'failure',
      description: 'external: needs CodeRabbit to approve the head commit',
    });
  });

  it('fails an external pull request with no approval', () => {
    expect(decide(facts({ external: true })).description).toBe(
      `external: needs CodeRabbit and ${OWNER} to approve the head commit`,
    );
  });

  it('passes an external pull request both approved on the head commit', () => {
    const both = approvals([review(CODERABBIT, 'APPROVED'), review(OWNER, 'APPROVED')]);
    expect(decide(facts({ external: true, ...both }))).toEqual({
      state: 'success',
      description: `no high-risk paths; CodeRabbit and ${OWNER} approved`,
    });
  });

  it('fails an external pull request both approved on an older commit', () => {
    const old = approvals([review(CODERABBIT, 'APPROVED', OLD), review(OWNER, 'APPROVED', OLD)]);
    expect(old).toEqual({ coderabbitApproved: false, ownerApproved: false });
    expect(decide(facts({ external: true, ...old })).state).toBe('failure');
  });

  it('an external pull request on a high-risk path needs the label too', () => {
    const both = approvals([review(CODERABBIT, 'APPROVED'), review(OWNER, 'APPROVED')]);
    expect(decide(facts({ external: true, risky: ['docker/Dockerfile'], ...both })).state).toBe(
      'failure',
    );
    expect(
      decide(facts({ external: true, risky: ['docker/Dockerfile'], label: label(), ...both }))
        .state,
    ).toBe('success');
  });

  it('reports both rules when both fail, within 140 characters', () => {
    const v = decide(facts({ external: true, risky: ['.github/CODEOWNERS', 'renovate.json'] }));
    expect(v.description).toBe(
      `changes .github/CODEOWNERS and 1 more: needs the ${LABEL} label; external: needs CodeRabbit and ${OWNER} to approve the head commit`,
    );
    expect(v.description.length).toBeLessThanOrEqual(140);
  });
});

describe('approvedOnHead', () => {
  it('takes the latest verdict on the head commit, ignoring comments', () => {
    expect(
      approvedOnHead(
        [
          review(CODERABBIT, 'APPROVED', HEAD, BEFORE),
          review(CODERABBIT, 'COMMENTED', HEAD, AFTER),
        ],
        HEAD,
        CODERABBIT,
      ),
    ).toBe(true);
    expect(
      approvedOnHead(
        [
          review(CODERABBIT, 'APPROVED', HEAD, BEFORE),
          review(CODERABBIT, 'CHANGES_REQUESTED', HEAD, AFTER),
        ],
        HEAD,
        CODERABBIT,
      ),
    ).toBe(false);
    expect(approvedOnHead([review(CODERABBIT, 'DISMISSED')], HEAD, CODERABBIT)).toBe(false);
  });

  it('ignores another account approving', () => {
    expect(approvedOnHead([review('someone', 'APPROVED')], HEAD, CODERABBIT)).toBe(false);
  });
});

describe('riskyPaths', () => {
  it('finds high-risk paths, renames by either name', () => {
    expect(
      riskyPaths([
        { filename: 'apps/server/src/engine/x.ts' },
        { filename: 'apps/web/package.json' },
        { filename: 'e2e/Dockerfile' },
        { filename: 'docs/x.md', previous_filename: 'scripts/x.md' },
        { filename: 'apps/server/src/platform/official-plugins.ts' },
        { filename: '.coderabbit.yaml' },
        { filename: '.npmrc' },
      ]),
    ).toEqual([
      'apps/web/package.json',
      'e2e/Dockerfile',
      'scripts/x.md',
      'apps/server/src/platform/official-plugins.ts',
      '.coderabbit.yaml',
      '.npmrc',
    ]);
  });

  it('leaves app code, docs and tests alone', () => {
    expect(
      riskyPaths([
        { filename: 'apps/web/src/App.tsx' },
        { filename: 'docs/dev/ci-release.md' },
        { filename: 'README.md' },
      ]),
    ).toEqual([]);
  });
});

describe('isExternal', () => {
  const pr = (login: string, headRepo: string | null): Pull => ({
    number: 1,
    state: 'open',
    user: { login },
    head: { sha: HEAD, repo: headRepo === null ? null : { full_name: headRepo } },
    labels: [],
    changed_files: 1,
  });

  it('our own branch is internal; a fork, a deleted fork or another author is external', () => {
    expect(isExternal(pr(OWNER, REPO), REPO)).toBe(false);
    expect(isExternal(pr(OWNER, 'someone/transcoda'), REPO)).toBe(true);
    expect(isExternal(pr(OWNER, null), REPO)).toBe(true);
    expect(isExternal(pr('someone', REPO), REPO)).toBe(true);
  });
});

describe('labelAdded and headSeenAt', () => {
  const withLabel: Pull = {
    number: 1,
    state: 'open',
    user: { login: OWNER },
    head: { sha: HEAD, repo: { full_name: REPO } },
    labels: [{ name: LABEL }],
    changed_files: 1,
  };
  const labeled = (at: string, login = OWNER, type = 'User'): IssueEvent => ({
    event: 'labeled',
    created_at: at,
    actor: { login, type },
    label: { name: LABEL },
  });

  it('takes the last time the label was added, only while it is on', () => {
    expect(labelAdded(withLabel, [labeled(BEFORE), labeled(AFTER)])).toEqual({
      at: AFTER,
      by: OWNER,
      bot: false,
    });
    expect(labelAdded({ ...withLabel, labels: [] }, [labeled(AFTER)])).toBeNull();
    expect(labelAdded(withLabel, [labeled(AFTER, 'some-app[bot]', 'Bot')])?.bot).toBe(true);
  });

  it('takes the earliest pr-gate status the workflow posted on the head commit', () => {
    const status = (at: string, login = 'github-actions[bot]', context = 'pr-gate') => ({
      context,
      created_at: at,
      creator: { login },
    });
    expect(
      headSeenAt([
        status(AFTER),
        status(PUSHED),
        status(BEFORE, 'someone'),
        status(BEFORE, undefined, 'x'),
      ]),
    ).toBe(PUSHED);
    expect(headSeenAt([])).toBeNull();
  });
});

describe('targets', () => {
  it('takes the number from a pull_request_target event and removes the label after a push', () => {
    expect(
      targets(
        'pull_request_target',
        { action: 'synchronize', pull_request: { number: 7 } },
        undefined,
      ),
    ).toEqual({
      numbers: [7],
      removeLabel: true,
    });
    expect(
      targets('pull_request_target', { action: 'labeled', pull_request: { number: 7 } }, undefined),
    ).toEqual({
      numbers: [7],
      removeLabel: false,
    });
    expect(
      targets(
        'pull_request_target',
        { action: 'edited', changes: { base: {} }, pull_request: { number: 7 } },
        undefined,
      ).removeLabel,
    ).toBe(true);
  });

  it('takes only a well-formed commit from a workflow_run event', () => {
    expect(targets('workflow_run', { workflow_run: { head_sha: HEAD } }, undefined)).toEqual({
      headSha: HEAD,
      removeLabel: false,
    });
    expect(() =>
      targets('workflow_run', { workflow_run: { head_sha: 'main; rm -rf /' } }, undefined),
    ).toThrow();
  });

  it('takes only a positive integer by hand', () => {
    expect(targets('workflow_dispatch', {}, '12')).toEqual({ numbers: [12], removeLabel: false });
    for (const bad of ['0', '-1', '1.5', '12 && x', '']) {
      expect(() => targets('workflow_dispatch', {}, bad), bad).toThrow();
    }
    expect(() => targets('push', {}, undefined)).toThrow();
  });
});
