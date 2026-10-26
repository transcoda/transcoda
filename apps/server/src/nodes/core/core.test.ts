import { nodeMetadata, parseSettings } from '@transcoda/sdk';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { coreNodes } from './index.ts';

const find = (type: string) => {
  const def = coreNodes.find((d) => d.type === type);
  if (!def) throw new Error(`missing ${type}`);
  return def;
};

describe('core nodes', () => {
  it.each(coreNodes.map((d) => [d.type, d] as const))('%s has consistent metadata', (_, def) => {
    expect(def.type).toMatch(/^core:[a-z-]+$/);
    const versions: Record<string, number> = {
      'core:size-gate': 2,
      'core:encode-video': 2,
      'core:encode-audio': 3,
    };
    expect(def.version).toBe(versions[def.type] ?? 1);
    if (def.kind === 'trigger') expect(def.inputs).toEqual([]);
    if (def.kind === 'condition') {
      // The stored ids never change; people read Yes and No.
      expect(def.outputs.map((p) => p.id)).toEqual(['pass', 'else']);
      expect(def.outputs.map((p) => p.label)).toEqual(['Yes', 'No']);
    }
    const schema = nodeMetadata(def).settingsSchema as {
      type: string;
      properties?: Record<string, { description?: string }>;
    };
    expect(schema.type).toBe('object');
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      expect(prop.description, `${def.type}.${key}`).toEqual(expect.any(String));
    }
    const hooks = {
      decide: def.decide !== undefined,
      build: def.build !== undefined,
      finish: def.finish !== undefined,
      data: def.data !== undefined,
    };
    expect(hooks).toEqual({
      decide: def.kind === 'condition',
      build: def.kind === 'action' && def.type !== 'core:run-subworkflow',
      finish: def.kind === 'finish',
      data: false,
    });
  });

  it('embed-sidecar-subtitles is a version 1 action with a build hook, after remux', () => {
    const def = find('core:embed-sidecar-subtitles');
    expect([def.version, def.kind, def.build !== undefined]).toEqual([1, 'action', true]);
    const types = coreNodes.map((d) => d.type);
    expect(types.indexOf('core:embed-sidecar-subtitles')).toBe(types.indexOf('core:remux') + 1);
  });

  it('has-stream accepts defaults and rejects a bad language code', () => {
    expect(parseSettings(find('core:has-stream'), {})).toMatchObject({
      ok: true,
      value: { streamType: 'audio' },
    });
    expect(parseSettings(find('core:has-stream'), { language: 'english' }).ok).toBe(false);
  });

  it('registers the full catalogue', () => {
    expect(coreNodes.map((d) => d.type).sort()).toEqual([
      'core:cover-attachments',
      'core:embed-sidecar-subtitles',
      'core:encode-audio',
      'core:encode-video',
      'core:file-matches',
      'core:has-stream',
      'core:input-library',
      'core:input-manual',
      'core:input-webhook',
      'core:keep-languages',
      'core:move-copy',
      'core:notify-webhook',
      'core:remove-duplicate-audio',
      'core:remux',
      'core:reorder-tracks',
      'core:replace-original',
      'core:run-subworkflow',
      'core:set-default-track',
      'core:size-gate',
      'core:subworkflow-end',
      'core:subworkflow-start',
      'core:video-is',
    ]);
  });

  it('move-copy needs outputRoot; keep-languages defaults', () => {
    expect(parseSettings(find('core:move-copy'), {})).toMatchObject({
      ok: false,
      issues: [{ path: 'outputRoot', missing: true }],
    });
    expect(parseSettings(find('core:keep-languages'), {})).toEqual({
      ok: true,
      value: { languages: ['en'], keepOriginal: true, keepUntagged: true },
    });
  });

  it('core:replace-original has no verify setting; recycleFolder description says "unset"', () => {
    const replaceOriginal = find('core:replace-original');
    const shape = (replaceOriginal.settings as z.ZodObject).shape;
    expect(Object.keys(shape)).toEqual(['recycleFolder']);
    expect(shape.recycleFolder?.description).toBe(
      'Recycle folder for the original; unset means the library default',
    );
  });

  it('encode-video, encode-audio and remux default targets to [] and accept target skip rules', () => {
    for (const type of ['core:encode-video', 'core:encode-audio', 'core:remux']) {
      expect(parseSettings(find(type), {}), type).toMatchObject({
        ok: true,
        value: { targets: [] },
      });
    }
    expect(parseSettings(find('core:encode-video'), {})).toMatchObject({
      ok: true,
      value: { skipIf: 'already-target-codec', encoder: 'auto' },
    });
    expect(
      parseSettings(find('core:encode-video'), {
        skipIf: 'plays-on-all-targets',
        targets: ['android-tv', 'chrome'],
      }),
    ).toMatchObject({ ok: true, value: { skipIf: 'plays-on-all-targets' } });
    expect(parseSettings(find('core:encode-audio'), {})).toMatchObject({
      ok: true,
      value: { whenUnsupported: 'add-track' },
    });
    expect(parseSettings(find('core:remux'), { targets: ['roku'] }).ok).toBe(false);
  });

  it('encode-video and encode-audio cap at the source bitrate by default; video has rate control', () => {
    expect(parseSettings(find('core:encode-video'), {})).toMatchObject({
      ok: true,
      value: { rateControl: 'quality', quality: 24, bitrateKbps: 6000, neverIncreaseBitrate: true },
    });
    expect(parseSettings(find('core:encode-video'), { rateControl: 'crf' }).ok).toBe(false);
    expect(parseSettings(find('core:encode-video'), { bitrateKbps: 99 }).ok).toBe(false);
    expect(parseSettings(find('core:encode-audio'), {})).toMatchObject({
      ok: true,
      value: { neverIncreaseBitrate: true },
    });
  });

  it.each(['core:encode-video', 'core:encode-audio'])(
    '%s v1 → v2 keeps an existing node encoding as before (cap off)',
    (type) => {
      const [step] = find(type).migrations ?? [];
      expect(step).toMatchObject({ from: 1, to: 2, risk: 'safe' });
      expect(step?.migrate({ quality: 20 })).toEqual({ quality: 20, neverIncreaseBitrate: false });
      expect(step?.migrate({})).toEqual({ neverIncreaseBitrate: false });
      // A node that already says (a hand-edited or imported v1 graph) keeps its choice.
      expect(step?.migrate({ neverIncreaseBitrate: true })).toEqual({ neverIncreaseBitrate: true });
      const migrated = step?.migrate({}) ?? null;
      expect(parseSettings(find(type), migrated)).toMatchObject({
        ok: true,
        value: { neverIncreaseBitrate: false },
      });
    },
  );

  it('encode-video has one migration; encode-audio v2 → v3 keeps existing titles (updating off)', () => {
    expect(find('core:encode-video').migrations).toHaveLength(1);
    const steps = find('core:encode-audio').migrations ?? [];
    expect(steps.map((m) => [m.from, m.to, m.risk])).toEqual([
      [1, 2, 'safe'],
      [2, 3, 'safe'],
    ]);
    const step = steps[1];
    expect(step?.migrate({ mode: 'reencode' })).toEqual({ mode: 'reencode', updateTitles: false });
    expect(step?.migrate({ updateTitles: true })).toEqual({ updateTitles: true });
    expect(parseSettings(find('core:encode-audio'), step?.migrate({}) ?? null)).toMatchObject({
      ok: true,
      value: { updateTitles: false },
    });
    // A new node updates titles.
    expect(parseSettings(find('core:encode-audio'), {})).toMatchObject({
      ok: true,
      value: { updateTitles: true },
    });
  });

  it('encode-video shows quality only in quality mode and the target bitrate only in bitrate mode', () => {
    const props = (
      nodeMetadata(find('core:encode-video')).settingsSchema as {
        properties: Record<string, Record<string, unknown>>;
      }
    ).properties;
    expect(props.quality?.['x-transcoda-show-when']).toEqual({ rateControl: 'quality' });
    expect(props.bitrateKbps?.['x-transcoda-show-when']).toEqual({ rateControl: 'bitrate' });
    expect(props.rateControl?.['x-transcoda-show-when']).toBeUndefined();
  });

  it('encode-audio requires the aac encoder and the pan filter', () => {
    expect(find('core:encode-audio').requires).toEqual({ encoders: ['aac'], filters: ['pan'] });
  });

  it('core:size-gate is version 2 with pass and else file outputs; v1 had one output "file"', () => {
    const def = find('core:size-gate');
    expect(def.version).toBe(2);
    expect(def.outputs).toEqual([
      { id: 'pass', label: 'Yes', type: 'file' },
      { id: 'else', label: 'No', type: 'file' },
    ]);
    expect(def.migrations).toMatchObject([{ from: 1, to: 2, risk: 'safe' }]);
    expect(def.migrations?.[0]?.renameOutputs).toEqual({ file: 'pass' });
    // settings are unchanged
    expect(def.migrations?.[0]?.migrate({ minSavingPercent: 15 })).toEqual({
      minSavingPercent: 15,
    });
  });

  it('the core finish nodes carry their phases', () => {
    const phases = Object.fromEntries(
      coreNodes.filter((d) => d.kind === 'finish').map((d) => [d.type, d.finishPhase]),
    );
    expect(phases).toEqual({
      'core:size-gate': 'gate',
      'core:replace-original': 'write',
      'core:move-copy': 'write',
      'core:notify-webhook': 'notify',
    });
  });
});

describe('N12 on-node settings', () => {
  it('only Library, Default audio, Quality and Size gate have on-node controls; the chips stay', () => {
    const onNode = Object.fromEntries(
      coreNodes
        .filter((d) => (d.onNodeSettings ?? []).length > 0)
        .map((d) => [d.type, d.onNodeSettings]),
    );
    expect(onNode).toEqual({
      'core:input-library': ['libraryId'],
      'core:set-default-track': ['audioLanguages'],
      'core:encode-video': ['quality', 'bitrateKbps'],
      'core:size-gate': ['minSavingPercent'],
      'core:keep-languages': ['languages'],
      'core:reorder-tracks': ['languages'],
      'core:embed-sidecar-subtitles': ['languages'],
    });
  });
});
