import { NODE_KINDS } from '@transcoda/sdk';
import { describe, expect, it } from 'vitest';
import { NodeInfoSchema, NodeKindSchema, PortSpecSchema } from '../index.ts';

describe('nodes router', () => {
  it('NodeInfoSchema parses with and without finishPhase (null for a non-finish node)', () => {
    const info = {
      type: 'core:replace-original',
      version: 1,
      kind: 'finish',
      title: 'Replace original',
      description: 'd',
      icon: 'i',
      inputs: [{ id: 'file', label: 'File', type: 'file' }],
      outputs: [],
      settingsSchema: {},
      onNodeSettings: [],
      source: { kind: 'core' },
      availability: { available: true },
    };
    expect(NodeInfoSchema.parse(info)).not.toHaveProperty('finishPhase');
    expect(NodeInfoSchema.parse({ ...info, finishPhase: 'write' }).finishPhase).toBe('write');
    expect(NodeInfoSchema.parse({ ...info, finishPhase: null }).finishPhase).toBeNull();
    expect(NodeInfoSchema.safeParse({ ...info, finishPhase: 'later' }).success).toBe(false);
    expect(NodeInfoSchema.parse({ ...info, damagedOnly: true }).damagedOnly).toBe(true);
    expect(NodeInfoSchema.parse(info)).not.toHaveProperty('damagedOnly');
  });

  it("PortSpecSchema keeps a port's shownWhen", () => {
    const shownWhen = { setting: 'qualityCheck', equals: true };
    const port = { id: 'damaged', label: 'Damaged', type: 'file', shownWhen };
    expect(PortSpecSchema.parse(port).shownWhen).toEqual(shownWhen);
    expect(PortSpecSchema.safeParse({ ...port, shownWhen: { equals: true } }).success).toBe(false);
  });

  it('node schemas follow the sdk enums', () => {
    expect(NodeKindSchema.options).toEqual([...NODE_KINDS]);
    expect(PortSpecSchema.safeParse({ id: 'x', label: 'X', type: 'audio' }).success).toBe(false);
    expect(PortSpecSchema.safeParse({ id: 'x', label: 'X', type: 'data:language' }).success).toBe(
      true,
    );
  });
});
