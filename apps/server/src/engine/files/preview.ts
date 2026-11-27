// Plays a kept mkv test output in the browser: ffmpeg builds a normal (faststart) mp4 beside it
// once, reading the file from stdin. Streams are copied as the dry run produced them, never
// encoded.
import childProcess from 'node:child_process';
import type { Readable } from 'node:stream';
import type { JobPlan } from '@transcoda/shared';

/** How many preview builds may run at once; one more is answered 503 BUSY. */
export const MAX_PREVIEW_BUILDS = 2;

/**
 * Audio codecs the preview copies into mp4 (ffmpeg 9.0.2 muxes them without `-strict`; TrueHD
 * needs it). DTS and PCM mux too but play in no browser, so they are left out like TrueHD.
 */
export const PREVIEW_AUDIO: ReadonlySet<string> = new Set([
  'aac',
  'mp3',
  'opus',
  'flac',
  'alac',
  'ac3',
  'eac3',
]);

/**
 * ffmpeg's arguments for the preview at `outPath`, copy only: the first video track (HEVC tagged
 * `hvc1`, which Safari needs) and the output's first audio track when its codec (from the stored
 * plan) is in PREVIEW_AUDIO; otherwise no audio. Without the output's tracks in the plan (none
 * stored, or one stored before they were) the audio codec is unknown, so no audio either: a codec
 * mp4 cannot carry would fail the whole build.
 */
export function previewArgs(plan: JobPlan | null, outPath: string): string[] {
  const output = plan?.output;
  const audio = output?.find((s) => s.type === 'audio');
  const video = output?.find((s) => s.type === 'video');
  const audioArgs =
    audio && PREVIEW_AUDIO.has(audio.codec) ? ['-map', '0:a:0', '-c:a', 'copy'] : ['-an'];
  return [
    ...['-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0'],
    ...['-map', '0:v:0?', ...audioArgs],
    ...['-c:v', 'copy', ...(video?.codec === 'hevc' ? ['-tag:v', 'hvc1'] : []), '-sn', '-dn'],
    ...['-movflags', '+faststart', '-f', 'mp4', outPath],
  ];
}

/**
 * Runs ffmpeg ({@link previewArgs}) from `input` to `outPath`. Resolves when ffmpeg exits 0;
 * rejects with ffmpeg's first stderr line (or the exit) otherwise, when it cannot be started, or
 * when reading `input` failed (ffmpeg may still exit 0 then, with a truncated file).
 * `input` is destroyed either way.
 */
export function buildPreview(o: {
  ffmpegPath: string;
  input: Readable;
  outPath: string;
  /** The job's stored plan: whether the audio is copied, and the video tag. */
  plan: JobPlan | null;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(o.ffmpegPath, previewArgs(o.plan, o.outPath), {
      shell: false,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let firstStderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (!firstStderr) firstStderr = chunk.split('\n')[0]?.trim() ?? '';
    });
    // ffmpeg may stop reading early (an error): EPIPE on stdin is expected then. A read error
    // ends ffmpeg's input early, and it may still exit 0 with a truncated file: that fails too.
    let inputError: Error | null = null;
    child.stdin.on('error', () => o.input.destroy());
    o.input.on('error', (err) => {
      inputError ??= err;
      child.stdin.destroy();
    });
    o.input.pipe(child.stdin);

    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      o.input.destroy();
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      o.input.destroy();
      if (inputError) reject(new Error(`reading the output failed: ${inputError.message}`));
      else if (code === 0) resolve();
      else reject(new Error(firstStderr || `ffmpeg exited with ${code ?? signal}`));
    });
  });
}
