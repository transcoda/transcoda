import type { NodeInfo } from '@transcoda/contract';
import type { JsonValue } from '@transcoda/shared';
import type { CodecMedia } from '../../data/codecs.ts';

/**
 * JSON Schema → inspector fields. The input is zod 4's `toJSONSchema` output of a `z.object`
 * (`{ type: 'object', properties, required? }`). The server stays the validation authority: the
 * client only coerces input types and checks `minimum`/`maximum`, `enum` and `required`. Any
 * shape outside the small fixed table becomes a raw JSON field, so every node stays editable.
 */

export type FieldSpec =
  | { kind: 'boolean'; help?: string }
  | { kind: 'path-mappings' }
  | {
      kind: 'number';
      integer: boolean;
      min?: number;
      max?: number;
      slider: boolean;
      /**
       * A fraction's step (integers always step 1): 1 for a percent, a hundredth of a slider's
       * range otherwise; absent means any value. Typed and slid values snap to it.
       */
      step?: number;
    }
  | { kind: 'enum'; options: string[]; control: 'segmented' | 'select' }
  | { kind: 'url' }
  | { kind: 'password' }
  | { kind: 'language' }
  | { kind: 'languages' }
  | { kind: 'enum-list'; options: string[] }
  | { kind: 'string-list' }
  /** A list of ffmpeg codec ids, picked from the grouped codec table (`x-transcoda` marker). */
  | { kind: 'codec-list'; media: CodecMedia }
  | { kind: 'text'; inputMode?: 'url' }
  | { kind: 'raw' };

export type FieldKind = FieldSpec['kind'];

export interface FieldDef {
  key: string;
  label: string;
  unit: string | null;
  /** The rest of a long description, after its first "; " or " — " (shown under the label). */
  hint?: string;
  required: boolean;
  default: JsonValue | undefined;
  spec: FieldSpec;
  schema: JsonValue;
  /**
   * Shown only while each named setting has this value (`x-transcoda-show-when`): Encode video's
   * quality in quality mode, its target bitrate in bitrate mode. See `fieldShown`.
   */
  showWhen?: Record<string, string>;
}

const SHOW_WHEN = 'x-transcoda-show-when';

