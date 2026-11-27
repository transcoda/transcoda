/**
 * The libavcodec decoder names a source codec may log under. ffprobe reports a stream's codec
 * (`codec_name`), but a decoder logs under its own context name, which differs for some codecs
 * (`[dca @ 0x…]` for a `dts` stream, `[mp3float @ 0x…]` for `mp3`). Only the decoders ffmpeg picks
 * by default are listed: aac, ac3, h264, hevc, eac3, truehd, flac, vc1, mpeg2video, vp8, vp9, opus
 * and vorbis log under their own names and need no entry. A name that is also an encoder Transcoda
 * runs (`srt` for subrip, `ssa` for ass) is left out: a line under it could be the output's, and a
 * source error leads to replacing the file.
 */
const DECODER_ALIASES: ReadonlyMap<string, string[]> = new Map([
  ['dts', ['dca']],
  ['mp3', ['mp3float']],
  ['mp2', ['mp2float']],
  ['av1', ['libdav1d']],
  ['hdmv_pgs_subtitle', ['pgssub']],
  ['dvd_subtitle', ['dvdsub']],
  ['dvb_subtitle', ['dvbsub']],
]);

/** Every codec name plus the decoder names that log under another context name. */
export function sourceDecoderNames(codecs: Iterable<string>): Set<string> {
  const names = new Set<string>();
  for (const codec of codecs) {
    names.add(codec);
    for (const alias of DECODER_ALIASES.get(codec) ?? []) names.add(alias);
  }
  return names;
}

/**
 * Error-level lines that do not mean the output is wrong. x265 prints "Failed to genrate CPU mask"
 * (sic) when the kernel shows no NUMA nodes, as in Docker Desktop's VM on macOS and Windows, and
 * then encodes on its default thread pool; the file is complete and verify still checks it.
 */
const HARMLESS_ERRORS: readonly RegExp[] = [/^x265 \[error\]: Failed to gene?rate CPU mask$/];

/**
 * Which side an ffmpeg error-level line (`[error]`/`[fatal]`/`[panic]`, ffmpeg's `level+` tag) came
 * from; null for any other line. `source`: a decoder of the source said it: its first context is one
 * of the source's streams (`…ist#0:…`) or a decoder context (`dec:<name>`, or a bare
 * `[<name> @ 0x…]`: libavcodec's own messages) naming a source decoder that is not also an encoder
 * of the job. `demuxer`: the source input's demuxer (`in#0/…`): it reports read errors (a disk or
 * network share) as well as damage, so it alone never proves damage. Everything else (encoders,
 * the muxer, `out#`, extra inputs such as sidecars, unknown or no context) is the output's: a
 * source error leads to replacing the file, so a doubtful line never counts.
 */
export function classifyErrorLine(
  line: string,
  sourceCodecs: ReadonlySet<string>,
  encoders: ReadonlySet<string>,
): 'source' | 'demuxer' | 'output' | null {
  if (!/\[(error|fatal|panic)\]/.test(line)) return null;
  if (HARMLESS_ERRORS.some((re) => re.test(line.trim()))) return null;
  const m = /^\[([^\]@]+?)(?: @ 0x[0-9a-f]+)?\]/i.exec(line.trim());
  const ctx = m?.[1]?.trim();
  if (!ctx || /^(error|fatal|panic)$/.test(ctx)) return 'output';
  if (ctx.startsWith('in#0/')) return 'demuxer';
  if (/^[a-z]?ist#0:/.test(ctx)) return 'source';
  // A decoder may also read an extra input: it counts only when it is one of the source's.
  const decoder = ctx.startsWith('dec:') ? ctx.slice(4) : ctx;
  return sourceCodecs.has(decoder) && !encoders.has(decoder) ? 'source' : 'output';
}

/**
 * A line that says the file could not be read (rather than decoded): a disk, network share or
 * permission problem, which a later read may not have. Never damage.
 */
export const READ_FAILURE = new RegExp(
  [
    'input/output error',
    'i/o error',
    '\\beio\\b',
    'permission denied',
    'no such file',
    'connection (reset|refused|timed out)',
    'stale file handle',
    'resource temporarily unavailable',
    'cannot allocate memory',
    // Network shares (SMB/NFS/sshfs) that dropped or stalled.
    'transport endpoint is not connected',
    'host is down',
    'network is (unreachable|down)',
    'no route to host',
    'operation timed out',
    'broken pipe',
    'software caused connection abort',
  ].join('|'),
  'i',
);

/**
 * Decoded video frames keep the input's time base on their way to the null muxer. Without it
 * ffmpeg 8 moves them to the frame rate's (1/24), and Matroska's millisecond timestamps of a
 * B-frame video round two frames onto one: "non monotonically increasing dts to muxer … 2 >= 2",
 * at error level, about ffmpeg's own discarded output and not the file. ffmpeg 9 does not say it.
 * Video only: audio keeps its sample-rate time base, since in milliseconds a frame trimmed by a seek
 * and the next one round to the same timestamp the same way.
 */
export const NULL_TIMESTAMPS = ['-enc_time_base:v', 'demux'] as const;
