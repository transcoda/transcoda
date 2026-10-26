import type { WorkflowSummary } from '@transcoda/contract';
import type { WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { oneTrigger } from '../../test/fixtures/graphs.ts';
import { libraryShift } from './library-shift.ts';

const libraries = [
  { id: 'l1', name: 'Shows' },
  { id: 'l2', name: 'Movies' },
];

const workflow: WorkflowSummary = {
  id: 'wf1',
  name: 'Downsize',
  kind: 'workflow',
  active: {
    version: 3,
    runnable: true,
    activatedAt: '2026-10-21T08:00:00.000Z',
    activatedBy: 'u1',
  },
  currentVersion: 4,
  valid: true,
  errorCount: 0,
  usesOutdatedSubworkflow: false,
  feedsLibrary: { id: 'l1', name: 'Shows' },
  libraryInput: { id: 'l1', name: 'Shows' },
  usedBy: [],
  createdAt: '2026-10-21T08:00:00.000Z',
  updatedAt: '2026-10-21T08:00:00.000Z',
};

const onLibrary = (libraryId: string): WorkflowGraph => ({
  formatVersion: 1,
  kind: 'workflow',
  nodes: [
    {
      id: 'in',
      type: 'core:input-library',
      typeVersion: 1,
      settings: { libraryId },
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
  groups: [],
});

describe('libraryShift', () => {
  it('active on Shows, draft naming Movies: from Shows to Movies with the active version', () => {
    expect(libraryShift(workflow, onLibrary('l2'), libraries)).toEqual({
      activeVersion: 3,
      from: 'Shows',
      to: 'Movies',
    });
  });

  it('a draft still naming Shows: null', () => {
    expect(libraryShift(workflow, onLibrary('l1'), libraries)).toBeNull();
  });

  it('not feeding a library (nothing active): null', () => {
    expect(
      libraryShift({ ...workflow, active: null, feedsLibrary: null }, onLibrary('l2'), libraries),
    ).toBeNull();
  });

  it('a draft with a Manual input, or naming an unknown library: to is null', () => {
    expect(libraryShift(workflow, oneTrigger(), libraries)).toEqual({
      activeVersion: 3,
      from: 'Shows',
      to: null,
    });
    expect(libraryShift(workflow, onLibrary('gone'), libraries)?.to).toBeNull();
  });

  it('a draft naming a library while the libraries are still loading: null (no banner yet)', () => {
    expect(libraryShift(workflow, onLibrary('l2'), null)).toBeNull();
    // a draft without a Library input needs no names: the shift shows at once
    expect(libraryShift(workflow, oneTrigger(), null)).toEqual({
      activeVersion: 3,
      from: 'Shows',
      to: null,
    });
  });
});
