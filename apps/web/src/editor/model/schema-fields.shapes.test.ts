import type { JsonValue } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { differsFromDefault, type FieldDef, fieldShown, fieldsFor } from './schema-fields.ts';

/**
 * The schema shapes a plugin author can write, as the form sees them: each property is zod 4's
 * `toJSONSchema(schema, { io: 'input' })` output for the zod shown beside it, which is what the
 * SDK publishes (`packages/sdk/src/node.ts`, `integration.ts`). docs/settings-forms.md lists the
 * result ("Supported shapes"); a shape that still falls back to raw JSON is pinned here so a
 * change to it is a decision, not an accident.
 */
const SHAPES = {
  type: 'object',
  properties: {
    // z.string().nullable().default(null)
    folder: { default: null, description: 'Folder', type: ['string', 'null'] },
    // z.boolean().nullable()
    flag: { type: ['boolean', 'null'], description: 'Flag' },
    // z.number().int().min(0).max(10).nullable()
    level: {
      anyOf: [{ type: 'integer', minimum: 0, maximum: 10 }, { type: 'null' }],
      description: 'Level',
    },
    // z.enum(['low', 'high']).nullable().default(null)
    tier: {
      default: null,
      anyOf: [{ type: 'string', enum: ['low', 'high'] }, { type: 'null' }],
      description: 'Tier',
    },
    // z.union([z.literal('fast'), z.literal('slow')]).default('fast')
    speed: {
      default: 'fast',
      anyOf: [
        { type: 'string', const: 'fast' },
        { type: 'string', const: 'slow' },
      ],
      description: 'Speed',
    },
    // z.string().optional()
    note: { type: 'string', description: 'Note' },
    // z.object({ host: z.string(), port: z.number().int() })
    server: {
      type: 'object',
      properties: { host: { type: 'string' }, port: { type: 'integer' } },
      required: ['host', 'port'],
      description: 'Server',
    },
    // z.object({ a: z.string() }).nullable().default(null)
    extra: {
      default: null,
      anyOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'null' },
      ],
      description: 'Extra',
    },
    // z.array(z.object({ from: z.string(), to: z.string() })).default([])
    renames: {
      default: [],
      type: 'array',
      items: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
        required: ['from', 'to'],
      },
      description: 'Renames',
    },
    // z.array(z.number())
    sizes: { type: 'array', items: { type: 'number' }, description: 'Sizes' },
    // z.union([z.string(), z.number()])
    either: { type: ['string', 'number'], description: 'Either' },
    // z.discriminatedUnion('kind', [...])
    target: {
      oneOf: [
        {
          type: 'object',
          properties: { kind: { type: 'string', const: 'folder' }, path: { type: 'string' } },
          required: ['kind', 'path'],
        },
        {
          type: 'object',
          properties: { kind: { type: 'string', const: 'url' }, url: { type: 'string' } },
          required: ['kind', 'url'],
        },
      ],
      description: 'Target',
    },
    // z.boolean().default(false)
    notify: { type: 'boolean', default: false, description: 'Notify' },
    // z.string().meta({ 'x-transcoda-show-when': { notify: true } })
    channel: {
      type: 'string',
      description: 'Channel',
      'x-transcoda-show-when': { notify: true },
    },
    // z.number().int().meta({ 'x-transcoda-show-when': { level: 3 } })
    depth: { type: 'integer', description: 'Depth', 'x-transcoda-show-when': { level: 3 } },
  },
  required: ['flag', 'level', 'server', 'sizes', 'either', 'target', 'channel', 'depth'],
} as const satisfies JsonValue;

const fields = fieldsFor(SHAPES);

function field(key: string): FieldDef {
  const f = fields.find((x) => x.key === key);
  if (!f) throw new Error(`no field ${key}`);
  return f;
}

describe('supported settings shapes', () => {
  it('a nullable scalar gets the control of its non-null type', () => {
    expect(field('folder').spec).toEqual({ kind: 'text' });
    expect(field('folder').default).toBeNull();
    expect(field('flag').spec).toEqual({ kind: 'boolean' });
    expect(field('level').spec).toMatchObject({ kind: 'number', integer: true, min: 0, max: 10 });
    expect(field('tier').spec).toEqual({
      kind: 'enum',
      options: ['low', 'high'],
      control: 'segmented',
    });
  });

  it('a nullable field keeps its label, required flag and default from the outer schema', () => {
    expect(field('level')).toMatchObject({ label: 'Level', required: true });
    expect(field('tier')).toMatchObject({ label: 'Tier', required: false, default: null });
  });

  it('a union of string literals is an enum', () => {
    expect(field('speed').spec).toEqual({
      kind: 'enum',
      options: ['fast', 'slow'],
      control: 'segmented',
    });
    expect(field('speed').default).toBe('fast');
  });

  it('an optional setting is a field that is not required', () => {
    expect(field('note')).toMatchObject({ required: false, spec: { kind: 'text' } });
  });

  it('a stored null counts as the null default, and nested objects compare in any key order', () => {
    expect(differsFromDefault(field('folder'), null)).toBe(false);
    expect(differsFromDefault(field('folder'), 'media')).toBe(true);
    const nested: FieldDef = { ...field('server'), default: { host: 'a', port: 1 } };
    expect(differsFromDefault(nested, { port: 1, host: 'a' })).toBe(false);
    expect(differsFromDefault(nested, { port: 2, host: 'a' })).toBe(true);
  });

  it('show-when takes booleans and numbers as well as strings', () => {
    expect(field('channel').showWhen).toEqual({ notify: true });
    expect(fieldShown(field('channel'), {}, fields)).toBe(false);
    expect(fieldShown(field('channel'), { notify: true }, fields)).toBe(true);
    expect(field('depth').showWhen).toEqual({ level: 3 });
    expect(fieldShown(field('depth'), { level: 3 }, fields)).toBe(true);
    expect(fieldShown(field('depth'), { level: 2 }, fields)).toBe(false);
  });
});

describe('shapes that fall back to raw JSON', () => {
  // Each still renders as an editable JSON textarea with the server's message under it; a real
  // control for them is follow-up work (docs/settings-forms.md, "Supported shapes").
  it.each([
    ['server', 'a nested object'],
    ['extra', 'a nullable object'],
    ['renames', 'an array of objects'],
    ['sizes', 'an array of numbers'],
    ['either', 'a union of different types'],
    ['target', 'a discriminated union'],
  ])('%s (%s) is raw', (key) => {
    expect(field(key).spec).toEqual({ kind: 'raw' });
  });
});
