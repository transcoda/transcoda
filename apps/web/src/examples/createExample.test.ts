import type { ApiClient } from '@transcoda/contract';
import { emptyGraph } from '@transcoda/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tvCleanupSub } from '../test/fixtures/tv-cleanup.ts';
import { createFromGraph } from './createExample.ts';

const create = vi.fn();
const api = { workflows: { create } } as unknown as ApiClient;

const created = (id: string, kind: 'workflow' | 'subworkflow') => ({
  id,
  kind,
  version: 1,
  currentVersion: 1,
  graph: emptyGraph(kind),
});

beforeEach(() => {
  create.mockReset();
});

describe('createFromGraph', () => {
  it("creates a workflow with the graph as version 1, of the graph's kind", async () => {
    create.mockResolvedValueOnce(created('w9', 'workflow'));
    const graph = tvCleanupSub();
    await expect(createFromGraph(api, 'Imported', graph)).resolves.toEqual({ id: 'w9' });
    expect(create).toHaveBeenCalledWith({ name: 'Imported', kind: 'subworkflow', graph });
  });

  it('refuses a file that is not a workflow graph without calling the server', async () => {
    create.mockReset();
    await expect(createFromGraph(api, 'x', { hello: 1 })).rejects.toThrow(
      'This file is not a Transcoda workflow.',
    );
    expect(create).not.toHaveBeenCalled();
  });
});
