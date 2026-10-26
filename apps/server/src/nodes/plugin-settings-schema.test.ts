import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MAX_SETTINGS_STRING, serverSettingsSchema } from './plugin-settings-schema.ts';

// The pattern the security review reproduced: ~12 s for a 26-char input through z.fromJSONSchema.
const evil = '^([a-f0-9]+)*X$';

describe('serverSettingsSchema', () => {
  it('never runs a plugin-authored pattern: the reproduced ReDoS input returns at once', () => {
    const schema = serverSettingsSchema({
      type: 'object',
      properties: { apiKey: { type: 'string', pattern: evil } },
    });
    const started = performance.now();
    const r = schema.safeParse({ apiKey: 'a'.repeat(40) });
    expect(performance.now() - started).toBeLessThan(200);
    expect(r.success).toBe(true);
  });

  it('strips pattern, format and patternProperties at every depth, and leaves the source alone', () => {
    const source = {
      type: 'object',
      properties: {
        pattern: { type: 'string', pattern: evil },
        format: { type: 'string', format: 'email' },
        list: { type: 'array', items: { type: 'string', pattern: evil } },
        nested: {
          type: 'object',
          properties: { deep: { anyOf: [{ type: 'string', pattern: evil }, { type: 'number' }] } },
          patternProperties: { [evil]: { type: 'string' } },
          additionalProperties: false,
        },
        keys: { type: 'object', propertyNames: { pattern: evil }, additionalProperties: true },
        ref: { $ref: '#/$defs/slug' },
      },
      required: ['pattern'],
      $defs: { slug: { type: 'string', pattern: evil } },
    };
    const before = JSON.stringify(source);
    const schema = serverSettingsSchema(source);
    expect(JSON.stringify(source)).toBe(before);
    const bad = 'a'.repeat(40);
    const started = performance.now();
    const r = schema.safeParse({
      pattern: bad,
      format: 'not-an-email',
      list: [bad],
      nested: { deep: bad, [bad]: 'x' },
      keys: { [bad]: 1 },
      ref: bad,
    });
    expect(performance.now() - started).toBeLessThan(200);
    expect(r.success).toBe(true);
  });

  it('keeps shape, type, required, enum, bounds and defaults', () => {
    const plugin = z.object({
      host: z.string().regex(/^[a-z]+$/),
      port: z.number().int().min(1).max(65535).default(80),
      mode: z.enum(['a', 'b']),
    });
    const schema = serverSettingsSchema(z.toJSONSchema(plugin, { io: 'input' }));
    expect(schema.safeParse({ host: 'x', mode: 'a' })).toMatchObject({
      success: true,
      data: { host: 'x', port: 80, mode: 'a' },
    });
    const r = schema.safeParse({ host: 1, port: 0, mode: 'c' });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.map((i) => i.path.join('.')).sort()).toEqual(['host', 'mode', 'port']);
    expect(schema.safeParse({ mode: 'a' }).success).toBe(false);
  });

  it('bounds every string as a backstop, without raising a tighter plugin bound', () => {
    const schema = serverSettingsSchema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string', maxLength: 3 } },
    });
    expect(schema.safeParse({ a: 'x'.repeat(MAX_SETTINGS_STRING) }).success).toBe(true);
    expect(schema.safeParse({ a: 'x'.repeat(MAX_SETTINGS_STRING + 1) }).success).toBe(false);
    expect(schema.safeParse({ b: 'xxxx' }).success).toBe(false);
  });
});

describe('server code', () => {
  it('converts plugin JSON Schemas only through serverSettingsSchema', () => {
    const src = join(import.meta.dirname, '..');
    const offenders = (readdirSync(src, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => !f.endsWith('plugin-settings-schema.ts'))
      .filter((f) => readFileSync(join(src, f), 'utf8').includes('fromJSONSchema'));
    expect(offenders).toEqual([]);
  });
});
