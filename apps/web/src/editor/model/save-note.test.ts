import { describe, expect, it } from 'vitest';
import { chainMainReplace } from '../../test/fixtures/graphs.ts';
import { LAYOUT_ONLY_NOTE, saveNoteFor } from './save-note.ts';

const moved = () => {
  const g = chainMainReplace();
  const [first, ...rest] = g.nodes;
  if (!first) throw new Error('fixture has nodes');
  return { ...g, nodes: [{ ...first, position: { x: first.position.x + 40, y: 0 } }, ...rest] };
};

describe('saveNoteFor', () => {
  it('a user note wins (trimmed); blank counts as none', () => {
    expect(saveNoteFor(chainMainReplace(), moved(), '  Tidy up ')).toBe('Tidy up');
    expect(saveNoteFor(chainMainReplace(), moved(), '   ')).toBe(LAYOUT_ONLY_NOTE);
  });

  it('"Layout only" when only positions changed; nothing for a behaviour change', () => {
    expect(saveNoteFor(chainMainReplace(), moved(), undefined)).toBe('Layout only');
    const g = chainMainReplace();
    const changed = { ...g, nodes: g.nodes.slice(1) };
    expect(saveNoteFor(g, changed, undefined)).toBeUndefined();
  });
});
