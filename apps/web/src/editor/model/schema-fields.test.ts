import type { NodeInfo } from '@transcoda/contract';
import type { JsonValue } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { nodesFixture } from '../../test/fixtures/catalog.ts';
import {
  clientIssue,
  coerce,
  defaultSettings,
  type FieldDef,
  fieldShown,
  fieldsFor,
  isRedactedUrl,
  LANGUAGE_PATTERN,
  onNodeControlKeys,
  specFor,
} from './schema-fields.ts';

function def(type: string): NodeInfo {
  const n = nodesFixture.find((x) => x.type === type);
  if (!n) throw new Error(`no fixture node ${type}`);
  return n;
}

function field(type: string, key: string): FieldDef {
  const f = fieldsFor(def(type).settingsSchema).find((x) => x.key === key);
  if (!f) throw new Error(`no field ${type}.${key}`);
  return f;
}

describe('fieldsFor over the node catalogue', () => {
  it('maps every core node setting to a non-raw field', () => {
    const core = nodesFixture.filter(
      (n) => n.type.startsWith('core:') && n.type !== 'core:run-subworkflow',
    );
    expect(core.length).toBeGreaterThan(10);
    for (const n of core) {
      for (const f of fieldsFor(n.settingsSchema)) {
        expect(f.spec.kind, `${n.type}.${f.key}`).not.toBe('raw');
      }
    }
  });

  it('keeps schema order and reads label, required and default', () => {
    const fields = fieldsFor(def('core:encode-video').settingsSchema);
    expect(fields.map((f) => f.key)).toEqual([
      'codec',
      'encoder',
      'rateControl',
      'quality',
      'bitrateKbps',
      'neverIncreaseBitrate',
      'preset',
      'skipIf',
      'targets',
    ]);
    expect(fields[0]).toMatchObject({ label: 'Target codec', unit: null, required: false });
    expect(fields[0]?.default).toBe('hevc');
  });

  it('encode-video rate control and the bitrate cap read as labelled fields with hints', () => {
    expect(field('core:encode-video', 'rateControl')).toMatchObject({
      label: 'Rate control',
      hint: 'Quality keeps a constant quality (CRF, or CQ/QP on hardware), bitrate aims at the target bitrate',
      default: 'quality',
      spec: { kind: 'enum', options: ['quality', 'bitrate'], control: 'segmented' },
    });
    expect(field('core:encode-video', 'quality')).toMatchObject({
      label: 'Quality',
      unit: 'CRF',
      hint: 'Lower is better',
      showWhen: { rateControl: 'quality' },
    });
    expect(field('core:encode-video', 'bitrateKbps')).toMatchObject({
      label: 'Target bitrate',
      unit: 'kb/s',
      showWhen: { rateControl: 'bitrate' },
      default: 6000,
      spec: { kind: 'number', integer: true, min: 100, max: 200_000, slider: false },
    });
    for (const type of ['core:encode-video', 'core:encode-audio']) {
      expect(field(type, 'neverIncreaseBitrate')).toMatchObject({
        label: 'Never above the source bitrate',
        default: true,
        spec: { kind: 'boolean' },
      });
    }
    expect(field('core:encode-video', 'neverIncreaseBitrate').hint).toBe(
      "Caps the encode at the source video's bitrate (the whole file's when the stream has none)",
    );
    expect(field('core:encode-audio', 'neverIncreaseBitrate').hint).toBe(
      "A track is encoded at most at its source bitrate, when it's known",
    );
  });

  it('fieldShown follows the setting a field depends on, its default when unset', () => {
    const fields = fieldsFor(def('core:encode-video').settingsSchema);
    const shown = (settings: Record<string, JsonValue>) =>
      fields.filter((f) => fieldShown(f, settings, fields)).map((f) => f.key);
    expect(shown({})).toContain('quality');
    expect(shown({})).not.toContain('bitrateKbps');
    expect(shown({ rateControl: 'quality' })).not.toContain('bitrateKbps');
    const bitrate = shown({ rateControl: 'bitrate' });
    expect(bitrate).toContain('bitrateKbps');
    expect(bitrate).not.toContain('quality');
    // Fields without a condition always show.
    expect(bitrate).toEqual(
      expect.arrayContaining(['codec', 'rateControl', 'neverIncreaseBitrate']),
    );
  });

  it('keep-languages: languages → languages field with default ["en"]; keepOriginal → boolean', () => {
    const languages = field('core:keep-languages', 'languages');
    expect(languages.spec).toEqual({ kind: 'languages' });
    expect(languages.default).toEqual(['en']);
    expect(languages.label).toBe('Languages to keep');
    expect(field('core:keep-languages', 'keepOriginal').spec).toEqual({ kind: 'boolean' });
    expect(field('core:has-stream', 'language').spec).toEqual({ kind: 'language' });
  });

  it('encode-video.quality → number 0–63 integer with slider; encode-audio.bitrateKbps → label "Bitrate", unit "kb/s", min 32 max 1024, no slider', () => {
    const quality = field('core:encode-video', 'quality');
    expect(quality.spec).toEqual({ kind: 'number', integer: true, min: 0, max: 63, slider: true });
    expect(quality).toMatchObject({ label: 'Quality', unit: 'CRF', default: 24 });
    const bitrate = field('core:encode-audio', 'bitrateKbps');
    expect(bitrate).toMatchObject({ label: 'Bitrate', unit: 'kb/s' });
    expect(bitrate.spec).toEqual({
      kind: 'number',
      integer: true,
      min: 32,
      max: 1024,
      slider: false,
    });
    expect(field('core:size-gate', 'minSavingPercent').spec).toEqual({
      kind: 'number',
      integer: false,
      min: 0,
      max: 100,
      slider: true,
      step: 1,
    });
    expect(field('core:file-matches', 'minSizeMb').spec).toEqual({
      kind: 'number',
      integer: false,
      min: 0,
      slider: false,
    });
  });

  it('notify-webhook.url → url and required; method → segmented enum', () => {
    const url = field('core:notify-webhook', 'url');
    expect(url.spec).toEqual({ kind: 'url' });
    expect(url.required).toBe(true);
    expect(field('core:notify-webhook', 'method').spec).toEqual({
      kind: 'enum',
      options: ['POST', 'PUT'],
      control: 'segmented',
    });
    expect(field('core:remux', 'subtitleConversion').required).toBe(false);
  });

  it('video-is.codecs → the video codec list (its marker); plain strings → text', () => {
    expect(field('core:video-is', 'codecs').spec).toEqual({ kind: 'codec-list', media: 'video' });
    // Without the marker a string list stays free text.
    expect(specFor({ type: 'array', items: { type: 'string' } })).toEqual({ kind: 'string-list' });
    expect(field('core:encode-video', 'preset').spec).toEqual({ kind: 'text' });
  });

  it('run-subworkflow.overrides → raw', () => {
    expect(field('core:run-subworkflow', 'overrides').spec).toEqual({ kind: 'raw' });
  });

  it('a non-object settings schema yields no fields', () => {
    expect(fieldsFor(null)).toEqual([]);
    expect(fieldsFor(3)).toEqual([]);
    expect(fieldsFor([])).toEqual([]);
    expect(fieldsFor({ type: 'object' })).toEqual([]);
    expect(fieldsFor({ type: 'object', properties: [] })).toEqual([]);
  });

  it('splits a long description at the first "; " or " — " into label and hint', () => {
    expect(field('core:set-default-track', 'audioLanguages')).toMatchObject({
      label: 'Audio languages in order of preference',
      hint: 'The original language comes first',
    });
    expect(field('core:replace-original', 'recycleFolder')).toMatchObject({
      label: 'Recycle folder for the original',
      hint: 'Unset means the library default',
    });
    expect(field('core:remux', 'subtitleConversion')).toMatchObject({
      label: 'Subtitle conversion',
      unit: null,
      hint: expect.stringMatching(/^'keep' and 'convert': .*; 'drop-incompatible': /),
    });
    expect(field('core:encode-video', 'targets').spec).toEqual({
      kind: 'enum-list',
      options: ['android-tv', 'chrome'],
    });
    const [dash] = fieldsFor({
      type: 'object',
      properties: { a: { type: 'integer', description: 'Bitrate (kbps) — 0 means auto; really' } },
    });
    expect(dash).toMatchObject({ label: 'Bitrate', unit: 'kbps', hint: '0 means auto; really' });
    expect(field('core:encode-audio', 'bitrateKbps')).not.toHaveProperty('hint');
  });

  it('labels without a description come from the key in sentence case', () => {
    const [f] = fieldsFor({ type: 'object', properties: { minSavingPercent: { type: 'number' } } });
    expect(f).toMatchObject({ label: 'Min saving percent', unit: null, default: undefined });
  });
});

