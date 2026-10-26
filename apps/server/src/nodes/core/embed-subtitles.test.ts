import {
  type AnyNodeDefinition,
  type BuildContext,
  type BuildModel,
  corePluginContext,
  type ProbeResult,
} from '@transcoda/sdk';
import { describe, expect, it } from 'vitest';
import { modelFromProbe } from '../../engine/build-model.ts';
import { capsOf, fileOf, probeOf } from '../../engine/test-helpers.ts';
import { keepLanguages, remux, setDefaultTrack } from './actions.ts';
import { createEmbedSidecarSubtitles, embedSidecarSubtitles } from './embed-subtitles.ts';
import type { SidecarCandidate, SidecarName, SidecarSkip, SidecarSource } from './sidecars.ts';

const DIR = '/lib/Show';
const VIDEO = `${DIR}/Show.mkv`;

function candidate(file: string, n: Partial<SidecarName>): SidecarCandidate {
  return {
    path: `${DIR}/${file}`,
    file,
    name: {
      language: null,
      forced: false,
      sdh: false,
      default: false,
      title: null,
      codec: 'subrip',
      ...n,
    },
  };
}

function fakeSource(found: SidecarCandidate[], skipped: SidecarSkip[] = []): SidecarSource {
  return {
    async find(videoPath) {
      expect(videoPath).toBe(VIDEO);
      return { found, skipped };
    },
  };
}

const probe = probeOf([
  { type: 'video', codec: 'h264', default: true },
  { type: 'audio', codec: 'aac', language: 'eng', default: true },
]);

function ctx(p: ProbeResult = probe, model: BuildModel = modelFromProbe(p)): BuildContext {
  return {
    probe: p,
    file: fileOf(VIDEO, p.sizeBytes),
    data: {},
    capabilities: capsOf(['libx264', 'aac']),
    log: () => {},
    plugin: corePluginContext(),
    model,
  };
}

function build(def: AnyNodeDefinition, c: BuildContext, raw: Record<string, unknown> = {}) {
  if (!def.build) throw new Error(`${def.type} has no build`);
  return def.build(c, def.settings.parse(raw));
}

const de = candidate('Show.de.forced.srt', { language: 'deu', forced: true });
const en = candidate('Show.en.srt', { language: 'eng' });

