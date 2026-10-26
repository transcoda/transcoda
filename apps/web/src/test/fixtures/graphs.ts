import type { WorkflowGraph } from '@transcoda/shared';

/**
 * Editor test graphs. `tiggerPoohSub` and `tiggerPoohMain` are the graphs of
 * `apps/server/src/workflows/fixtures/tigger-pooh.ts` (`languageCleanupSub`, `tiggerPoohMain`
 * without extra nodes) written out literally, because the web app never imports server code.
 */

/** Shared sub-workflow: keep English and German, English default audio, English then German first. */
export function tiggerPoohSub(): WorkflowGraph {
  return {
    formatVersion: 1,
    kind: 'subworkflow',
    nodes: [
      {
        id: 'start',
        type: 'core:subworkflow-start',
        typeVersion: 1,
        settings: {},
        position: { x: 0, y: 0 },
      },
      {
        id: 'end',
        type: 'core:subworkflow-end',
        typeVersion: 1,
        settings: {},
        position: { x: 400, y: 0 },
      },
      {
        id: 'keep',
        type: 'core:keep-languages',
        typeVersion: 1,
        settings: { languages: ['en', 'de'], keepOriginal: true, keepUntagged: true },
        position: { x: 0, y: 0 },
      },
      {
        id: 'sdt',
        type: 'core:set-default-track',
        typeVersion: 1,
        settings: { audioLanguages: ['en'], subtitleLanguages: [] },
        position: { x: 0, y: 0 },
      },
      {
        id: 'rt',
        type: 'core:reorder-tracks',
        typeVersion: 1,
        settings: { languages: ['en', 'de'] },
        position: { x: 0, y: 0 },
      },
    ],
    edges: [
      {
        id: 'start-keep',
        from: { node: 'start', port: 'file' },
        to: { node: 'keep', port: 'file' },
      },
      { id: 'keep-sdt', from: { node: 'keep', port: 'file' }, to: { node: 'sdt', port: 'file' } },
      { id: 'sdt-rt', from: { node: 'sdt', port: 'file' }, to: { node: 'rt', port: 'file' } },
      { id: 'rt-end', from: { node: 'rt', port: 'file' }, to: { node: 'end', port: 'file' } },
    ],
    groups: [],
  };
}

/** Main workflow: HEVC files go through the cleanup then finish; other files are encoded first. */
export function tiggerPoohMain(subId: string, subVersion: number): WorkflowGraph {
  const runSettings = () => ({
    subworkflowId: subId,
    version: subVersion,
    overrides: { 'keep.languages': ['en', 'de', 'tr'] },
  });
  return {
    formatVersion: 1,
    kind: 'workflow',
    nodes: [
      {
        id: 'in',
        type: 'core:input-manual',
        typeVersion: 1,
        settings: {},
        position: { x: 0, y: 0 },
      },
      {
        id: 'vi',
        type: 'core:video-is',
        typeVersion: 1,
        settings: { codecs: ['hevc'] },
        position: { x: 0, y: 0 },
      },
      {
        id: 'run-a',
        type: 'core:run-subworkflow',
        typeVersion: 1,
        settings: runSettings(),
        position: { x: 0, y: 0 },
        groupId: 'cleanup',
      },
      {
        id: 'ca',
        type: 'core:cover-attachments',
        typeVersion: 1,
        settings: {},
        position: { x: 0, y: 0 },
      },
      {
        id: 'sg',
        type: 'core:size-gate',
        typeVersion: 2,
        settings: { minSavingPercent: 0 },
        position: { x: 0, y: 0 },
      },
      {
        id: 'ro-a',
        type: 'core:replace-original',
        typeVersion: 1,
        settings: {},
        position: { x: 0, y: 0 },
      },
      {
        id: 'ev',
        type: 'core:encode-video',
        typeVersion: 1,
        settings: {},
        position: { x: 0, y: 0 },
      },
      {
        id: 'run-b',
        type: 'core:run-subworkflow',
        typeVersion: 1,
        settings: runSettings(),
        position: { x: 0, y: 0 },
        groupId: 'cleanup',
      },
      {
        id: 'ro-b',
        type: 'core:replace-original',
        typeVersion: 1,
        settings: {},
        position: { x: 0, y: 0 },
      },
    ],
    edges: [
      { id: 'in-vi', from: { node: 'in', port: 'file' }, to: { node: 'vi', port: 'file' } },
      { id: 'vi-run-a', from: { node: 'vi', port: 'pass' }, to: { node: 'run-a', port: 'file' } },
      { id: 'run-a-ca', from: { node: 'run-a', port: 'file' }, to: { node: 'ca', port: 'file' } },
      { id: 'ca-sg', from: { node: 'ca', port: 'file' }, to: { node: 'sg', port: 'file' } },
      { id: 'sg-ro-a', from: { node: 'sg', port: 'pass' }, to: { node: 'ro-a', port: 'file' } },
      { id: 'vi-ev', from: { node: 'vi', port: 'else' }, to: { node: 'ev', port: 'file' } },
      { id: 'ev-run-b', from: { node: 'ev', port: 'file' }, to: { node: 'run-b', port: 'file' } },
      {
        id: 'run-b-ro-b',
        from: { node: 'run-b', port: 'file' },
        to: { node: 'ro-b', port: 'file' },
      },
    ],
    groups: [
      {
        id: 'cleanup',
        name: 'Cleanup',
        collapsed: false,
        position: { x: 0, y: 0 },
        size: { width: 400, height: 200 },
      },
    ],
  };
}

/** A main workflow with only a manual trigger. */
export function oneTrigger(): WorkflowGraph {
  return {
    formatVersion: 1,
    kind: 'workflow',
    nodes: [
      {
        id: 'in',
        type: 'core:input-manual',
        typeVersion: 1,
        settings: {},
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    groups: [],
  };
}

/** Manual trigger → keep languages → replace original. */
export function chainMainReplace(): WorkflowGraph {
  return {
    formatVersion: 1,
    kind: 'workflow',
    nodes: [
      {
        id: 'in',
        type: 'core:input-manual',
        typeVersion: 1,
        settings: {},
        position: { x: 0, y: 0 },
      },
      {
        id: 'keep',
        type: 'core:keep-languages',
        typeVersion: 1,
        settings: { languages: ['en'], keepOriginal: true, keepUntagged: true },
        position: { x: 280, y: 0 },
      },
      {
        id: 'ro',
        type: 'core:replace-original',
        typeVersion: 1,
        settings: {},
        position: { x: 560, y: 0 },
      },
    ],
    edges: [
      { id: 'in-keep', from: { node: 'in', port: 'file' }, to: { node: 'keep', port: 'file' } },
      { id: 'keep-ro', from: { node: 'keep', port: 'file' }, to: { node: 'ro', port: 'file' } },
    ],
    groups: [],
  };
}
