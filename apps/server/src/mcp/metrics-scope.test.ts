import { describe, expect, it } from 'vitest';
import { toolsFor } from './tool.ts';
import { ALL_TOOLS } from './tools/index.ts';

describe('the metrics scope over MCP', () => {
  it('unlocks no tool: a metrics-only token sees an empty tool list', () => {
    expect(toolsFor(['metrics'], ALL_TOOLS)).toEqual([]);
  });

  it('adds no tool to a read token', () => {
    expect(toolsFor(['read', 'metrics'], ALL_TOOLS).map((t) => t.name)).toEqual(
      toolsFor(['read'], ALL_TOOLS).map((t) => t.name),
    );
  });
});
