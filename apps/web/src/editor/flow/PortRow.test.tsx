import { cleanup, screen } from '@testing-library/react';
import type { NodeInstance } from '@transcoda/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogFixture } from '../../test/fixtures/catalog.ts';
import { renderFlow } from '../../test/flow.tsx';
import { nodeStateFor } from '../model/issues.ts';
import { edgeTypes, nodeTypes } from './nodeTypes.ts';
import type { TcNode } from './types.ts';

afterEach(cleanup);

function tcNode(id: string, type: string, typeVersion = 1, x = 0): TcNode {
  const instance: NodeInstance = {
    id,
    type,
    typeVersion,
    settings: {},
    position: { x, y: 0 },
  };
  return {
    id,
    type: 'tc-node',
    position: { x, y: 0 },
    initialWidth: 210,
    initialHeight: 120,
    data: {
      instance,
      def: catalogFixture.byType.get(type) ?? null,
      state: nodeStateFor(id, [], type),
      graphKind: 'workflow',
    },
  };
}

const card = (id: string) => screen.getByTestId(`tc-node-${id}`);
const outLabel = (id: string, word: string) =>
  [...card(id).querySelectorAll('.tc-port-out')].find((el) => el.firstChild?.textContent === word);
const handle = (id: string, port: string) => card(id).querySelector(`[data-handleid="${port}"]`);

describe('branch rows (N2)', () => {
  it('marks the Yes row as the pass branch and the No row as the else branch, label and handle', async () => {
    await renderFlow([tcNode('sg', 'core:size-gate', 2)], [], { nodeTypes, edgeTypes });

    // The words stay the meaning; the classes only add colour.
    const yes = outLabel('sg', 'Yes');
    const no = outLabel('sg', 'No');
    expect(yes?.classList.contains('is-branch-pass')).toBe(true);
    expect(yes?.classList.contains('is-branch-else')).toBe(false);
    expect(no?.classList.contains('is-branch-else')).toBe(true);
    expect(no?.classList.contains('is-branch-pass')).toBe(false);

    // The stored ids stay pass and else.
    expect(handle('sg', 'pass')?.classList.contains('is-branch-pass')).toBe(true);
    expect(handle('sg', 'pass')?.classList.contains('tc-handle-file-out')).toBe(true);
    expect(handle('sg', 'else')?.classList.contains('is-branch-else')).toBe(true);
    expect(handle('sg', 'else')?.classList.contains('tc-handle-file-out')).toBe(true);
    expect(handle('sg', 'pass')?.getAttribute('title')).toBe('Yes, file out');
    expect(handle('sg', 'else')?.getAttribute('title')).toBe('No, file out');
    // Each branch row names the type it passes: "Yes · file" (dot from CSS), "Yes, file" read.
    expect(yes?.textContent).toBe('Yes, file');
    expect(no?.textContent).toBe('No, file');
  });

  it('leaves an ordinary file output and every input without a branch class', async () => {
    await renderFlow(
      [tcNode('kl', 'core:keep-languages'), tcNode('sg', 'core:size-gate', 2, 400)],
      [],
      { nodeTypes, edgeTypes },
    );

    const fileOut = card('kl').querySelector('.tc-port-out');
    expect(fileOut?.textContent).toBe('file');
    expect(fileOut?.querySelector('.tc-port-type')).toBeNull();
    expect(fileOut?.className).not.toMatch(/is-branch/);
    expect(handle('kl', 'file')?.className).not.toMatch(/is-branch/);
    for (const el of card('sg').querySelectorAll('.tc-port-in, .react-flow__handle-left')) {
      expect(el.className).not.toMatch(/is-branch/);
    }
  });
});
