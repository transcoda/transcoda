// The server-side zod copy of a plugin's settings JSON Schema. The schema is plugin-authored, so
// anything that would compile to a RegExp on the server's event loop (ReDoS) is dropped first:
// `pattern`, `format` and `patternProperties`. The plugin host still validates authoritatively
// with the plugin's own zod; this copy only checks shape, type, required, enum, bounds and
// applies defaults. Every string is also bounded as a backstop.
import { z } from 'zod';

/** The longest string any plugin setting may hold on the server side (64 KiB). */
export const MAX_SETTINGS_STRING = 64 * 1024;

type Json = unknown;

const REGEX_KEYWORDS = new Set(['pattern', 'format', 'patternProperties']);
/** Keywords holding one subschema (or, for `items`, possibly a tuple of them). */
const SCHEMA_KEYWORDS = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
]);
/** Keywords holding a list of subschemas. */
const SCHEMA_LIST_KEYWORDS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
/** Keywords holding a name -> subschema map (the names are data, never keywords). */
const SCHEMA_MAP_KEYWORDS = new Set([
  'properties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
]);

function isObject(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A copy of `schema` with every regex-bearing keyword removed and every string bounded. */
export function withoutRegexKeywords(schema: Json): Json {
  if (!isObject(schema)) return schema;
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (REGEX_KEYWORDS.has(key)) continue;
    if (SCHEMA_KEYWORDS.has(key)) {
      out[key] = Array.isArray(value)
        ? value.map(withoutRegexKeywords)
        : withoutRegexKeywords(value);
    } else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
      out[key] = value.map(withoutRegexKeywords);
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && isObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, withoutRegexKeywords(sub)]),
      );
    } else {
      out[key] = value; // data (enum, const, default, examples, ...) or a scalar keyword
    }
  }
  // Keys a dropped patternProperties allowed must not now be rejected by additionalProperties.
  if ('patternProperties' in schema && out.additionalProperties === false) {
    delete out.additionalProperties;
  }
  const type = out.type;
  if (type === 'string' || (Array.isArray(type) && type.includes('string'))) {
    const max = typeof out.maxLength === 'number' ? out.maxLength : Number.POSITIVE_INFINITY;
    out.maxLength = Math.min(max, MAX_SETTINGS_STRING);
  }
  return out;
}

/** The server-side zod schema for a plugin's settings JSON Schema; throws when unconvertible. */
export function serverSettingsSchema(schema: Json): z.ZodType {
  return z.fromJSONSchema(withoutRegexKeywords(schema) as Parameters<typeof z.fromJSONSchema>[0]);
}