describe('core:embed-sidecar-subtitles', () => {
  it('has the agreed settings defaults and metadata', () => {
    expect(embedSidecarSubtitles.settings.parse({})).toEqual({
      languages: [],
      afterEmbed: 'recycle',
      skipExisting: true,
    });
    expect(embedSidecarSubtitles).toMatchObject({
      type: 'core:embed-sidecar-subtitles',
      version: 1,
      kind: 'action',
      icon: 'captions',
      title: 'Embed subtitle files',
      onNodeSettings: ['languages'],
    });
  });

  it('mkv: embeds each file as a kept subtitle stream from its own input, after every stream', async () => {
    const node = createEmbedSidecarSubtitles(fakeSource([de, en]));
    const r = await build(node, ctx());
    expect(r.model.extraInputs).toEqual([
      {
        path: `${DIR}/Show.de.forced.srt`,
        kind: 'subtitle',
        afterReplace: 'recycle',
        codec: 'subrip',
        label: { file: 'Show.de.forced.srt', language: 'deu', forced: true, sdh: false },
      },
      {
        path: `${DIR}/Show.en.srt`,
        kind: 'subtitle',
        afterReplace: 'recycle',
        codec: 'subrip',
        label: { file: 'Show.en.srt', language: 'eng', forced: false, sdh: false },
      },
    ]);
    const extra = r.model.streams.filter((s) => (s.input ?? 0) > 0);
    expect(extra).toEqual([
      expect.objectContaining({
        sourceIndex: -1,
        input: 1,
        type: 'subtitle',
        keep: true,
        mode: 'copy',
        codec: 'subrip',
        encoder: null,
        language: 'deu',
        title: null,
        default: false,
        forced: true,
        attachedPic: false,
        dispositions: [],
        order: 2,
      }),
      expect.objectContaining({
        sourceIndex: -2,
        input: 2,
        language: 'eng',
        forced: false,
        order: 3,
      }),
    ]);
    expect(r.reason).toBe('embed Show.de.forced.srt (deu, forced), Show.en.srt (eng)');
    expect(r.findings).toEqual({
      embedded: ['Show.de.forced.srt', 'Show.en.srt'],
      skipped: [],
    });
  });

  it('copies afterEmbed into each extra input and the SDH flag into the dispositions', async () => {
    const sdh = candidate('Show.en.sdh.srt', { language: 'eng', sdh: true, title: 'Full' });
    const node = createEmbedSidecarSubtitles(fakeSource([sdh]));
    const r = await build(node, ctx(), { afterEmbed: 'keep' });
    expect(r.model.extraInputs?.[0]).toMatchObject({
      afterReplace: 'keep',
      label: { sdh: true },
    });
    expect(r.model.streams.at(-1)).toMatchObject({
      dispositions: ['hearing_impaired'],
      title: 'Full',
    });
    expect(r.reason).toBe('embed Show.en.sdh.srt (eng, sdh)');
  });

  it('does not change the incoming model', async () => {
    const model = modelFromProbe(probe);
    const before = structuredClone(model);
    await build(createEmbedSidecarSubtitles(fakeSource([de])), ctx(probe, model));
    expect(model).toEqual(before);
  });

  it('mp4: text files convert to mov_text', async () => {
    const mp4 = { ...modelFromProbe(probe), container: 'mp4' as const };
    const r = await build(createEmbedSidecarSubtitles(fakeSource([en])), ctx(probe, mp4));
    expect(r.model.streams.at(-1)).toMatchObject({ mode: 'convert', codec: 'mov_text' });
    expect(r.model.extraInputs?.[0]?.codec).toBe('subrip');
  });

  it('mp4 + .sup: skipped, the model is unchanged', async () => {
    const sup = candidate('Show.en.sup', { language: 'eng', codec: 'hdmv_pgs_subtitle' });
    const mp4 = { ...modelFromProbe(probe), container: 'mp4' as const };
    const r = await build(createEmbedSidecarSubtitles(fakeSource([sup])), ctx(probe, mp4));
    expect(r.model).toEqual(mp4);
    expect(r.reason).toBe(
      'no subtitle file embedded; skipped Show.en.sup: mp4 cannot hold PGS (.sup) subtitles',
    );
    expect(r.findings).toEqual({
      embedded: [],
      skipped: [{ file: 'Show.en.sup', reason: 'mp4 cannot hold PGS (.sup) subtitles' }],
    });
  });

  it('languages: only the listed languages; untagged files are skipped', async () => {
    const fr = candidate('Show.fr.srt', { language: 'fra' });
    const none = candidate('Show.srt', {});
    const r = await build(createEmbedSidecarSubtitles(fakeSource([de, en, fr, none])), ctx(), {
      languages: ['en'],
    });
    expect(r.model.extraInputs?.map((i) => i.label.file)).toEqual(['Show.en.srt']);
    expect(r.reason).toBe(
      'embed Show.en.srt (eng); skipped Show.de.forced.srt: language deu not selected; skipped Show.fr.srt: language fra not selected; skipped Show.srt: language und not selected',
    );
  });

  it('skipExisting: a file matching a kept subtitle of the video is skipped; off embeds it', async () => {
    const withSubs = probeOf([
      { type: 'video', codec: 'h264', default: true },
      { type: 'subtitle', codec: 'subrip', language: 'eng' },
      { type: 'subtitle', codec: 'subrip', language: 'ger', forced: true },
    ]);
    const sdh = candidate('Show.en.sdh.srt', { language: 'eng', sdh: true });
    const node = createEmbedSidecarSubtitles(fakeSource([de, en, sdh]));
    const r = await build(node, ctx(withSubs));
    expect(r.model.extraInputs?.map((i) => i.label.file)).toEqual(['Show.en.sdh.srt']);
    expect(r.findings).toMatchObject({
      skipped: [
        { file: 'Show.de.forced.srt', reason: 'already has deu forced' },
        { file: 'Show.en.srt', reason: 'already has eng' },
      ],
    });
    const off = await build(node, ctx(withSubs), { skipExisting: false });
    expect(off.model.extraInputs).toHaveLength(3);
  });

  it('skipExisting ignores a dropped source subtitle', async () => {
    const withSubs = probeOf([
      { type: 'video', codec: 'h264', default: true },
      { type: 'subtitle', codec: 'subrip', language: 'eng' },
    ]);
    const model = modelFromProbe(withSubs);
    (model.streams[1] as { keep: boolean }).keep = false;
    const r = await build(createEmbedSidecarSubtitles(fakeSource([en])), ctx(withSubs, model));
    expect(r.model.extraInputs).toHaveLength(1);
  });

  it('two files with the same language and flags: the second is skipped', async () => {
    const en2 = candidate('Show.en.vtt', { language: 'eng', codec: 'webvtt' });
    const r = await build(createEmbedSidecarSubtitles(fakeSource([en, en2])), ctx());
    expect(r.model.extraInputs?.map((i) => i.label.file)).toEqual(['Show.en.srt']);
    expect(r.findings).toMatchObject({
      skipped: [{ file: 'Show.en.vtt', reason: 'same as Show.en.srt' }],
    });
  });

  it("reports discovery's skips, and says so when no file is next to the video", async () => {
    const r = await build(
      createEmbedSidecarSubtitles(fakeSource([en], [{ file: 'Show.it.srt', reason: 'empty' }])),
      ctx(),
    );
    expect(r.reason).toBe('embed Show.en.srt (eng); skipped Show.it.srt: empty');
    const none = await build(createEmbedSidecarSubtitles(fakeSource([])), ctx());
    expect(none.reason).toBe('no subtitle files next to the video');
    expect(none.model).toEqual(modelFromProbe(probe));
    expect(none.model.extraInputs).toBeUndefined();
  });

  it('a second embed node does not embed the files the first one already added', async () => {
    const node = createEmbedSidecarSubtitles(fakeSource([de, en]));
    const first = await build(node, ctx());
    const second = await build(node, ctx(probe, first.model));
    expect(second.model.extraInputs).toHaveLength(2);
    expect(second.findings).toEqual({
      embedded: [],
      skipped: [
        { file: 'Show.de.forced.srt', reason: 'already has deu forced' },
        { file: 'Show.en.srt', reason: 'already has eng' },
      ],
    });
  });

  it('the same file is never an input twice, even with skipExisting off', async () => {
    const node = createEmbedSidecarSubtitles(fakeSource([en]));
    const first = await build(node, ctx(), { skipExisting: false });
    const second = await build(node, ctx(probe, first.model), { skipExisting: false });
    expect(second.model.extraInputs).toHaveLength(1);
    expect(second.findings).toMatchObject({
      skipped: [{ file: 'Show.en.srt', reason: 'already embedded by an earlier node' }],
    });
  });

  it('appends to extra inputs an earlier node added', async () => {
    const first = await build(createEmbedSidecarSubtitles(fakeSource([de])), ctx());
    const second = await build(
      createEmbedSidecarSubtitles(fakeSource([en])),
      ctx(probe, first.model),
    );
    expect(second.model.extraInputs?.map((i) => i.label.file)).toEqual([
      'Show.de.forced.srt',
      'Show.en.srt',
    ]);
    expect(second.model.streams.at(-1)).toMatchObject({ sourceIndex: -2, input: 2, order: 3 });
  });
});