/** A property's `x-transcoda-show-when`: setting key → value, string values only. */
function showWhenOf(schema: JsonValue): Record<string, string> | undefined {
  const when = isObject(schema) ? schema[SHOW_WHEN] : undefined;
  if (!isObject(when)) return undefined;
  const entries = Object.entries(when).filter(
    (e): e is [string, string] => typeof e[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Whether the inspector and the card show `def` for these settings: every setting its `showWhen`
 * names has the given value (an unset one counts as its schema default). A hidden field keeps
 * its stored value; the engine ignores it in the other mode.
 */
export function fieldShown(
  def: FieldDef,
  settings: Record<string, JsonValue>,
  fields: readonly FieldDef[],
): boolean {
  if (!def.showWhen) return true;
  return Object.entries(def.showWhen).every(([key, wanted]) => {
    const value = settings[key] ?? fields.find((f) => f.key === key)?.default;
    return value === wanted;
  });
}

/** `LanguageCodeSchema`'s regex, matched textually against a schema's `pattern`. */
export const LANGUAGE_PATTERN = '^([a-z]{2,3}|unknown)$';

/**
 * Webhook URLs are write-only in the workflow API (server `rpc/redact.ts`): a read shows a notify
 * node's `url` (and a URL-valued Run-node override) as `scheme://host/…`, or "an invalid URL" for
 * one that does not parse. Saving that exact value back for the same node keeps the stored URL;
 * anywhere else (a new node) it would be stored as typed, so it must never travel as a new value.
 */
const REDACTED_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/\s]*\/…$/i;
const REDACTED_INVALID_URL = 'an invalid URL';

export function isRedactedUrl(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && (REDACTED_URL.test(value) || value === REDACTED_INVALID_URL);
}

/** Enums up to this size are a segmented control (and may sit on the node); larger ones a select. */
const SEGMENTED_MAX = 5;
/** Bounded numbers get a slider when the range is at most this wide. */
const SLIDER_MAX_RANGE = 100;

type JsonObject = { [key: string]: JsonValue };

function isObject(v: JsonValue | undefined): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function stringArray(v: JsonValue | undefined): string[] | null {
  return Array.isArray(v) && v.every((x): x is string => typeof x === 'string') ? v : null;
}

const RAW: FieldSpec = { kind: 'raw' };

function stringSpec(s: JsonObject): FieldSpec {
  if (s.enum !== undefined) {
    const options = stringArray(s.enum);
    if (!options || options.length === 0) return RAW;
    return {
      kind: 'enum',
      options,
      control: options.length <= SEGMENTED_MAX ? 'segmented' : 'select',
    };
  }
  if (s.format === 'uri') return { kind: 'url' };
  if (s.format === 'password') return { kind: 'password' };
  if (s.pattern === LANGUAGE_PATTERN) return { kind: 'language' };
  return { kind: 'text' };
}

function numberSpec(s: JsonObject): FieldSpec {
  const min = typeof s.minimum === 'number' ? s.minimum : undefined;
  const max = typeof s.maximum === 'number' ? s.maximum : undefined;
  const integer = s.type === 'integer';
  const slider = min !== undefined && max !== undefined && max - min <= SLIDER_MAX_RANGE;
  // A slider over "any" fractions lands on values like 11.581583: it moves in hundredths of
  // its range instead (a 0–100 range in whole steps).
  const step =
    !integer && slider && min !== undefined && max !== undefined && max > min
      ? (max - min) / SLIDER_STEPS
      : undefined;
  return {
    kind: 'number',
    integer,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    slider,
    ...(step === undefined ? {} : { step }),
  };
}

/** The steps across a fractional slider's range. */
const SLIDER_STEPS = 100;

/** The number input's and slider's `step`: 1 for integers, the spec's step, else any. */
export function numberStep(spec: { integer: boolean; step?: number }): number | 'any' {
  return spec.integer ? 1 : (spec.step ?? 'any');
}

/** `n` on the spec's step (integers truncate as typed; a fraction rounds to its step). */
export function snapNumber(spec: { integer: boolean; step?: number }, n: number): number {
  if (spec.integer) return Math.trunc(n);
  if (spec.step === undefined) return n;
  const decimals = Math.max(0, Math.ceil(-Math.log10(spec.step)));
  return Number((Math.round(n / spec.step) * spec.step).toFixed(decimals));
}

function arraySpec(s: JsonObject): FieldSpec {
  const items = s.items;
  if (!isObject(items) || items.type !== 'string' || hasComposition(items)) return RAW;
  const item = stringSpec(items);
  if (item.kind === 'language') return { kind: 'languages' };
  if (item.kind === 'enum') return { kind: 'enum-list', options: item.options };
  if (item.kind === 'text') return { kind: 'string-list' };
  return RAW;
}

function hasComposition(s: JsonObject): boolean {
  return (
    s.oneOf !== undefined || s.anyOf !== undefined || s.allOf !== undefined || s.$ref !== undefined
  );
}

function transcodaSpec(marker: JsonValue | undefined): FieldSpec | null {
  switch (marker) {
    case 'secret':
      return { kind: 'password' };
    case 'url':
      return { kind: 'text', inputMode: 'url' };
    case 'path-mappings':
      return { kind: 'path-mappings' };
    case 'video-codecs':
      return { kind: 'codec-list', media: 'video' };
    case 'audio-codecs':
      return { kind: 'codec-list', media: 'audio' };
    case 'insecure-tls':
      return { kind: 'boolean', help: 'Accept self-signed certificates for this service' };
    default:
      return null;
  }
}

/** The field spec for one property schema; anything outside the table is `raw`. */
export function specFor(property: JsonValue): FieldSpec {
  if (isObject(property)) {
    // A plugin's settings: the SDK helpers mark their fields (`secret()`, `url()`, ...).
    const marked = transcodaSpec(property['x-transcoda']);
    if (marked) return marked;
  }
  if (!isObject(property) || hasComposition(property)) return RAW;
  switch (property.type) {
    case 'boolean':
      // A core node's switch may say what it does (`.meta({ help })`: Render's Quality check).
      return typeof property.help === 'string'
        ? { kind: 'boolean', help: property.help }
        : { kind: 'boolean' };
    case 'number':
    case 'integer':
      return numberSpec(property);
    case 'string':
      return stringSpec(property);
    case 'array':
      return arraySpec(property);
    default:
      return RAW;
  }
}

/** "minSavingPercent" → "Min saving percent". */
function sentenceCase(key: string): string {
  const words = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Bitrate (kbps)" → { label: "Bitrate", unit: "kbps" }. */
function splitUnit(text: string): { label: string; unit: string | null } {
  const m = /^(.*\S)\s*\(([^()]+)\)$/.exec(text);
  return m?.[1] && m[2] ? { label: m[1], unit: m[2] } : { label: text, unit: null };
}

/** Index of `sep` in `text` at parenthesis depth 0, or -1. */
function topLevelIndexOf(text: string, sep: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (depth === 0 && text.startsWith(sep, i)) return i;
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && depth > 0) depth--;
  }
  return -1;
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * "Recycle folder for the original; unset means the library default" → label "Recycle folder
 * for the original", hint "Unset means the library default". Splits at the first "; " or " — "
 * outside parentheses. A trailing parenthetical that reads as a sentence (it contains "; " or
 * ": ") is a hint too, not a unit: "Subtitle conversion ('keep': …; 'drop': …)".
 */
function splitHint(text: string): { head: string; hint?: string } {
  const at = [topLevelIndexOf(text, '; '), topLevelIndexOf(text, ' — ')].filter((i) => i > 0);
  if (at.length === 0) {
    const m = /^(.*\S)\s*\(([^()]+)\)$/.exec(text);
    if (m?.[1] && m[2] && /[;:] /.test(m[2])) return { head: m[1], hint: capitalise(m[2].trim()) };
    return { head: text };
  }
  const i = Math.min(...at);
  const sep = text.startsWith('; ', i) ? 2 : 3;
  const rest = text.slice(i + sep).trim();
  if (rest === '') return { head: text.slice(0, i) };
  return { head: text.slice(0, i), hint: capitalise(rest) };
}

/** One field per top-level property, in schema order; a non-object schema has none. */
export function fieldsFor(settingsSchema: JsonValue): FieldDef[] {
  if (!isObject(settingsSchema) || !isObject(settingsSchema.properties)) return [];
  const required = new Set(stringArray(settingsSchema.required) ?? []);
  return Object.entries(settingsSchema.properties).map(([key, schema]) => {
    const description =
      isObject(schema) && typeof schema.description === 'string' && schema.description.trim()
        ? schema.description.trim()
        : sentenceCase(key);
    const { head, hint } = splitHint(description);
    const named = splitUnit(head);
    const spec = specFor(schema);
    const showWhen = showWhenOf(schema);
    return {
      key,
      ...(showWhen === undefined ? {} : { showWhen }),
      ...named,
      ...(hint === undefined ? {} : { hint }),
      required: required.has(key),
      default: isObject(schema) ? schema.default : undefined,
      // A percent is whole percent (the size gate's "Saved at least (%)").
      spec:
        spec.kind === 'number' && !spec.integer && named.unit === '%' ? { ...spec, step: 1 } : spec,
      schema,
    };
  });
}

/** The top-level `default` of each property (copied), used as a new node's settings. */
export function defaultSettings(settingsSchema: JsonValue): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  if (!isObject(settingsSchema) || !isObject(settingsSchema.properties)) return out;
  for (const [key, prop] of Object.entries(settingsSchema.properties)) {
    if (isObject(prop) && prop.default !== undefined) out[key] = structuredClone(prop.default);
  }
  return out;
}

/** Input text → the field's value type; empty or unparseable input is `undefined` (not set). */
export function coerce(spec: FieldSpec, raw: string): JsonValue | undefined {
  if (raw.trim() === '') return undefined;
  if (spec.kind === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    return snapNumber(spec, n);
  }
  if (spec.kind === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return undefined;
  }
  return raw;
}

const oneOf = (options: string[]) => `Must be one of: ${options.join(', ')}`;

/**
 * The client-side message for a value: what JSON Schema states plainly (required, bounds, enum).
 * Shown live until the server's own issue for the same setting replaces it.
 */
export function clientIssue(def: FieldDef, value: JsonValue | undefined): string | null {
  if (value === undefined) return def.required ? 'Required' : null;
  const { spec } = def;
  if (spec.kind === 'number' && typeof value === 'number') {
    if (spec.min !== undefined && value < spec.min) return `Must be at least ${spec.min}`;
    if (spec.max !== undefined && value > spec.max) return `Must be at most ${spec.max}`;
  }
  if (spec.kind === 'enum' && typeof value === 'string' && !spec.options.includes(value)) {
    return oneOf(spec.options);
  }
  if (
    spec.kind === 'enum-list' &&
    Array.isArray(value) &&
    value.some((v) => typeof v !== 'string' || !spec.options.includes(v))
  ) {
    return oneOf(spec.options);
  }
  return null;
}

/**
 * Settings the inspector keeps under a closed "Advanced", by node type: tuning most workflows
 * leave at its default. Presentation only: the values, defaults and checks are the same, a field
 * with a message opens Advanced, and the card shows nothing different.
 */
const ADVANCED_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  'core:encode-video': ['encoder', 'preset', 'neverIncreaseBitrate'],
  'core:encode-audio': ['neverIncreaseBitrate', 'updateTitles', 'whenUnsupported'],
  'core:remux': ['subtitleConversion'],
  'core:embed-sidecar-subtitles': ['afterEmbed', 'skipExisting'],
  'core:notify-webhook': ['method'],
};

