import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { WorkflowGraph } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chainMainReplace } from '../../testing/fixtures/graphs.ts';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  validate: vi.fn(),
  save: vi.fn(),
  rename: vi.fn(),
  versions: vi.fn(),
  activate: vi.fn(),
  deactivate: vi.fn(),
  jobsList: vi.fn(),
  nodesList: vi.fn(),
  queue: vi.fn(),
  librariesList: vi.fn(),
  browse: vi.fn(),
}));
vi.mock('../../api/client.ts', async () => {
  const orpc = await import('@orpc/client');
  return {
    api: {
      workflows: {
        get: mocks.get,
        list: mocks.list,
        validate: mocks.validate,
        save: mocks.save,
        rename: mocks.rename,
        versions: mocks.versions,
        activate: mocks.activate,
        deactivate: mocks.deactivate,
      },
      nodes: { list: mocks.nodesList },
      jobs: { queue: mocks.queue, list: mocks.jobsList },
      libraries: { list: mocks.librariesList, browse: mocks.browse },
    },
    isDefinedError: orpc.isDefinedError,
    safe: orpc.safe,
  };
});

import { detail, flowNode, loadedEditor, minutesAgo, setupEditorPageMocks } from './testing.tsx';

setupEditorPageMocks(mocks);
afterEach(cleanup);

describe('EditorPage library binding (library trigger T5)', () => {
  const lib = (id: string, name: string) => ({
    id,
    name,
    path: `/media/${name}`,
    recycleFolder: null,
    processHardlinked: false,
    verifyFullDecode: false,
    feeds: null,
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(60),
  });

  /** chainMainReplace with its Manual input swapped for a Library input on `libraryId`. */
  function onLibrary(libraryId: string): WorkflowGraph {
    const g = chainMainReplace();
    g.nodes[0] = {
      id: 'in',
      type: 'core:input-library',
      typeVersion: 1,
      settings: { libraryId },
      position: { x: 0, y: 0 },
    };
    return g;
  }

  beforeEach(() => {
    mocks.librariesList
      .mockReset()
      .mockResolvedValue({ libraries: [lib('l1', 'Shows'), lib('l2', 'Movies')], notices: [] });
  });

  it('a draft that names another library than the one v3 feeds shows the library banner', async () => {
    mocks.get.mockResolvedValue({
      ...detail(onLibrary('l2'), 4),
      active: { version: 3, runnable: true, activatedAt: minutesAgo(60), activatedBy: 'u1' },
      feedsLibrary: { id: 'l1', name: 'Shows' },
    });
    await loadedEditor();
    expect(
      await screen.findByText(
        'Real runs still take files from Shows (v3 active). Activate this version to switch to Movies.',
      ),
    ).toBeTruthy();
  });

  it("the inspector's Library field carries the hint about active versions", async () => {
    mocks.get.mockResolvedValue(detail(onLibrary('l1')));
    const { container } = await loadedEditor();
    fireEvent.click(flowNode(container, 'in'));
    expect(
      await screen.findByText(
        'Files from this library go to this workflow once a version is active.',
      ),
    ).toBeTruthy();
  });
});
