import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { corePluginContext } from './context.ts';
import { type DecideContext, type DecideResult, STREAM_PLAN_TYPES } from './engine.ts';
import { defineNode } from './node.ts';

const gate = defineNode({
  type: 'test:gate',
  version: 1,
  kind: 'condition',
  title: 'Gate',
  description: 'd',
  icon: 'split',
  inputs: [{ id: 'file', label: 'File', type: 'file' }],
  outputs: [
    { id: 'pass', label: 'Pass', type: 'file' },
    { id: 'fail', label: 'Fail', type: 'file' },
  ],
  settings: z.object({ minHeight: z.number().int().describe('Minimum height') }),
  async decide(ctx, settings): Promise<DecideResult> {
    ctx.log(`checking ${ctx.file.path}`);
    return { port: 'pass', reason: `x ${settings.minHeight}` };
  },
});

const ctx: DecideContext = {
  probe: {
    container: 'matroska',
    durationSeconds: 1,
    sizeBytes: 10,
    bitrateKbps: null,
    streams: [],
    formatName: 'matroska,webm',
    chapters: 0,
    raw: {},
  },
  file: { path: '/media/a.mkv', sizeBytes: 10, mtime: '2026-10-16T00:00:00.000Z', nlink: 1 },
  data: { language: 'unknown' },
  capabilities: { encoders: ['libx264'], filters: [], hwaccels: [] },
  log: () => {},
  plugin: corePluginContext(),
  now: Date.parse('2026-10-16T12:00:00.000Z'),
};

describe('engine hook types', () => {
  it('a typed decide hook is callable and returns a port and reason', async () => {
    await expect(gate.decide?.(ctx, { minHeight: 720 })).resolves.toEqual({
      port: 'pass',
      reason: 'x 720',
    });
  });

  it('has five stream plan types', () => {
    expect(STREAM_PLAN_TYPES).toEqual(['video', 'audio', 'subtitle', 'attachment', 'data']);
  });
});