/** Whether the inspector shows this setting of this node type under "Advanced". */
export function isAdvancedSetting(nodeType: string, key: string): boolean {
  return ADVANCED_SETTINGS[nodeType]?.includes(key) ?? false;
}

/**
 * A plugin integration's settings under "Advanced": path mappings and "allow insecure TLS" (the
 * SDK's `pathMappings()` and `insecureTls()` markers), set once for an unusual setup.
 */
export function isAdvancedPluginSetting(def: FieldDef): boolean {
  const marker = isObject(def.schema) ? def.schema['x-transcoda'] : undefined;
  return marker === 'path-mappings' || marker === 'insecure-tls';
}

/**
 * Whether a field holds something other than its default (an unset field never does): what an
 * "Advanced" section counts as changed while it is closed.
 */
export function differsFromDefault(def: FieldDef, value: JsonValue | undefined): boolean {
  if (value === undefined) return false;
  return JSON.stringify(value) !== JSON.stringify(def.default ?? null);
}

/** The Library trigger's `libraryId`: a select of libraries on the card and in the inspector. */
export function isLibraryField(def: NodeInfo, field: FieldDef): boolean {
  return ON_NODE_PICKS.some(
    (p) =>
      p.control === 'library' &&
      p.type === def.type &&
      p.key === field.key &&
      p.kind === field.spec.kind,
  );
}