describe('specFor', () => {
  it('follows the spec table', () => {
    expect(specFor({ type: 'integer' })).toEqual({ kind: 'number', integer: true, slider: false });
    expect(specFor({ type: 'string', enum: ['a', 'b', 'c', 'd', 'e'] })).toMatchObject({
      control: 'segmented',
    });
    expect(specFor({ type: 'string', enum: ['a', 'b', 'c', 'd', 'e', 'f'] })).toMatchObject({
      kind: 'enum',
      control: 'select',
    });
    expect(specFor({ type: 'string', format: 'password' })).toEqual({ kind: 'password' });
    expect(specFor({ type: 'string', pattern: LANGUAGE_PATTERN })).toEqual({ kind: 'language' });
    expect(specFor({ type: 'array', items: { type: 'string', enum: ['tv', 'phone'] } })).toEqual({
      kind: 'enum-list',
      options: ['tv', 'phone'],
    });
  });

  it('falls back to raw for anything else', () => {
    const raws: JsonValue[] = [
      null,
      'string',
      { type: 'object', properties: {} },
      { anyOf: [{ type: 'string' }, { type: 'number' }] },
      { oneOf: [{ type: 'string' }] },
      { $ref: '#/$defs/x' },
      { type: ['string', 'null'] },
      { type: 'array', items: { type: 'number' } },
      { type: 'array' },
      { type: 'string', enum: ['a', 1] },
      { type: 'null' },
      {},
    ];
    for (const s of raws) expect(specFor(s), JSON.stringify(s)).toEqual({ kind: 'raw' });
  });
});

