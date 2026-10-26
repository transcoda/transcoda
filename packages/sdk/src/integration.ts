import { type JsonValue, PathMappingSchema } from '@transcoda/shared';
import { z } from 'zod';
import type { PluginContext } from './context.ts';

export interface IntegrationTestOk {
  ok: true;
  message: string;
  version?: string | undefined;
  warnings?: string[] | undefined;
}
export interface IntegrationTestFail {
  ok: false;
  kind: 'unreachable' | 'unauthorized' | 'wrong-product' | 'too-old' | 'other';
  message: string;
}

export interface Integration<Shape extends z.ZodRawShape = z.ZodRawShape> {
  id: string;
  title: string;
  settings: z.ZodObject<Shape>;
  /** `$settings.<field>` (a url setting) or an origin literal. */
  allowedOrigins: string[];
  test(ctx: PluginContext): Promise<IntegrationTestOk | IntegrationTestFail>;
  requires?: { product: string; minVersion: string } | undefined;
}

// biome-ignore lint/suspicious/noExplicitAny: a plugin holds one integration of any settings shape
export type AnyIntegration = Integration<any>;

export const url = () => z.url().meta({ 'x-transcoda': 'url' });
export const secret = () => z.string().min(1).meta({ format: 'password', 'x-transcoda': 'secret' });
export const pathMappings = () =>
  z.array(PathMappingSchema).default([]).meta({ 'x-transcoda': 'path-mappings' });
export const allowInsecureTls = () =>
  z.boolean().default(false).meta({ 'x-transcoda': 'insecure-tls' });

type JsonObject = Record<string, unknown>;

function members(schema: unknown): unknown[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const o = schema as JsonObject;
  return [o.anyOf, o.oneOf, o.allOf].flatMap((m) => (Array.isArray(m) ? m : []));
}

function isMarked(schema: unknown): boolean {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    ((schema as JsonObject)['x-transcoda'] === 'secret' || members(schema).some(isMarked))
  );
}

function isPassword(schema: unknown): boolean {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    ((schema as JsonObject).format === 'password' || members(schema).some(isPassword))
  );
}

/** Never under-reports: the marker or `format: 'password'`, on the property or in a wrapped member. */
function isSecretSchema(schema: unknown): boolean {
  return isMarked(schema) || isPassword(schema);
}

function properties(schema: JsonValue): Record<string, JsonObject> {
  const props = (schema as JsonObject | null)?.properties;
  return (props ?? {}) as Record<string, JsonObject>;
}

/** Top-level keys marked secret. Settings schemas are non-recursive, so nothing deeper is read. */
export function secretPaths(settingsSchema: JsonValue): string[] {
  return Object.entries(properties(settingsSchema))
    .filter(([, s]) => isSecretSchema(s))
    .map(([key]) => key);
}

/** The checks `defineIntegration` makes; `definePlugin` repeats them on a plain object. */
export function checkIntegration(i: AnyIntegration): void {
  const keys = Object.keys(i.settings.shape);
  for (const entry of i.allowedOrigins) {
    if (entry.startsWith('$settings.')) {
      const key = entry.slice('$settings.'.length);
      if (!keys.includes(key)) {
        throw new TypeError(`integration ${i.id}: allowedOrigins ${entry} names no setting`);
      }
      continue;
    }
    let origin: string | null = null;
    try {
      const u = new URL(entry);
      if (u.protocol === 'http:' || u.protocol === 'https:') origin = u.origin;
    } catch {
      // handled below
    }
    if (origin !== entry) {
      throw new TypeError(
        `integration ${i.id}: allowedOrigins entry ${entry} is neither '$settings.<field>' nor an origin`,
      );
    }
  }
  const schema = z.toJSONSchema(i.settings, { io: 'input' }) as JsonValue;
  for (const [key, prop] of Object.entries(properties(schema))) {
    if (!isSecretSchema(prop)) continue;
    if (!isMarked(prop)) {
      throw new TypeError(
        `integration ${i.id}: ${key}: a password field must use secret() (x-transcoda secret marker)`,
      );
    }
    if (Array.isArray(prop.anyOf) || members(prop).length > 0) {
      throw new TypeError(
        `integration ${i.id}: ${key}: secret fields may be optional, not nullable`,
      );
    }
  }
}

export function defineIntegration<Shape extends z.ZodRawShape>(
  i: Integration<Shape>,
): Integration<Shape> {
  checkIntegration(i);
  return i;
}

export function integrationMetadata(i: AnyIntegration): {
  id: string;
  title: string;
  settingsSchema: JsonValue;
  allowedOrigins: string[];
  requires: { product: string; minVersion: string } | null;
} {
  return {
    id: i.id,
    title: i.title,
    settingsSchema: z.toJSONSchema(i.settings, { io: 'input' }) as JsonValue,
    allowedOrigins: i.allowedOrigins,
    requires: i.requires ?? null,
  };
}
