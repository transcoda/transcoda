// The TRANSCODA container tag with the real ffmpeg: renderArgs writes it into Matroska and MP4
// outputs, the probe reads it back (Matroska upper-cases tag names), a second workflow appends to
// the first one's entry, and verify still passes on the tagged outputs.
import { execFile, spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeExec } from '../capabilities/ffmpeg.ts';
import { fitToContainer, modelFromProbe, normalizeDefaults } from './build-model.ts';
import { tempDir, toolPaths } from './fixtures.ts';
import { probeFile } from './probe.ts';
import { renderArgs } from './render.ts';
import { nextTranscodaTag, parseTranscodaTag, transcodaTagOf } from './transcoda-tag.ts';
import { verifyOutput } from './verify.ts';

const execFileAsync = promisify(execFile);
const { ffmpegPath, ffprobePath } = toolPaths();
const exec = makeExec({ timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });

/** ffmpeg and ffprobe run, with libx264 and aac. */
function toolsAvailable(): boolean {
  const encoders = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  const probe = spawnSync(ffprobePath, ['-version'], { encoding: 'utf8' });
  return (
    encoders.status === 0 &&
    / libx264 /.test(encoders.stdout) &&
    / aac /.test(encoders.stdout) &&
    probe.status === 0
  );
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe.skipIf(!toolsAvailable())('the TRANSCODA tag, with real ffmpeg', () => {
  let base = '';
  let source = '';

  beforeAll(async () => {
    base = await tempDir('transcoda-tag-real-');
    source = join(base, 'sample.mkv');
    // 2 s of h264 testsrc2 and aac sine, mkv, with a title tag of its own.
    // biome-ignore format: flag/value pairs
    await execFileAsync(ffmpegPath, [
      '-nostdin', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac',
      '-metadata', 'title=Sample', source,
    ]);
  }, 60_000);
  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  /** Renders `input` into `container` as workflow `id@version` would, verifies and probes it. */
  async function pass(input: string, container: 'mkv' | 'mp4', id: string, version: number) {
    const probe = await probeFile(input, { ffprobePath, exec });
    const model = { ...modelFromProbe(probe), container };
    fitToContainer(model);
    // As the pipeline does: the output's default flags as verify expects them.
    normalizeDefaults(model, probe);
    const output = join(base, `${id.slice(0, 1)}${version}-${container}.${container}`);
    const transcodaTag = nextTranscodaTag(probe, id, version);
    await execFileAsync(ffmpegPath, renderArgs({ model, input, output, transcodaTag }));
    const verified = await verifyOutput({
      outputPath: output,
      sourcePath: input,
      model,
      sourceProbe: probe,
      ffmpegPath,
      ffprobePath,
      sampleSpots: 2,
    });
    // Every failure, not just `ok`, so a broken check says which one.
    expect(verified.ok ? [] : verified.failures).toEqual([]);
    return { output, probe: await probeFile(output, { ffprobePath, exec }) };
  }

  it('Matroska keeps the tag (any case) and the other format tags; verify passes', async () => {
    const { probe } = await pass(source, 'mkv', A, 3);
    expect(transcodaTagOf(probe)).toBe(`${A}@3`);
    const tags = (probe.raw as { format: { tags: Record<string, string> } }).format.tags;
    expect(Object.entries(tags).find(([k]) => k.toLowerCase() === 'title')?.[1]).toBe('Sample');
  }, 60_000);

  it('MP4 keeps the tag as a custom key; verify passes', async () => {
    const { probe } = await pass(source, 'mp4', A, 1);
    expect(transcodaTagOf(probe)).toBe(`${A}@1`);
    const tags = (probe.raw as { format: { tags: Record<string, string> } }).format.tags;
    expect(Object.entries(tags).find(([k]) => k.toLowerCase() === 'title')?.[1]).toBe('Sample');
  }, 60_000);

  it('a second workflow appends its entry, across containers, newest last', async () => {
    const first = await pass(source, 'mkv', A, 2);
    const second = await pass(first.output, 'mp4', B, 5);
    expect(parseTranscodaTag(transcodaTagOf(second.probe))).toEqual([
      { workflowId: A, version: 2 },
      { workflowId: B, version: 5 },
    ]);
    const third = await pass(second.output, 'mkv', A, 2);
    // A again: its earlier entry moves to the end.
    expect(transcodaTagOf(third.probe)).toBe(`${B}@5,${A}@2`);
  }, 120_000);
});
