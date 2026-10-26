import type { Edge, Group, NodeInstance, WorkflowGraph } from '@transcoda/shared';
import { GROUP_PADDING, NODE_SIZE } from '../../editor/model/graph-ops.ts';

/**
 * A test fixture (once the empty state's "TV cleanup" example): the Tigger & Pooh pair of
 * `apps/server/src/workflows/fixtures/tigger-pooh.ts` with the same settings, laid out for the
 * canvas. The web app never imports server code, so the graphs are written out here.
 */
export const TV_CLEANUP_SUB_NAME = 'Language cleanup';
export const TV_CLEANUP_NAME = 'TV cleanup';

/** Horizontal step between cards in a chain, and the vertical step between the two branches. */
const STEP_X = 300;
const STEP_Y = 240;

/**
 * The nodes past version 1: the size gate (pass and else outputs) and Encode video (the source
 * bitrate cap) at 2, Encode audio (track titles) at 3; everything else is at 1.
 */
const VERSIONS: Record<string, number> = {
  'core:size-gate': 2,
  'core:encode-video': 2,
  'core:encode-audio': 3,
};

const node = (
  id: string,
  type: string,
  x: number,
  y: number,
  settings: NodeInstance['settings'] = {},
  extra: Partial<Pick<NodeInstance, 'groupId'>> = {},
): NodeInstance => ({
  id,
  type,
  typeVersion: VERSIONS[type] ?? 1,
  settings,
  position: { x, y },
  ...extra,
});

const edge = (from: string, to: string, fromPort = 'file'): Edge => ({
  id: `${from}-${to}`,
  from: { node: from, port: fromPort },
  to: { node: to, port: 'file' },
});

/** The shared sub-workflow: keep English and German, English default audio, English then German. */
export function tvCleanupSub(): WorkflowGraph {
  return {
    formatVersion: 1,
    kind: 'subworkflow',
    nodes: [
      node('start', 'core:subworkflow-start', 0, 0),
      node('keep', 'core:keep-languages', STEP_X, 0, {
        languages: ['en', 'de'],
        keepOriginal: true,
        keepUntagged: true,
      }),
      node('sdt', 'core:set-default-track', STEP_X * 2, 0, {
        audioLanguages: ['en'],
        subtitleLanguages: [],
      }),
      node('rt', 'core:reorder-tracks', STEP_X * 3, 0, { languages: ['en', 'de'] }),
      node('end', 'core:subworkflow-end', STEP_X * 4, 0),
    ],
    edges: [edge('start', 'keep'), edge('keep', 'sdt'), edge('sdt', 'rt'), edge('rt', 'end')],
    groups: [],
  };
}

const GROUP_ID = 'cleanup';
/** Both Run nodes sit in one column so the "Cleanup" group can surround them. */
const RUN_X = STEP_X * 2;

/**
 * The main workflow: HEVC files (top row) run the cleanup, cover attachments, the size gate and
 * replace the original; other files (bottom row) are encoded first, then cleaned up. Both Run
 * nodes are pinned to `subId`@`subVersion`, add Turkish through the `keep.languages` override and
 * sit in the "Cleanup" group.
 */
export function tvCleanupMain(subId: string, subVersion: number): WorkflowGraph {
  const run = (id: string, y: number) =>
    node(
      id,
      'core:run-subworkflow',
      RUN_X,
      y,
      {
        subworkflowId: subId,
        version: subVersion,
        overrides: { 'keep.languages': ['en', 'de', 'tr'] },
      },
      { groupId: GROUP_ID },
    );
  const group: Group = {
    id: GROUP_ID,
    name: 'Cleanup',
    collapsed: false,
    position: { x: RUN_X - GROUP_PADDING, y: -GROUP_PADDING },
    size: {
      width: NODE_SIZE.width + 2 * GROUP_PADDING,
      height: STEP_Y + NODE_SIZE.height + 2 * GROUP_PADDING,
    },
  };
  return {
    formatVersion: 1,
    kind: 'workflow',
    nodes: [
      node('in', 'core:input-manual', 0, 0),
      node('vi', 'core:video-is', STEP_X, 0, { codecs: ['hevc'] }),
      run('run-a', 0),
      node('ca', 'core:cover-attachments', STEP_X * 3, 0),
      node('sg', 'core:size-gate', STEP_X * 4, 0, { minSavingPercent: 0 }),
      node('ro-a', 'core:replace-original', STEP_X * 5, 0),
      node('ev', 'core:encode-video', STEP_X, STEP_Y),
      run('run-b', STEP_Y),
      node('ro-b', 'core:replace-original', STEP_X * 3, STEP_Y),
    ],
    edges: [
      edge('in', 'vi'),
      edge('vi', 'run-a', 'pass'),
      edge('run-a', 'ca'),
      edge('ca', 'sg'),
      edge('sg', 'ro-a', 'pass'),
      edge('vi', 'ev', 'else'),
      edge('ev', 'run-b'),
      edge('run-b', 'ro-b'),
    ],
    groups: [group],
  };
}
