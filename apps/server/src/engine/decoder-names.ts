/**
 * The libavcodec decoder names a source codec may log under. ffprobe reports a stream's codec
 * (`codec_name`), but a decoder logs under its own context name, which differs for some codecs
 * (`[dca @ 0x…]` for a `dts` stream, `[mp3float @ 0x…]` for `mp3`). h264, hevc, eac3, truehd,
 * flac, vc1 and mpeg2video log under their own names and need no entry.
 */
const DECODER_ALIASES: ReadonlyMap<string, string[]> = new Map([
  ['dts', ['dca']],
  ['mp3', ['mp3float']],
  ['mp2', ['mp2float']],
  ['aac', ['aac_fixed']],
  ['ac3', ['ac3_fixed']],
  ['av1', ['libdav1d', 'dav1d']],
  ['vp9', ['libvpx-vp9']],
  ['vp8', ['libvpx']],
  ['opus', ['libopus']],
  ['vorbis', ['libvorbis']],
  ['hdmv_pgs_subtitle', ['pgssub']],
  ['dvd_subtitle', ['dvdsub']],
  ['dvb_subtitle', ['dvbsub']],
  ['subrip', ['srt']],
  ['ass', ['ssa']],
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
