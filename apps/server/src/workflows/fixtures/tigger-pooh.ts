import type { Edge, Group, NodeInstance, WorkflowGraph } from '@transcoda/shared';
import { chain, edge, mainGraph, node } from '../test-helpers.ts';

/** Shared sub-workflow: keep English and German, English default audio, English then German first. */
export function languageCleanupSub(): WorkflowGraph {
  return chain(
    'subworkflow',
    node('keep', 'core:keep-languages', {
      languages: ['en', 'de'],
      keepOriginal: true,
      keepUntagged: true,
    }),
    node('sdt', 'core:set-default-track', { audioLanguages: ['en'], subtitleLanguages: [] }),
    node('rt', 'core:reorder-tracks', { languages: ['en', 'de'] }),
  );
}

/**
 * Main workflow: HEVC files go through the cleanup then finish; other files are encoded first
 * (`extraNodes` are chained after the encoder), then cleaned up. Both runs share overrides and a group.
 */
export function tiggerPoohMain(
  subId: string,
  subVersion: number,
  opts: { extraNodes?: NodeInstance[] } = {},
): WorkflowGraph {
  const run = (id: string): NodeInstance =>
    node(
      id,
      'core:run-subworkflow',
      {
        subworkflowId: subId,
        version: subVersion,
        overrides: { 'keep.languages': ['en', 'de', 'tr'] },
      },
      { groupId: 'cleanup' },
    );
  const elseChain = [
    node('ev', 'core:encode-video'),
    ...(opts.extraNodes ?? []),
    run('run-b'),
    node('ro-b', 'core:replace-original'),
  ];
  const nodes: NodeInstance[] = [
    node('in', 'core:input-manual'),
    node('vi', 'core:video-is', { codecs: ['hevc'] }),
    run('run-a'),
    node('ca', 'core:cover-attachments'),
    node('sg', 'core:size-gate', { minSavingPercent: 0 }),
    node('ro-a', 'core:replace-original'),
    ...elseChain,
  ];
  const edges: Edge[] = [
    edge('in', 'vi'),
    edge('vi', 'run-a', { from: 'pass' }),
    edge('run-a', 'ca'),
    edge('ca', 'sg'),
    edge('sg', 'ro-a', { from: 'pass' }),
    edge('vi', 'ev', { from: 'else' }),
    ...elseChain.slice(1).map((n, i) => edge((elseChain[i] as NodeInstance).id, n.id)),
  ];
  const group: Group = {
    id: 'cleanup',
    name: 'Cleanup',
    collapsed: false,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 200 },
  };
  return { ...mainGraph(nodes, edges), groups: [group] };
}