describe('defaultSettings', () => {
  it('copies top-level defaults and ignores non-object schemas', () => {
    const schema = {
      type: 'object',
      properties: { a: { default: 1 }, b: { type: 'string' }, c: { default: ['x'] } },
    };
    const out = defaultSettings(schema);
    expect(out).toEqual({ a: 1, c: ['x'] });
    expect(out.c).not.toBe(schema.properties.c.default);
    expect(defaultSettings(null)).toEqual({});
    expect(defaultSettings({ type: 'object' })).toEqual({});
  });
});

describe('coerce', () => {
  it('a percent moves in whole steps: typed fractions round, a small slider range gets a fine step', () => {
    const percent = field('core:size-gate', 'minSavingPercent').spec;
    expect(coerce(percent, '11.581583')).toBe(12);
    expect(coerce(percent, '7.4')).toBe(7);
    // A "%" unit means whole percent even past the slider's range.
    const [wide] = fieldsFor({
      type: 'object',
      properties: { p: { type: 'number', minimum: 0, maximum: 1000, description: 'Share (%)' } },
    });
    expect(wide?.spec).toMatchObject({ slider: false, step: 1 });
    // A ratio 0–1 slides in hundredths, not in "any" fractions; typed values snap to them.
    const ratio = specFor({ type: 'number', minimum: 0, maximum: 1 });
    expect(ratio).toMatchObject({ slider: true, step: 0.01 });
    expect(coerce(ratio, '0.3333')).toBe(0.33);
  });

  it('turns input text into the field type', () => {
    const integer = { kind: 'number', integer: true, slider: false } as const;
    const number = { kind: 'number', integer: false, slider: false } as const;
    expect(coerce(integer, '24.7')).toBe(24);
    expect(coerce(number, '2.5')).toBe(2.5);
    expect(coerce(number, 'abc')).toBeUndefined();
    expect(coerce(number, '')).toBeUndefined();
    expect(coerce(number, '  ')).toBeUndefined();
    expect(coerce({ kind: 'boolean' }, 'true')).toBe(true);
    expect(coerce({ kind: 'boolean' }, 'false')).toBe(false);
    expect(coerce({ kind: 'boolean' }, 'yes')).toBeUndefined();
    expect(coerce({ kind: 'text' }, 'medium')).toBe('medium');
    expect(coerce({ kind: 'url' }, '')).toBeUndefined();
  });
});