export type OnNodeControl = 'number' | 'select' | 'library' | 'first-language' | 'summary';

/**
 * The picks that are not a plain enum, by node type and setting key (N12): Library on the Library
 * trigger (a select of the existing libraries) and Default audio on Set default track (a select
 * for the first entry of its ordered language list). Keep languages and Reorder tracks hold the
 * same kind of list and stay chips; the inspector keeps every field either way.
 */
const ON_NODE_PICKS: ReadonlyArray<{
  type: string;
  key: string;
  kind: FieldKind;
  control: OnNodeControl;
}> = [
  { type: 'core:input-library', key: 'libraryId', kind: 'text', control: 'library' },
  {
    type: 'core:set-default-track',
    key: 'audioLanguages',
    kind: 'languages',
    control: 'first-language',
  },
];

/**
 * The node's `onNodeSettings`, each with the control its schema allows on the card (N12): a
 * number with both bounds, an enum of at most five values, or one of the named picks above;
 * everything else is a summary.
 */
export function onNodeControlKeys(def: NodeInfo): Array<{ key: string; control: OnNodeControl }> {
  const properties = isObject(def.settingsSchema) ? def.settingsSchema.properties : undefined;
  return def.onNodeSettings.map((key) => {
    const spec = specFor(isObject(properties) ? (properties[key] ?? null) : null);
    if (spec.kind === 'number' && spec.min !== undefined && spec.max !== undefined) {
      return { key, control: 'number' };
    }
    if (spec.kind === 'enum' && spec.control === 'segmented') return { key, control: 'select' };
    const pick = ON_NODE_PICKS.find((p) => p.type === def.type && p.key === key);
    if (pick && pick.kind === spec.kind) return { key, control: pick.control };
    return { key, control: 'summary' };
  });
}
