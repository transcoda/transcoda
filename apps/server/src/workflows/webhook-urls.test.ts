import { RUN_SUBWORKFLOW_TYPE } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { mainGraph, node } from './test-helpers.ts';
import { dropWebhookUrls, NOTIFY_NODE } from './webhook-urls.ts';

describe('dropWebhookUrls', () => {
  const notify = node('n', NOTIFY_NODE, {
    url: 'https://hooks.example/t?token=s3cret',
    method: 'POST',
  });
  const run = node('r', RUN_SUBWORKFLOW_TYPE, {
    subworkflowId: 'sub',
    version: 1,
    overrides: { 'n.url': 'https://h/x', 'keep.languages': ['en'], 'media.base': 'http://srv/api' },
  });

  it('blanks notify urls, deletes URL overrides, keeps everything else', () => {
    const { graph, droppedNodeIds } = dropWebhookUrls(
      mainGraph([notify, run, node('x', 'core:input-manual', 5)]),
    );
    expect(droppedNodeIds).toEqual(['n', 'r']);
    expect(graph.nodes[0]?.settings).toEqual({ url: '', method: 'POST' });
    expect(graph.nodes[1]?.settings).toEqual({
      subworkflowId: 'sub',
      version: 1,
      overrides: { 'keep.languages': ['en'] },
    });
    expect(graph.nodes[2]?.settings).toBe(5);
    expect(JSON.stringify(graph)).not.toContain('s3cret');
  });

  it('is a no-op without secrets; an already-empty url is not a drop', () => {
    const g = mainGraph([
      node('a', 'core:input-manual'),
      node('n0', NOTIFY_NODE, { url: '', method: 'POST' }),
    ]);
    expect(dropWebhookUrls(g)).toEqual({ graph: g, droppedNodeIds: [] });
  });
});
