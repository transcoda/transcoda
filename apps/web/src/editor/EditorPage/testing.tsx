// Shared setup for the editor page tests: fixtures, the default mocked answers, render helpers.
import { ORPCError } from '@orpc/client';
import { fireEvent, screen, within } from '@testing-library/react';
import type { WorkflowDetail, WorkflowSummary } from '@transcoda/contract';
import type { WorkflowGraph } from '@transcoda/shared';
import { afterEach, beforeEach, type Mock, vi } from 'vitest';
import { Route } from 'wouter';
import { resetCatalogCache } from '../../hooks/use-catalog.ts';
import { nodesFixture } from '../../testing/fixtures/catalog.ts';
import { chainMainReplace } from '../../testing/fixtures/graphs.ts';
import { renderAt } from '../../testing/render.tsx';
import { EditorPage } from './EditorPage.tsx';

/** The mocked client calls each editor page test file declares with vi.hoisted. */
export type EditorPageMocks = Record<
  | 'get'
  | 'list'
  | 'validate'
  | 'save'
  | 'rename'
  | 'versions'
  | 'activate'
  | 'deactivate'
  | 'jobsList'
  | 'nodesList'
  | 'queue'
  | 'librariesList'
  | 'browse',
  Mock
>;

let mocks: EditorPageMocks;

export const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

export const summary: WorkflowSummary = {
  id: 'wf1',
  name: 'Smoke',
  kind: 'workflow',
  active: null,
  currentVersion: 3,
  valid: true,
  errorCount: 0,
  usesOutdatedSubworkflow: false,
  feedsLibrary: null,
  libraryInput: null,
  trigger: null,
  usedBy: [],
  createdAt: minutesAgo(600),
  updatedAt: minutesAgo(2),
};

export function detail(graph: WorkflowGraph = chainMainReplace(), version = 3): WorkflowDetail {
  return {
    ...summary,
    currentVersion: version,
    version,
    graph,
    issues: [],
    activeIssues: [],
    settings: null,
  };
}

export const saveOk = (version: number) => ({
  version,
  issues: [],
  valid: true,
  active: null as WorkflowSummary['active'],
  changes: [] as string[],
});

export const NODE_KEYS = [
  'id',
  'type',
  'typeVersion',
  'settings',
  'position',
  'label',
  'groupId',
  'bypassed',
];

export function renderEditor(path = '/workflows/wf1'): ReturnType<typeof renderAt> {
  return renderAt(path, <Route path="/workflows/:id" component={EditorPage} />);
}

export async function loadedEditor(path?: string): Promise<ReturnType<typeof renderAt>> {
  const view = renderEditor(path);
  await screen.findByRole('group', { name: /Action Keep languages/ });
  return view;
}

export function paletteButton(section: string, name: string): HTMLElement {
  const palette = screen.getByRole('complementary', { name: 'Node palette' });
  return within(within(palette).getByRole('group', { name: section })).getByRole('button', {
    name,
  });
}

export const pill = () => screen.getByRole('button', { name: /^(Active )?v\d+ · / });
/** Opens the header's "More actions" menu (when closed) and returns its item `name`, or null. */
export function menuItem(name: string | RegExp): HTMLElement | null {
  const more = screen.getByRole('button', { name: 'More actions' });
  if (more.getAttribute('aria-expanded') !== 'true') fireEvent.click(more);
  return screen.queryByRole('menuitem', { name });
}

const realMatchMedia = window.matchMedia;

/** Every media query answers `matches` (the editor asks only for max-width: 1023px). */
export function stubNarrow(matches: boolean) {
  window.matchMedia = (query: string) =>
    ({
      matches,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const conflictError = (currentVersion: number) =>
  new ORPCError('VERSION_CONFLICT', { defined: true, status: 409, data: { currentVersion } });

export const flowNode = (container: HTMLElement, id: string) =>
  container.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;

/**
 * Registers the default answers of the mocked client before each test and the clean-up after
 * it. Each test file declares `mocks` (vi.hoisted) and mocks the client itself.
 */
export function setupEditorPageMocks(m: EditorPageMocks) {
  mocks = m;
  beforeEach(() => {
    resetCatalogCache();
    mocks.get.mockReset().mockResolvedValue(detail());
    mocks.list.mockReset().mockResolvedValue({ workflows: [summary] });
    mocks.validate.mockReset().mockResolvedValue({ issues: [], valid: true });
    mocks.save.mockReset().mockResolvedValue(saveOk(4));
    mocks.rename.mockReset();
    mocks.activate.mockReset();
    mocks.deactivate.mockReset();
    mocks.jobsList.mockReset().mockResolvedValue({ jobs: [] });
    mocks.versions.mockReset().mockResolvedValue({
      versions: [{ version: 3, note: null, createdBy: 'u1', createdAt: minutesAgo(2) }],
    });
    mocks.nodesList.mockReset().mockResolvedValue({ nodes: nodesFixture });
    mocks.librariesList.mockReset().mockResolvedValue({ libraries: [], notices: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    window.matchMedia = realMatchMedia;
    // Set by the connection test only (jsdom has no elementFromPoint).
    Reflect.deleteProperty(document, 'elementFromPoint');
  });
}