describe('later core nodes name the subtitle file, not #-1', () => {
  it('remux to mp4 names the converted and the dropped file', async () => {
    const sup = candidate('Show.fr.sup', { language: 'fra', codec: 'hdmv_pgs_subtitle' });
    const embedded = await build(createEmbedSidecarSubtitles(fakeSource([en, sup])), ctx());
    const r = await build(remux, ctx(probe, embedded.model), {
      container: 'mp4',
      subtitleConversion: 'drop-incompatible',
    });
    expect(r.reason).toBe(
      "container mkv → mp4; subtitles Show.en.srt → mov_text; dropped (container can't hold it): Show.fr.sup hdmv_pgs_subtitle",
    );
    expect(r.reason).not.toContain('#-');
    await expect(build(remux, ctx(probe, embedded.model), { container: 'mp4' })).rejects.toThrow(
      'mp4 cannot carry these subtitles: Show.fr.sup hdmv_pgs_subtitle (no OCR; use drop-incompatible)',
    );
  });

  it('set-default-track and keep-languages name the file', async () => {
    const embedded = await build(createEmbedSidecarSubtitles(fakeSource([de, en])), ctx());
    const d = await build(setDefaultTrack, ctx(probe, embedded.model), {
      subtitleLanguages: ['de'],
    });
    expect(d.reason).toBe('default audio: en (#1); default subtitle: de (Show.de.forced.srt)');
    const withDefault = {
      ...embedded.model,
      streams: embedded.model.streams.map((s) =>
        s.sourceIndex === -2 ? { ...s, default: true } : s,
      ),
    };
    const k = await build(keepLanguages, ctx(probe, withDefault), {
      languages: ['de'],
      keepOriginal: false,
    });
    expect(k.reason).toContain('default subtitle now de (Show.de.forced.srt)');
    expect(k.reason).not.toContain('#-');
  });
});
