import { describe, expect, it } from 'vitest';
import { emptyGraph, LIBRARY_INPUT_TYPE, libraryInputOf, type WorkflowGraph } from '../index.ts';

function withTrigger(type: string, settings: WorkflowGraph['nodes'][number]['settings']) {
  const g = emptyGraph('workflow');
  g.nodes.push({ id: 'in', type, typeVersion: 1, settings, position: { x: 0, y: 0 } });
  return g;
}

describe('libraryInputOf', () => {
  it('names the Library input node type', () => {
    expect(LIBRARY_INPUT_TYPE).toBe('core:input-library');
  });

  it('returns the node id and its library id', () => {
    expect(libraryInputOf(withTrigger(LIBRARY_INPUT_TYPE, { libraryId: 'lib1' }))).toEqual({
      nodeId: 'in',
      libraryId: 'lib1',
    });
  });

  it('answers an empty library id when it is unset or not a string', () => {
    expect(libraryInputOf(withTrigger(LIBRARY_INPUT_TYPE, {}))).toEqual({
      nodeId: 'in',
      libraryId: '',
    });
    expect(libraryInputOf(withTrigger(LIBRARY_INPUT_TYPE, { libraryId: 3 }))).toEqual({
      nodeId: 'in',
      libraryId: '',
    });
  });

  it('is null without a Library input', () => {
    expect(libraryInputOf(withTrigger('core:input-manual', {}))).toBeNull();
    expect(libraryInputOf(emptyGraph('workflow'))).toBeNull();
  });

  it('takes the first Library input in node order when there are several', () => {
    const g = withTrigger(LIBRARY_INPUT_TYPE, { libraryId: 'a' });
    g.nodes.push({
      id: 'in2',
      type: LIBRARY_INPUT_TYPE,
      typeVersion: 1,
      settings: { libraryId: 'b' },
      position: { x: 0, y: 0 },
    });
    expect(libraryInputOf(g)).toEqual({ nodeId: 'in', libraryId: 'a' });
  });
});
