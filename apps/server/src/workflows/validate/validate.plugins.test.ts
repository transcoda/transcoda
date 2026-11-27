import { defineNode } from '@transcoda/sdk';
import type { JsonValue } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { filePort } from '../../nodes/core/common.ts';
import { createCoreRegistry, type NodeRegistry } from '../../nodes/registry.ts';
import { node, PLUGIN_LINKS, registryWithPlugin, remoteA } from '../test-helpers.ts';
import { codes, ctx, mainWith } from './testing.ts';
import { migratePinned, validateWorkflow } from './validate.ts';

describe('validateWorkflow', () => {
  describe('plugin availability', () => {
    const pluginNode = defineNode({
      type: 'example:check',
      version: 1,
      kind: 'action',
      title: 'Example check',
      description: 'd',
      icon: 'x',
      inputs: [filePort],
      outputs: [filePort],
      settings: z.object({ room: z.string() }),
    });
    const registry = (reason: string | null) =>
      createCoreRegistry([
        {
          def: pluginNode,
          source: { kind: 'plugin', name: 'example', version: '1.0.0' },
          unavailable: () => reason,
        },
      ]);

    it('PLUGIN_UNAVAILABLE (not NODE_UNAVAILABLE) when the plugin is down', () => {
      const g = mainWith(node('p', 'example:check', { room: 'a' }));
      expect(validateWorkflow(g, ctx({ registry: registry(null) }))).toEqual([]);
      expect(
        validateWorkflow(
          g,
          ctx({ registry: registry('plugin example is not running: exited with code 3') }),
        ),
      ).toEqual([
        {
          severity: 'error',
          code: 'PLUGIN_UNAVAILABLE',
          message: "Example check can't run: plugin example is not running: exited with code 3",
          nodeId: 'p',
        },
      ]);
    });

    it('still validates the settings of an unavailable plugin node', () => {
      const g = mainWith(node('p', 'example:check', {}));
      const issues = validateWorkflow(g, ctx({ registry: registry('plugin example is disabled') }));
      expect(codes(issues)).toEqual(['error:INVALID_SETTINGS', 'error:PLUGIN_UNAVAILABLE']);
    });
  });
});

describe('plugin nodes pinned to an older node version', () => {
  const pluginCtx = (registry: NodeRegistry) => ctx({ registry });
  const reg = () => registryWithPlugin(remoteA(3, PLUGIN_LINKS));
  const withA = (typeVersion: number, settings: JsonValue = { old: 'a' }) =>
    mainWith(node('p', 'x:a', settings, { typeVersion }));

  it('a node at an older version with a safe-only path validates with no issue; its settings are not parsed by core', () => {
    // `{ old: 'a' }` would fail the v3 schema (`value` is required): the host validates after migrating.
    const safe = () => registryWithPlugin(remoteA(2, PLUGIN_LINKS.slice(0, 1)));
    expect(validateWorkflow(withA(1), pluginCtx(safe()))).toEqual([]);
    // At the current version core still checks the settings.
    expect(codes(validateWorkflow(withA(3), pluginCtx(reg())))).toEqual(['error:INVALID_SETTINGS']);
  });

  it('a path with a behaviour step is NODE_OUTDATED with the review text, never run unreviewed', () => {
    for (const v of [1, 2]) {
      const issues = validateWorkflow(withA(v), pluginCtx(reg()));
      expect(codes(issues)).toEqual(['error:NODE_OUTDATED']);
      expect(issues[0]?.message).toBe(
        'plugin update changes behavior of A; review and activate a new version',
      );
    }
  });

  it('a node whose version the plugin no longer serves is NODE_OUTDATED, "no upgrade path"', () => {
    const issues = validateWorkflow(withA(0), pluginCtx(reg()));
    expect(codes(issues)).toEqual(['error:NODE_OUTDATED']);
    expect(issues[0]?.message).toBe(
      'A is at version 0; plugin x no longer serves it (no upgrade path)',
    );
    const dropped = registryWithPlugin(remoteA(4, [{ from: 2, to: 4, risk: 'safe', note: 'n' }]));
    expect(validateWorkflow(withA(1), pluginCtx(dropped))[0]?.message).toContain(
      'no longer serves',
    );
  });

  it('migratePinned leaves plugin nodes as stored: held with the review text for a behaviour step, not held for a safe-only path', () => {
    const r = migratePinned(withA(1), reg());
    expect(r.held).toEqual([
      expect.objectContaining({
        nodeId: 'p',
        message: 'plugin update changes behavior of A; review and activate a new version',
      }),
    ]);
    expect(r.graph.nodes.find((n) => n.id === 'p')).toMatchObject({
      typeVersion: 1,
      settings: { old: 'a' },
    });
    const safe = migratePinned(withA(1), registryWithPlugin(remoteA(2, PLUGIN_LINKS.slice(0, 1))));
    expect(safe.held).toEqual([]);
  });
});