describe('isRedactedUrl', () => {
  it("matches the API's write-only URL forms only", () => {
    expect(isRedactedUrl('https://hooks.example.test/…')).toBe(true);
    expect(isRedactedUrl('http://127.0.0.1:8080/…')).toBe(true);
    expect(isRedactedUrl('an invalid URL')).toBe(true);
    expect(isRedactedUrl('https://hooks.example.test/')).toBe(false);
    expect(isRedactedUrl('https://hooks.example.test/t0k3n')).toBe(false);
    expect(isRedactedUrl('https://hooks.example.test/a/…')).toBe(false);
    expect(isRedactedUrl(undefined)).toBe(false);
    expect(isRedactedUrl(3)).toBe(false);
  });
});

describe('clientIssue', () => {
  it('reports Required, bounds and enum membership', () => {
    const url = field('core:notify-webhook', 'url');
    expect(clientIssue(url, undefined)).toBe('Required');
    expect(clientIssue(url, 'https://example.test/hook')).toBeNull();
    const codec = field('core:encode-video', 'codec');
    expect(clientIssue(codec, undefined)).toBeNull();
    expect(clientIssue(codec, 'vp9')).toBe('Must be one of: hevc, h264, av1');
    expect(clientIssue(codec, 'av1')).toBeNull();
    const quality = field('core:encode-video', 'quality');
    expect(clientIssue(quality, -1)).toBe('Must be at least 0');
    expect(clientIssue(quality, 64)).toBe('Must be at most 63');
    expect(clientIssue(quality, 30)).toBeNull();
    const targets: FieldDef = {
      key: 'targets',
      label: 'Targets',
      unit: null,
      required: false,
      default: undefined,
      spec: { kind: 'enum-list', options: ['tv', 'phone'] },
      schema: {},
    };
    expect(clientIssue(targets, ['tv', 'watch'])).toBe('Must be one of: tv, phone');
    expect(clientIssue(targets, ['tv'])).toBeNull();
  });
});

describe('onNodeControlKeys', () => {
  it('encode-video quality → number, size-gate minSavingPercent → number, keep-languages languages → summary', () => {
    expect(onNodeControlKeys(def('core:encode-video'))).toEqual([
      { key: 'quality', control: 'number' },
      { key: 'bitrateKbps', control: 'number' },
    ]);
    expect(onNodeControlKeys(def('core:size-gate'))).toEqual([
      { key: 'minSavingPercent', control: 'number' },
    ]);
    expect(onNodeControlKeys(def('core:keep-languages'))).toEqual([
      { key: 'languages', control: 'summary' },
    ]);
    expect(onNodeControlKeys(def('core:remux'))).toEqual([]);
    expect(onNodeControlKeys(def('core:input-library'))).toEqual([
      { key: 'libraryId', control: 'library' },
    ]);
    expect(onNodeControlKeys(def('core:set-default-track'))).toEqual([
      { key: 'audioLanguages', control: 'first-language' },
    ]);
    expect(onNodeControlKeys(def('core:reorder-tracks'))).toEqual([
      { key: 'languages', control: 'summary' },
    ]);
  });

  it('a ≤ 5-option enum becomes a select; unknown keys and wide enums are summaries', () => {
    const base = def('core:remux');
    const info: NodeInfo = {
      ...base,
      onNodeSettings: ['container', 'missing'],
    };
    expect(onNodeControlKeys(info)).toEqual([
      { key: 'container', control: 'select' },
      { key: 'missing', control: 'summary' },
    ]);
  });
});

describe('x-transcoda kinds (plugin settings)', () => {
  it('secret → password, url → text with url input mode, path-mappings, insecure-tls → a boolean with help', () => {
    expect(specFor({ type: 'string', format: 'password', 'x-transcoda': 'secret' })).toEqual({
      kind: 'password',
    });
    // The marker wins over the plain `format: 'uri'` reading.
    expect(specFor({ type: 'string', format: 'uri', 'x-transcoda': 'url' })).toEqual({
      kind: 'text',
      inputMode: 'url',
    });
    expect(
      specFor({ type: 'array', items: { type: 'object' }, 'x-transcoda': 'path-mappings' }),
    ).toEqual({ kind: 'path-mappings' });
    expect(specFor({ type: 'boolean', 'x-transcoda': 'insecure-tls' })).toEqual({
      kind: 'boolean',
      help: 'Accept self-signed certificates for this service',
    });
  });

  it('an unknown marker falls back to the type-based reading', () => {
    expect(specFor({ type: 'string', 'x-transcoda': 'other' })).toEqual({ kind: 'text' });
  });
});
