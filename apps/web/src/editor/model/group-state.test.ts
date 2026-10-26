import { describe, expect, it } from 'vitest';
import { groupProblem } from './group-state.ts';
import type { NodeState } from './issues.ts';

const state = (look: Partial<NodeState> = {}): NodeState => ({
  badge: null,
  word: null,
  border: null,
  dim: null,
  issues: [],
  fieldIssues: new Map(),
  ...look,
});

const pluginMissing = state({ badge: 'plugin-missing', word: 'plugin missing', border: 'red' });
const needsSetting = state({ badge: 'needs-setting', word: 'needs a setting', border: 'amber' });
const unavailable = state({
  badge: 'unavailable',
  word: 'not on this server',
  border: 'dashed',
  dim: 0.6,
});

describe('groupProblem', () => {
  it('is null when no member has a state word', () => {
    expect(groupProblem([])).toBeNull();
    expect(groupProblem([state(), state({ dim: 0.7 }), state({ badge: 'outdated-pin' })])).toBe(
      null,
    );
  });

  it('one member: its border, badge and word', () => {
    expect(groupProblem([state(), pluginMissing])).toEqual({
      border: 'red',
      badge: 'plugin-missing',
      count: 1,
      word: 'plugin missing',
    });
  });

  it('several: the worst border and its badge, and a count word', () => {
    expect(groupProblem([needsSetting, pluginMissing])).toEqual({
      border: 'red',
      badge: 'plugin-missing',
      count: 2,
      word: '2 nodes need attention',
    });
    expect(groupProblem([unavailable, needsSetting])).toMatchObject({
      border: 'amber',
      badge: 'needs-setting',
    });
  });

  it('not on this server: dashed with the lock badge', () => {
    expect(groupProblem([unavailable])).toEqual({
      border: 'dashed',
      badge: 'unavailable',
      count: 1,
      word: 'not on this server',
    });
  });

  it('a word without a badge kind reads as a red generic error', () => {
    expect(groupProblem([state({ word: 'update pending', border: 'red' })])).toEqual({
      border: 'red',
      badge: 'generic-error',
      count: 1,
      word: 'update pending',
    });
  });
});
