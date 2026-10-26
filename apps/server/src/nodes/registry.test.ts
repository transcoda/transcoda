import type { Capabilities } from '@transcoda/contract';
import { type AnyNodeDefinition, defineNode, type NodeDefinition } from '@transcoda/sdk';
import { SUBWORKFLOW_START_TYPE } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { nodeAvailability } from './availability.ts';
import { filePort } from './core/common.ts';
import { createCoreRegistry, NodeRegistry, type RegisteredNode } from './registry.ts';

const base: Pick<
  NodeDefinition,
  'version' | 'kind' | 'title' | 'description' | 'icon' | 'inputs' | 'outputs'
> = {
  version: 1,
  kind: 'action',
  title: 'T',
  description: 'd',
  icon: 'x',
  inputs: [filePort],
  outputs: [filePort],
};

describe('NodeRegistry', () => {
  it('createCoreRegistry registers the part-1 core types; unknown → undefined', () => {
    const r = createCoreRegistry();
    for (const t of [
      'core:input-manual',
      'core:video-is',
      'core:run-subworkflow',
      SUBWORKFLOW_START_TYPE,
    ]) {
      expect(r.get(t)?.source).toEqual({ kind: 'core' });
    }
    expect(r.get('core:nope')).toBeUndefined();
  });

  it('duplicate types throw; extra entries are appended', () => {
    const entry = createCoreRegistry().get('core:input-manual');
    if (!entry) throw new Error('missing core:input-manual');
    expect(() => new NodeRegistry([entry, entry])).toThrow(/duplicate node type core:input-manual/);
    const extra = {
      def: defineNode({ ...base, type: 'test:a', settings: z.object({}) }),
      source: { kind: 'plugin', name: 'p', version: '1.0.0' },
    } as const;
    const registry = createCoreRegistry([{ ...extra }]);
    expect(registry.get('test:a')?.source).toEqual({ kind: 'plugin', name: 'p', version: '1.0.0' });
    expect(registry.list().at(-1)?.def.type).toBe('test:a');
  });
});

describe('NodeRegistry plugin entries', () => {
  const plugin = (name: string, type: string) =>
    ({
      def: defineNode({ ...base, type, settings: z.object({}) }),
      source: { kind: 'plugin', name, version: '1.0.0' },
    }) as const;

  it('add refuses a type core already provides, and adds nothing', () => {
    const r = createCoreRegistry();
    const before = r.generation;
    const clash = {
      def: defineNode({ ...base, type: 'core:video-is', settings: z.object({}) }),
      source: { kind: 'plugin', name: 'example', version: '1.0.0' },
    } as const;
    expect(() => r.add([plugin('example', 'example:a'), clash])).toThrow(
      'node type core:video-is is already provided by core',
    );
    expect(r.get('example:a')).toBeUndefined();
    expect(r.generation).toBe(before);
  });

  it('a successful add bumps generation; an empty add does not', () => {
    const r = createCoreRegistry();
    const g = r.generation;
    r.add([]);
    expect(r.generation).toBe(g);
    r.add([plugin('example', 'example:a')]);
    expect(r.generation).toBe(g + 1);
  });

  it('a duplicate inside one batch names both sources', () => {
    const r = createCoreRegistry();
    expect(() => r.add([plugin('one', 'dup:x'), plugin('two', 'dup:x')])).toThrow(
      'node type dup:x is provided twice in one batch (by plugin one and by plugin two)',
    );
    expect(r.get('dup:x')).toBeUndefined();
  });

  it('add refuses a type another plugin provides', () => {
    const r = createCoreRegistry([plugin('one', 'shared:x')]);
    expect(() => r.add([plugin('two', 'shared:x')])).toThrow(
      'node type shared:x is already provided by plugin one',
    );
  });

  it('removeBySource returns the removed types and bumps generation', () => {
    const r = createCoreRegistry();
    r.add([
      plugin('example', 'example:a'),
      plugin('example', 'example:b'),
      plugin('other', 'other:c'),
    ]);
    const generation = r.generation;
    expect(r.removeBySource('example')).toEqual(['example:a', 'example:b']);
    expect(r.generation).toBe(generation + 1);
    expect(r.get('example:a')).toBeUndefined();
    expect(r.get('other:c')).toBeDefined();
    expect(r.removeBySource('example')).toEqual([]);
    expect(r.generation).toBe(generation + 1);
  });
});

describe('nodeAvailability', () => {
  it('a plugin entry that says it cannot run is unavailable with that reason', () => {
    const def = defineNode({ ...base, type: 'example:a', settings: z.object({}) });
    const entry = {
      def,
      source: { kind: 'plugin', name: 'example', version: '1.0.0' },
      unavailable: () => 'plugin example is disabled',
    } as const;
    const on: Capabilities = { available: false, path: 'ffmpeg', error: 'ENOENT' };
    expect(nodeAvailability(entry, on, { outputRoots: [] })).toEqual({
      available: false,
      reason: 'plugin example is disabled',
    });
    expect(
      nodeAvailability({ ...entry, unavailable: () => null }, on, { outputRoots: [] }),
    ).toEqual({
      available: true,
    });
  });

  it('reports what is missing', () => {
    const core = (def: AnyNodeDefinition): RegisteredNode => ({ def, source: { kind: 'core' } });
    const none = core(defineNode({ ...base, type: 'test:a', settings: z.object({}) }));
    const needs = core(
      defineNode({
        ...base,
        type: 'test:b',
        settings: z.object({}),
        requires: { encoders: ['libx265'], filters: ['pan'] },
      }),
    );
    const off: Capabilities = { available: false, path: 'ffmpeg', error: 'ENOENT' };
    const env = { outputRoots: ['/out'] };
    const on: Capabilities = {
      available: true,
      path: 'ffmpeg',
      version: '9',
      encoders: ['libx265'],
      hwaccels: [],
      filters: [],
    };
    expect(nodeAvailability(none, off, env)).toEqual({ available: true });
    expect(nodeAvailability(needs, off, env)).toEqual({
      available: false,
      reason: 'ffmpeg is not available',
    });
    expect(nodeAvailability(needs, on, env)).toEqual({
      available: false,
      reason: 'missing filter pan',
    });
    expect(nodeAvailability(needs, { ...on, filters: ['pan'] }, env)).toEqual({ available: true });
  });

  it('move-copy needs at least one configured output root', () => {
    const moveCopy = createCoreRegistry().get('core:move-copy');
    if (!moveCopy) throw new Error('core:move-copy missing');
    const off: Capabilities = { available: false, path: 'ffmpeg', error: 'ENOENT' };
    expect(nodeAvailability(moveCopy, off, { outputRoots: [] })).toEqual({
      available: false,
      reason: 'no output roots configured (TRANSCODA_OUTPUT_ROOTS)',
    });
    expect(nodeAvailability(moveCopy, off, { outputRoots: ['/out'] })).toEqual({ available: true });
  });
});
