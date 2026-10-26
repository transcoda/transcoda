import type { ExtraInput, StreamPlan } from '@transcoda/sdk';
import { defineNode } from '@transcoda/sdk';
import { normalizeLanguage } from '@transcoda/shared';
import { z } from 'zod';
import { nodeFsOps } from '../../engine/fs-ops.ts';
import { filePort, LanguageCodeSchema } from './common.ts';
import { fsSidecarSource, readHead, SIDECAR_EXTENSIONS, type SidecarSource } from './sidecars.ts';
import { copyModel, matchesLanguage } from './stream-rules.ts';

/** What makes two subtitle tracks the same for `skipExisting` and duplicates. */
const keyOf = (language: string | null, forced: boolean, sdh: boolean) =>
  `${normalizeLanguage(language) ?? 'und'}|${forced}|${sdh}`;

/** `deu forced sdh`, the words reasons use for a key. */
const keyWords = (language: string | null, forced: boolean, sdh: boolean) =>
  [language ?? 'und', ...(forced ? ['forced'] : []), ...(sdh ? ['sdh'] : [])].join(' ');

/** The embed node over a sidecar source (injected so tests need no files). */
export function createEmbedSidecarSubtitles(source: SidecarSource) {
  return defineNode({
    type: 'core:embed-sidecar-subtitles',
    version: 1,
    kind: 'action',
    inputs: [filePort],
    outputs: [filePort],
    title: 'Embed subtitle files',
    description:
      'Adds the subtitle files next to the video (.srt, .ass, .ssa, .vtt, .sup) as subtitle tracks, for example the ones Bazarr downloads.',
    icon: 'captions',
    onNodeSettings: ['languages'],
    settings: z.object({
      languages: z
        .array(LanguageCodeSchema)
        .default([])
        .describe('Languages to embed (empty: all)'),
      afterEmbed: z
        .enum(['keep', 'recycle'])
        .default('recycle')
        .describe(
          'After the file is replaced, move the subtitle files to the recycle folder or keep them',
        ),
      skipExisting: z
        .boolean()
        .default(true)
        .describe(
          'Skip a file whose language, forced and SDH flags match a track the video already has',
        ),
    }),
    async build(ctx, s) {
      const { found, skipped: discoverySkips } = await source.find(ctx.file.path);
      if (found.length === 0 && discoverySkips.length === 0) {
        return {
          model: ctx.model,
          reason: 'no subtitle files next to the video',
          findings: { embedded: [], skipped: [] },
        };
      }
      const model = copyModel(ctx.model);
      const extraInputs: ExtraInput[] = [...(ctx.model.extraInputs ?? [])];
      // Kept subtitles the output already has: the source's and those an earlier embed node added.
      const existing = new Set(
        model.streams
          .filter((p) => p.keep && p.type === 'subtitle')
          .map((p) => keyOf(p.language, p.forced, p.dispositions.includes('hearing_impaired'))),
      );
      // A file is never an input twice, whatever skipExisting says.
      const inputPaths = new Set(extraInputs.map((e) => e.path));
      const taken = new Map<string, string>();
      let order = Math.max(-1, ...model.streams.map((p) => p.order)) + 1;
      const embedded: string[] = [];
      const embeddedText: string[] = [];
      const skipped = [...discoverySkips];
      for (const c of found) {
        const { language, forced, sdh, codec } = c.name;
        const key = keyOf(language, forced, sdh);
        const skip = (reason: string) => skipped.push({ file: c.file, reason });
        if (s.languages.length > 0 && !matchesLanguage({ language }, s.languages)) {
          skip(`language ${language ?? 'und'} not selected`);
          continue;
        }
        if (s.skipExisting && existing.has(key)) {
          skip(`already has ${keyWords(language, forced, sdh)}`);
          continue;
        }
        if (inputPaths.has(c.path)) {
          skip('already embedded by an earlier node');
          continue;
        }
        const earlier = taken.get(key);
        if (earlier !== undefined) {
          skip(`same as ${earlier}`);
          continue;
        }
        const mp4 = model.container === 'mp4';
        if (mp4 && codec === SIDECAR_EXTENSIONS.sup) {
          skip('mp4 cannot hold PGS (.sup) subtitles');
          continue;
        }
        taken.set(key, c.file);
        extraInputs.push({
          path: c.path,
          kind: 'subtitle',
          afterReplace: s.afterEmbed,
          codec,
          label: { file: c.file, language, forced, sdh },
        });
        const n = extraInputs.length;
        const stream: StreamPlan = {
          sourceIndex: -n,
          input: n,
          type: 'subtitle',
          keep: true,
          mode: mp4 ? 'convert' : 'copy',
          codec: mp4 ? 'mov_text' : codec,
          encoder: null,
          quality: null,
          preset: null,
          bitrateKbps: null,
          channels: null,
          profile: null,
          pixelFormat: null,
          language,
          title: c.name.title,
          default: c.name.default,
          forced,
          attachedPic: false,
          dispositions: sdh ? ['hearing_impaired'] : [],
          order: order++,
        };
        model.streams.push(stream);
        embedded.push(c.file);
        const flags = [language ?? 'und', ...(forced ? ['forced'] : []), ...(sdh ? ['sdh'] : [])];
        embeddedText.push(`${c.file} (${flags.join(', ')})`);
      }
      const pieces = [
        embedded.length > 0 ? `embed ${embeddedText.join(', ')}` : 'no subtitle file embedded',
        ...skipped.map((k) => `skipped ${k.file}: ${k.reason}`),
      ];
      return {
        model: embedded.length > 0 ? { ...model, extraInputs } : ctx.model,
        reason: pieces.join('; '),
        findings: { embedded, skipped: skipped.map((k) => ({ file: k.file, reason: k.reason })) },
      };
    },
  });
}

/** The registered node: sidecars found on the real file system. */
export const embedSidecarSubtitles = createEmbedSidecarSubtitles(
  fsSidecarSource(nodeFsOps, readHead),
);
