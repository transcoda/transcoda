import { matchesGlob } from 'node:path';
import { defineNode } from '@transcoda/sdk';
import { isPicture } from '@transcoda/shared';
import { z } from 'zod';
import { filePort, LanguageCodeSchema, languageInput, passElse } from './common.ts';
import { list, matchesLanguage, tag } from './stream-rules.ts';

const MB = 1024 * 1024;
const DAY_MS = 86_400_000;

const round1 = (n: number) => Math.round(n * 10) / 10;
const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
const flag = (name: string, value: boolean | undefined) =>
  value === undefined ? [] : [value ? name : `not ${name}`];

const condition = { version: 1, kind: 'condition', outputs: passElse } as const;

export const videoIs = defineNode({
  ...condition,
  type: 'core:video-is',
  title: 'Video is',
  description: 'Branches on the video stream: codec, height and bitrate.',
  icon: 'film',
  inputs: [filePort],
  settings: z.object({
    // The marker gives the editor its grouped video codec picker (ffmpeg ids stay the value).
    codecs: z
      .array(z.string())
      .default([])
      .describe('Codecs')
      .meta({ 'x-transcoda': 'video-codecs' }),
    minHeight: z.number().int().positive().optional().describe('Minimum height (px)'),
    maxHeight: z.number().int().positive().optional().describe('Maximum height (px)'),
    maxBitrateKbps: z.number().int().positive().optional().describe('Maximum bitrate (kb/s)'),
  }),
  async decide(ctx, settings) {
    const video = ctx.probe.streams.find(
      (s) => s.type === 'video' && !isPicture(s, ctx.probe.streams),
    );
    if (!video) return { port: 'else', reason: 'no video stream', findings: {} };
    const { codec, height } = video;
    // mkv streams rarely carry a bitrate; fall back to the container's.
    const bitrate = video.bitrateKbps ?? ctx.probe.bitrateKbps;
    const bitrateKbps = bitrate === null ? null : Math.round(bitrate);
    const findings = { codec, height, bitrateKbps };
    const wanted: string[] = [];
    if (settings.codecs.length > 0 && !settings.codecs.includes(codec)) {
      wanted.push(settings.codecs.join(' or '));
    }
    if (settings.minHeight !== undefined && (height === null || height < settings.minHeight)) {
      wanted.push(`at least ${settings.minHeight}p`);
    }
    if (settings.maxHeight !== undefined && (height === null || height > settings.maxHeight)) {
      wanted.push(`at most ${settings.maxHeight}p`);
    }
    const tooFast =
      settings.maxBitrateKbps !== undefined &&
      (bitrateKbps === null || bitrateKbps > settings.maxBitrateKbps);
    if (tooFast) wanted.push(`at most ${settings.maxBitrateKbps} kbps`);
    const bitrateText = bitrateKbps === null ? 'bitrate unknown' : `${bitrateKbps} kbps`;
    const what = [
      `video is ${codec}${height === null ? '' : ` ${height}p`}`,
      ...(tooFast ? [bitrateText] : []),
    ].join(', ');
    if (wanted.length === 0) return { port: 'pass', reason: `${what} → yes`, findings };
    return { port: 'else', reason: `${what}, wanted ${wanted[0]} → no`, findings };
  },
});

export const fileMatches = defineNode({
  ...condition,
  type: 'core:file-matches',
  title: 'File matches',
  description: 'Branches on file size, age and path.',
  icon: 'file-search',
  inputs: [filePort],
  settings: z.object({
    minSizeMb: z.number().min(0).optional().describe('Minimum size (MB)'),
    maxSizeMb: z.number().min(0).optional().describe('Maximum size (MB)'),
    olderThanDays: z.number().int().min(0).optional().describe('Older than (days)'),
    pathGlob: z.string().optional().describe('Path glob'),
  }),
  async decide(ctx, settings) {
    const { path } = ctx.file;
    // Compared as reported: rounded to one decimal.
    const sizeMb = round1(ctx.file.sizeBytes / MB);
    const ageDays = round1((ctx.now - Date.parse(ctx.file.mtime)) / DAY_MS);
    const findings = { sizeMb, ageDays, path };
    const sizeText = `${sizeMb.toFixed(1)} MB`;
    const ageText = `${days(ageDays)} old`;
    const failure = (() => {
      if (settings.minSizeMb !== undefined && sizeMb < settings.minSizeMb) {
        return `size ${sizeText}, wanted at least ${settings.minSizeMb} MB`;
      }
      if (settings.maxSizeMb !== undefined && sizeMb > settings.maxSizeMb) {
        return `size ${sizeText}, wanted at most ${settings.maxSizeMb} MB`;
      }
      if (settings.olderThanDays !== undefined && !(ageDays > settings.olderThanDays)) {
        return `${ageText}, wanted older than ${days(settings.olderThanDays)}`;
      }
      if (settings.pathGlob !== undefined && !matchesGlob(path, settings.pathGlob)) {
        return `path does not match ${settings.pathGlob}`;
      }
      return null;
    })();
    if (failure !== null) return { port: 'else', reason: `${failure} → no`, findings };
    return { port: 'pass', reason: `file matches (${sizeText}, ${ageText}) → yes`, findings };
  },
});

export const hasStream = defineNode({
  ...condition,
  type: 'core:has-stream',
  title: 'Has stream',
  description: 'Branches on whether the file has a matching audio or subtitle stream.',
  icon: 'audio-lines',
  inputs: [filePort, languageInput],
  settings: z.object({
    streamType: z.enum(['audio', 'subtitle']).default('audio').describe('Stream type'),
    language: LanguageCodeSchema.optional().describe('Language'),
    codec: z.string().optional().describe('Codec'),
    isDefault: z.boolean().optional().describe('Is default'),
    isForced: z.boolean().optional().describe('Is forced'),
  }),
  // The optional language data input is not used by this node in M1.
  async decide(ctx, settings) {
    const streams = ctx.probe.streams.filter((s) => s.type === settings.streamType);
    const matching = streams.filter(
      (s) =>
        (settings.language === undefined || matchesLanguage(s, [settings.language])) &&
        (settings.codec === undefined || s.codec === settings.codec) &&
        (settings.isDefault === undefined || s.default === settings.isDefault) &&
        (settings.isForced === undefined || s.forced === settings.isForced),
    );
    // The criteria other than the language, e.g. `codec dts, forced`.
    const criteria = [
      ...(settings.codec === undefined ? [] : [`codec ${settings.codec}`]),
      ...flag('default', settings.isDefault),
      ...flag('forced', settings.isForced),
    ];
    const all = [
      ...(settings.language === undefined ? [] : [`language ${settings.language}`]),
      ...criteria,
    ];
    const languages = [...new Set(matching.map(tag))].join(', ');
    const found =
      matching.length > 0
        ? `has ${languages}${criteria.length > 0 ? ` (${criteria.join(', ')})` : ''}`
        : `none${all.length > 0 ? ` matching ${all.join(', ')}` : ''}`;
    return {
      port: matching.length > 0 ? 'pass' : 'else',
      reason: `${settings.streamType}: ${list(streams.map(tag))} → ${found}`,
      findings: { matching: matching.map((s) => s.index) },
    };
  },
});
