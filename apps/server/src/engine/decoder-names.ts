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
 * Which side an ffmpeg error-level line (`[error]`/`[fatal]`/`[panic]`, ffmpeg's `level+` tag) came
 * from; null for any other line. `source`: its first context is the source input (`in#0…`), one
 * of its streams (`…ist#0:…`), or a decoder context (`dec:<name>`, or a bare `[<name> @ 0x…]`:
 * libavcodec's own messages) naming a source decoder that is not also an encoder of the job. Everything
 * else (encoders, the muxer, `out#`, extra inputs such as sidecars, unknown or no context) is the
 * output's: a source error leads to replacing the file, so a doubtful line never counts.
 */
export function classifyErrorLine(
  line: string,
  sourceCodecs: ReadonlySet<string>,
  encoders: ReadonlySet<string>,
): 'source' | 'output' | null {
  if (!/\[(error|fatal|panic)\]/.test(line)) return null;
  const m = /^\[([^\]@]+?)(?: @ 0x[0-9a-f]+)?\]/i.exec(line.trim());
  const ctx = m?.[1]?.trim();
  if (!ctx || /^(error|fatal|panic)$/.test(ctx)) return 'output';
  if (/^(in#0\/|[a-z]?ist#0:)/.test(ctx)) return 'source';
  // A decoder may also read an extra input: it counts only when it is one of the source's.
  const decoder = ctx.startsWith('dec:') ? ctx.slice(4) : ctx;
  return sourceCodecs.has(decoder) && !encoders.has(decoder) ? 'source' : 'output';
}
