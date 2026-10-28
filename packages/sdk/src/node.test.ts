import type { JsonValue } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineNode,
  isPortRequired,
  nodeMetadata,
  PORT_TYPE_PATTERN,
  parseSettings,
} from './node.ts';

const keep = defineNode({
  type: 'test:keep',
  version: 2,
  kind: 'action',
  title: 'Keep',
  description: 'd',
  icon: 'languages',
  inputs: [
    { id: 'file', label: 'File', type: 'file' },
    { id: 'language', label: 'Language', type: 'data:language', required: false },
  ],
  outputs: [{ id: 'file', label: 'File', type: 'file' }],
  settings: z.object({
    languages: z.array(z.string()).default(['en']).describe('Languages'),
    limit: z.number().int().describe('Limit'),
  }),
  onNodeSettings: ['languages'],
  migrations: [
    {
      from: 1,
      to: 2,
      risk: 'safe',
      note: 'added limit',
      migrate: (s) => ({ ...(s as Record<string, JsonValue>), limit: 10 }),
    },
  ],
});

describe('node definition', () => {
  it('nodeMetadata is JSON-serialisable and carries the input JSON Schema with defaults', () => {
    const meta = nodeMetadata(keep);
    expect(JSON.parse(JSON.stringify(meta))).toEqual(meta);
    expect(meta.settingsSchema).toMatchObject({
      type: 'object',
      properties: { languages: { default: ['en'], description: 'Languages' } },
      required: ['limit'],
    });
    expect(meta.migrations).toEqual([{ from: 1, to: 2, risk: 'safe', note: 'added limit' }]);
    expect(meta).not.toHaveProperty('settings');
  });

  it('parseSettings applies defaults and reports missing fields with missing: true', () => {
    expect(parseSettings(keep, { limit: 3 })).toEqual({
      ok: true,
      value: { languages: ['en'], limit: 3 },
    });
    expect(parseSettings(keep, {})).toEqual({
      ok: false,
      issues: [{ path: 'limit', message: expect.any(String), missing: true }],
    });
    expect(parseSettings(keep, { limit: 'x' })).toMatchObject({
      ok: false,
      issues: [{ path: 'limit', missing: false }],
    });
    expect(parseSettings(keep, 5)).toMatchObject({
      ok: false,
      issues: [{ path: '', missing: false }],
    });
  });

  it('isPortRequired defaults to true; PORT_TYPE_PATTERN accepts file and data:language only', () => {
    expect(isPortRequired({ id: 'a', label: 'A', type: 'file' })).toBe(true);
    expect(isPortRequired({ id: 'b', label: 'B', type: 'data:language', required: false })).toBe(
      false,
    );
    expect(PORT_TYPE_PATTERN.test('data:language')).toBe(true);
    expect(PORT_TYPE_PATTERN.test('audio')).toBe(false);
  });

  it("nodeMetadata carries damagedOnly and a port's shownWhen", () => {
    const shownWhen = { setting: 'qualityCheck', equals: true };
    const replace = defineNode({
      type: 'test:replace-damaged',
      version: 1,
      kind: 'finish',
      title: 'Replace damaged',
      description: 'd',
      icon: 'i',
      inputs: [{ id: 'file', label: 'File', type: 'file' }],
      outputs: [{ id: 'damaged', label: 'Damaged', type: 'file', shownWhen }],
      settings: z.object({}),
      finishPhase: 'library-manager',
      damagedOnly: true,
    });
    const meta = nodeMetadata(replace);
    expect(meta.damagedOnly).toBe(true);
    expect(meta.outputs[0]?.shownWhen).toEqual(shownWhen);
    expect(nodeMetadata(keep).damagedOnly).toBe(false);
    expect(() => nodeMetadata({ ...keep, damagedOnly: true })).toThrow(
      'node test:keep: damagedOnly is for finish nodes',
    );
  });
});
