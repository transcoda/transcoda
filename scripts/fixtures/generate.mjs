// Generates tiny, reproducible test media for the M1 engine into .local/fixtures/ (git-ignored),
// verifies every file with ffprobe and writes .local/fixtures/manifest.json.
// Usage: node scripts/fixtures/generate.mjs [--check] [fixture-name ...]
//   --check  only verify existing files (no generation, no manifest write); exits 1 on mismatch.
// Env: TRANSCODA_FIXTURE_HEVC=libx265|hevc_videotoolbox forces the HEVC encoder;
//      TRANSCODA_FIXTURE_FONT=/path/to/font.ttf picks the font attached to ass-fonts.mkv.
// Calls the local ffmpeg/ffprobe via execFile (no shell). Never commit the generated media.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = join(ROOT, '.local', 'fixtures');
const WORK = join(OUT, '.work');

const DURATION = 3;
const WIDTH = 320;
const HEIGHT = 180;
/** h264-big.mkv only: large enough that an HEVC re-encode clearly saves space. */
const BIG_WIDTH = 640;
const BIG_HEIGHT = 360;

// --- ffmpeg helpers -------------------------------------------------------------------------

async function ffmpeg(args) {
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function ffprobe(file) {
  const { stdout } = await run(
    'ffprobe',
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

async function pickHevcEncoder() {
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-encoders']);
  const available = new Set(stdout.split('\n').map((line) => line.trim().split(/\s+/)[1]));
  const forced = process.env.TRANSCODA_FIXTURE_HEVC;
  if (forced) {
    if (!available.has(forced)) throw new Error(`ffmpeg has no encoder ${forced}`);
    return forced;
  }
  for (const name of ['libx265', 'hevc_videotoolbox']) if (available.has(name)) return name;
  throw new Error('ffmpeg has neither libx265 nor hevc_videotoolbox');
}

function hevcArgs(encoder, spec = 'v:0') {
  const common = [`-c:${spec}`, encoder, `-pix_fmt:${spec}`, 'yuv420p'];
  if (encoder === 'libx265') {
    return [...common, `-preset:${spec}`, 'ultrafast', `-x265-params:${spec}`, 'log-level=error'];
  }
  return [...common, `-b:${spec}`, '150k', '-allow_sw', '1'];
}

const VIDEO_IN = [
  '-f',
  'lavfi',
  '-i',
  `testsrc2=size=${WIDTH}x${HEIGHT}:rate=24:duration=${DURATION}`,
];
const AUDIO_IN = ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${DURATION}`];
const AAC = ['-c:a', 'aac', '-b:a', '32k', '-ac', '1'];
/** Oversized H.264 (an HEVC downsize saves well over 20 %). */
const H264_BIG = ['-c:v', 'libx264', '-crf', '10', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];

function srt(text) {
  return `1\n00:00:00,500 --> 00:00:01,500\n${text} (1)\n\n2\n00:00:01,800 --> 00:00:02,800\n${text} (2)\n`;
}

// Per-stream metadata/disposition args. tracks: [{ lang?, default? , forced? }] for one type.
function trackArgs(type, tracks) {
  return tracks.flatMap((t, i) => {
    const flags = [t.default && 'default', t.forced && 'forced'].filter(Boolean);
    // biome-ignore format: flag/value pairs
    return [
      ...(t.lang ? [`-metadata:s:${type}:${i}`, `language=${t.lang}`] : []),
      `-disposition:${type}:${i}`,
      flags.length ? flags.join('+') : '0',
    ];
  });
}

// --- PGS (.sup) writer ----------------------------------------------------------------------
// ffmpeg cannot render text subtitles to bitmaps, so a minimal valid PGS stream is written by
// hand: one display set showing a 64x16 white box at 0.5 s, one clearing it at 2.5 s.

function pgsSegment(pts, type, data) {
  const header = Buffer.alloc(13);
  header.write('PG', 0, 'latin1');
  header.writeUInt32BE(pts, 2);
  header.writeUInt32BE(0, 6);
  header.writeUInt8(type, 10);
  header.writeUInt16BE(data.length, 11);
  return Buffer.concat([header, data]);
}

function pgsDisplaySet(pts, compositionNumber, show) {
  const objW = 64;
  const objH = 16;
  const x = (WIDTH - objW) / 2;
  const y = HEIGHT - objH - 12;
  const pcs = Buffer.alloc(11 + (show ? 8 : 0));
  pcs.writeUInt16BE(WIDTH, 0);
  pcs.writeUInt16BE(HEIGHT, 2);
  pcs.writeUInt8(0x10, 4); // frame rate (ignored)
  pcs.writeUInt16BE(compositionNumber, 5);
  pcs.writeUInt8(show ? 0x80 : 0x00, 7); // epoch start / normal
  pcs.writeUInt8(0, 8); // palette update flag
  pcs.writeUInt8(0, 9); // palette id
  pcs.writeUInt8(show ? 1 : 0, 10); // composition objects
  if (show) {
    pcs.writeUInt16BE(0, 11); // object id
    pcs.writeUInt8(0, 13); // window id
    pcs.writeUInt8(0, 14); // not cropped
    pcs.writeUInt16BE(x, 15);
    pcs.writeUInt16BE(y, 17);
  }
  const wds = Buffer.alloc(10);
  wds.writeUInt8(1, 0);
  wds.writeUInt8(0, 1);
  wds.writeUInt16BE(x, 2);
  wds.writeUInt16BE(y, 4);
  wds.writeUInt16BE(objW, 6);
  wds.writeUInt16BE(objH, 8);
  const segments = [pgsSegment(pts, 0x16, pcs), pgsSegment(pts, 0x17, wds)];
  if (show) {
    // palette 0: entry 0 transparent, entry 1 opaque white (Y, Cr, Cb, alpha)
    const pds = Buffer.from([0, 0, 0, 16, 128, 128, 0, 1, 235, 128, 128, 255]);
    // RLE: per line one run of 64 pixels in colour 1, then end-of-line
    const line = Buffer.from([0x00, 0xc0, objW, 0x01, 0x00, 0x00]);
    const rle = Buffer.concat(Array.from({ length: objH }, () => line));
    const ods = Buffer.alloc(11 + rle.length);
    ods.writeUInt16BE(0, 0); // object id
    ods.writeUInt8(0, 2); // version
    ods.writeUInt8(0xc0, 3); // first and last in sequence
    ods.writeUIntBE(rle.length + 4, 4, 3);
    ods.writeUInt16BE(objW, 7);
    ods.writeUInt16BE(objH, 9);
    rle.copy(ods, 11);
    segments.push(pgsSegment(pts, 0x14, pds), pgsSegment(pts, 0x15, ods));
  }
  segments.push(pgsSegment(pts, 0x80, Buffer.alloc(0)));
  return Buffer.concat(segments);
}

function pgsFile() {
  return Buffer.concat([pgsDisplaySet(0.5 * 90000, 0, true), pgsDisplaySet(2.5 * 90000, 1, false)]);
}

// --- fixtures -------------------------------------------------------------------------------
// expect: streams in ffprobe order. language null = untagged ("und" counts as untagged).

const v = (codec = 'hevc') => ({ type: 'video', codec, default: true });
const a = (language, isDefault = false) => ({
  type: 'audio',
  codec: 'aac',
  language,
  default: isDefault,
});
const s = (codec, language, isDefault = false) => ({
  type: 'subtitle',
  codec,
  language,
  default: isDefault,
});

// Disney+ style: original (eng) first, Turkish is the default, 20 audio and 21 subtitle tracks.
// biome-ignore format: one row of language codes per ten
const TIGGER_LANGS = [
  'eng', 'deu', 'fra', 'spa', 'ita', 'tur', 'por', 'nld', 'pol', 'ces',
  'hun', 'dan', 'nor', 'swe', 'fin', 'jpn', 'kor', 'ell', 'heb', 'ara',
];
const TIGGER_AUDIO = TIGGER_LANGS.map((lang) => ({ lang, default: lang === 'tur' }));
const TIGGER_SUBS = [...TIGGER_AUDIO, { lang: null, default: false }];

const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Supplemental/Verdana.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
];

function findFont() {
  const font = process.env.TRANSCODA_FIXTURE_FONT ?? FONT_CANDIDATES.find((f) => existsSync(f));
  if (!font || !existsSync(font)) {
    throw new Error('no TrueType font found; set TRANSCODA_FIXTURE_FONT=/path/to/font.ttf');
  }
  return font;
}

const FIXTURES = [
  {
    name: 'tigger-pooh',
    file: 'tigger-pooh.mp4',
    format: 'mp4',
    purpose:
      'Reference problem file: HEVC, 20 AAC tracks and 21 mov_text subs with Turkish default, ' +
      'one untagged sub, PNG cover. Target keeps eng, deu, original (eng) and untagged tracks.',
    async build(ctx) {
      const sub = await ctx.text('tigger.srt', srt('Tigger & Pooh'));
      const cover = join(WORK, 'cover.png');
      // biome-ignore format: flag/value pairs
      await ffmpeg([
        '-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}`, '-frames:v', '1', '-update', '1', cover,
      ]);
      // biome-ignore format: flag/value pairs
      return [
        ...VIDEO_IN,
        ...AUDIO_IN,
        '-i', sub,
        '-i', cover,
        '-map', '0:v',
        ...TIGGER_AUDIO.flatMap(() => ['-map', '1:a']),
        ...TIGGER_SUBS.flatMap(() => ['-map', '2:s']),
        '-map', '3:v',
        ...hevcArgs(ctx.hevc, 'v:0'),
        '-tag:v:0', 'hvc1',
        '-c:v:1', 'png',
        '-disposition:v:0', 'default',
        '-disposition:v:1', 'attached_pic',
        ...AAC,
        '-c:s', 'mov_text',
        ...trackArgs('a', TIGGER_AUDIO),
        ...trackArgs('s', TIGGER_SUBS),
      ];
    },
    expect: [
      v(),
      ...TIGGER_AUDIO.map((t) => a(t.lang, t.default)),
      ...TIGGER_SUBS.map((t) => s('mov_text', t.lang, t.default)),
      { type: 'video', codec: 'png', default: false, attached_pic: true },
    ],
  },
  {
    name: 'compliant',
    file: 'compliant.mkv',
    format: 'matroska',
    purpose:
      'Already matches the target (HEVC, eng+deu audio, eng default, one default sub): no-op.',
    async build(ctx) {
      const eng = await ctx.text('compliant-eng.srt', srt('English'));
      const deu = await ctx.text('compliant-deu.srt', srt('Deutsch'));
      const audio = [{ lang: 'eng', default: true }, { lang: 'deu' }];
      const subs = [{ lang: 'eng', default: true }, { lang: 'deu' }];
      // biome-ignore format: flag/value pairs
      return [
        ...VIDEO_IN, ...AUDIO_IN, '-i', eng, '-i', deu,
        '-map', '0:v', '-map', '1:a', '-map', '1:a', '-map', '2:s', '-map', '3:s',
        ...hevcArgs(ctx.hevc), '-disposition:v:0', 'default',
        ...AAC, '-c:s', 'srt',
        ...trackArgs('a', audio), ...trackArgs('s', subs),
      ];
    },
    expect: [v(), a('eng', true), a('deu'), s('subrip', 'eng', true), s('subrip', 'deu')],
  },
  {
    name: 'untagged',
    file: 'untagged.mkv',
    format: 'matroska',
    purpose: 'Only untagged audio and subtitle tracks (no language metadata).',
    async build(ctx) {
      const sub = await ctx.text('untagged.srt', srt('No language'));
      const audio = [{ default: true }, {}];
      const subs = [{}, {}];
      // biome-ignore format: flag/value pairs
      return [
        ...VIDEO_IN, ...AUDIO_IN, '-i', sub,
        '-map', '0:v', '-map', '1:a', '-map', '1:a', '-map', '2:s', '-map', '2:s',
        ...hevcArgs(ctx.hevc), '-disposition:v:0', 'default',
        ...AAC, '-c:s', 'srt',
        ...trackArgs('a', audio), ...trackArgs('s', subs),
      ];
    },
    expect: [v(), a(null, true), a(null), s('subrip', null), s('subrip', null)],
  },
  {
    name: 'pgs-subs',
    file: 'pgs-subs.mkv',
    format: 'matroska',
    purpose:
      'Image subtitles (PGS eng default + DVD deu) for remux-to-MP4 refusal tests. PGS is ' +
      'hand-written (.sup) because ffmpeg has no PGS encoder; the DVD track is transcoded from it.',
    async build(ctx) {
      const sup = join(WORK, 'box.sup');
      await writeFile(sup, pgsFile());
      const subs = [{ lang: 'eng', default: true }, { lang: 'deu' }];
      // biome-ignore format: flag/value pairs
      return [
        ...VIDEO_IN, ...AUDIO_IN, '-fix_sub_duration', '-i', sup,
        '-map', '0:v', '-map', '1:a', '-map', '2:s', '-map', '2:s',
        ...hevcArgs(ctx.hevc), '-disposition:v:0', 'default',
        ...AAC, '-metadata:s:a:0', 'language=eng', '-disposition:a:0', 'default',
        '-c:s:0', 'copy', '-c:s:1', 'dvdsub',
        ...trackArgs('s', subs),
      ];
    },
    expect: [v(), a('eng', true), s('hdmv_pgs_subtitle', 'eng', true), s('dvd_subtitle', 'deu')],
  },
  {
    name: 'ass-fonts',
    file: 'ass-fonts.mkv',
    format: 'matroska',
    purpose: 'ASS subtitles with an attached TrueType font (attachment stream).',
    async build(ctx) {
      const font = findFont();
      const family = basename(font, extname(font));
      const ass = await ctx.text(
        'styled.ass',
        [
          '[Script Info]',
          'ScriptType: v4.00+',
          `PlayResX: ${WIDTH}`,
          `PlayResY: ${HEIGHT}`,
          '',
          '[V4+ Styles]',
          'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
          `Style: Default,${family},18,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1`,
          '',
          '[Events]',
          'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
          'Dialogue: 0,0:00:00.50,0:00:01.50,Default,,0,0,0,,{\\b1}Styled{\\b0} line one',
          'Dialogue: 0,0:00:01.80,0:00:02.80,Default,,0,0,0,,Styled line two',
          '',
        ].join('\n'),
      );
      // biome-ignore format: flag/value pairs
      return [
        ...VIDEO_IN, ...AUDIO_IN, '-i', ass,
        '-map', '0:v', '-map', '1:a', '-map', '2:s',
        ...hevcArgs(ctx.hevc), '-disposition:v:0', 'default',
        ...AAC, '-metadata:s:a:0', 'language=eng', '-disposition:a:0', 'default',
        '-c:s', 'copy', '-metadata:s:s:0', 'language=eng', '-disposition:s:0', 'default',
        '-attach', font, '-metadata:s:t:0', 'mimetype=application/x-truetype-font',
      ];
    },
    expect: [v(), a('eng', true), s('ass', 'eng', true), { type: 'attachment', codec: 'ttf' }],
  },
  {
    name: 'two-defaults',
    file: 'two-defaults.mkv',
    format: 'matroska',
    purpose: 'Two audio tracks (eng, deu) both flagged default.',
    async build(ctx) {
      const audio = [
        { lang: 'eng', default: true },
        { lang: 'deu', default: true },
      ];
      // biome-ignore format: flag/value pairs
      return [
        ...VIDEO_IN, ...AUDIO_IN,
        '-map', '0:v', '-map', '1:a', '-map', '1:a',
        ...hevcArgs(ctx.hevc), '-disposition:v:0', 'default',
        ...AAC, ...trackArgs('a', audio),
      ];
    },
    expect: [v(), a('eng', true), a('deu', true)],
  },
  {
    name: 'no-default-audio',
    file: 'no-default-audio.mkv',
    format: 'matroska',
    purpose:
      'H.264 (libx264 CRF 10, oversized) with eng + deu AAC and an eng SRT, none flagged default ' +
      '(as tools that leave flags unset write them): a rewrite must flag one default audio.',
    async build(ctx) {
      const eng = await ctx.text('nodef-eng.srt', srt('English'));
      const audio = [{ lang: 'eng' }, { lang: 'deu' }];
      const subs = [{ lang: 'eng' }];
      // biome-ignore format: flag/value pairs
      return [
        ...VIDEO_IN, ...AUDIO_IN, '-i', eng,
        '-map', '0:v', '-map', '1:a', '-map', '1:a', '-map', '2:s',
        ...H264_BIG, '-disposition:v:0', 'default',
        ...AAC, '-c:s', 'srt',
        ...trackArgs('a', audio), ...trackArgs('s', subs),
      ];
    },
    expect: [v('h264'), a('eng'), a('deu'), s('subrip', 'eng')],
  },
  {
    name: 'two-defaults-h264',
    file: 'two-defaults-h264.mkv',
    format: 'matroska',
    purpose:
      'H.264 (libx264 CRF 10, oversized) with eng and deu AAC both flagged default: a rewrite ' +
      'must leave exactly one default audio.',
    async build() {
      const audio = [
        { lang: 'eng', default: true },
        { lang: 'deu', default: true },
      ];
      // biome-ignore format: flag/value pairs
      return [
        ...VIDEO_IN, ...AUDIO_IN,
        '-map', '0:v', '-map', '1:a', '-map', '1:a',
        ...H264_BIG, '-disposition:v:0', 'default',
        ...AAC, ...trackArgs('a', audio),
      ];
    },
    expect: [v('h264'), a('eng', true), a('deu', true)],
  },
  {
    name: 'no-default-sub',
    file: 'no-default-sub.mkv',
    format: 'matroska',
    purpose:
      'H.264 with eng AAC (default) and eng + deu SRT, no subtitle flagged default (most mkvs): ' +
      'a remux to MP4 gets a default subtitle from the muxer whether asked or not.',
    async build(ctx) {
      const eng = await ctx.text('nodefsub-eng.srt', srt('English'));
      const deu = await ctx.text('nodefsub-deu.srt', srt('Deutsch'));
      const audio = [{ lang: 'eng', default: true }];
      const subs = [{ lang: 'eng' }, { lang: 'deu' }];
      // biome-ignore format: flag/value pairs
      return [
        ...VIDEO_IN, ...AUDIO_IN, '-i', eng, '-i', deu,
        '-map', '0:v', '-map', '1:a', '-map', '2:s', '-map', '3:s',
        ...H264_BIG, '-disposition:v:0', 'default',
        ...AAC, '-c:s', 'srt',
        ...trackArgs('a', audio), ...trackArgs('s', subs),
      ];
    },
    expect: [v('h264'), a('eng', true), s('subrip', 'eng'), s('subrip', 'deu')],
  },
  {
    name: 'h264-big',
    file: 'h264-big.mkv',
    format: 'matroska',
    purpose:
      'Oversized H.264 (libx264 CRF 10 ultrafast, 640x360), eng (default) + deu AAC, eng SRT ' +
      '(default): an HEVC downsize shrinks it well below 80 %.',
    async build(ctx) {
      const eng = await ctx.text('big-eng.srt', srt('English'));
      const audio = [{ lang: 'eng', default: true }, { lang: 'deu' }];
      const subs = [{ lang: 'eng', default: true }];
      // biome-ignore format: flag/value pairs
      return [
        '-f', 'lavfi', '-i', `testsrc2=size=${BIG_WIDTH}x${BIG_HEIGHT}:rate=24:duration=${DURATION}`,
        ...AUDIO_IN, '-i', eng,
        '-map', '0:v', '-map', '1:a', '-map', '1:a', '-map', '2:s',
        '-c:v', 'libx264', '-crf', '10', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-disposition:v:0', 'default',
        ...AAC, '-c:s', 'srt',
        ...trackArgs('a', audio), ...trackArgs('s', subs),
      ];
    },
    expect: [v('h264'), a('eng', true), a('deu'), s('subrip', 'eng', true)],
  },
];

// --- verification ---------------------------------------------------------------------------

function describe(stream) {
  const lang = stream.tags?.language;
  const d = {
    index: stream.index,
    type: stream.codec_type,
    codec: stream.codec_name ?? null,
  };
  if (stream.codec_type === 'attachment') {
    d.filename = stream.tags?.filename ?? null;
    d.mimetype = stream.tags?.mimetype ?? null;
    return d;
  }
  d.language = lang && lang !== 'und' ? lang : null;
  d.default = stream.disposition?.default === 1;
  if (stream.disposition?.forced === 1) d.forced = true;
  if (stream.disposition?.attached_pic === 1) d.attached_pic = true;
  return d;
}

function verify(fixture, probe) {
  const errors = [];
  const streams = probe.streams.map(describe);
  const formatNames = probe.format.format_name.split(',');
  const wantFormat = fixture.format === 'mp4' ? 'mp4' : 'matroska';
  if (!formatNames.includes(wantFormat)) {
    errors.push(`container ${probe.format.format_name}, expected ${wantFormat}`);
  }
  const duration = Number(probe.format.duration);
  if (!(duration >= 2 && duration <= 5.5)) errors.push(`duration ${duration}s outside 2–5.5 s`);
  if (streams.length !== fixture.expect.length) {
    errors.push(`${streams.length} streams, expected ${fixture.expect.length}`);
  }
  fixture.expect.forEach((want, i) => {
    const got = streams[i];
    if (!got) return;
    for (const [key, value] of Object.entries(want)) {
      const actual = got[key] ?? (key === 'attached_pic' ? false : null);
      if (actual !== value) {
        errors.push(
          `stream ${i} ${key}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(value)}`,
        );
      }
    }
    if (got.attached_pic && !want.attached_pic)
      errors.push(`stream ${i} unexpectedly attached_pic`);
  });
  const counts = {};
  for (const st of streams) counts[st.type] = (counts[st.type] ?? 0) + 1;
  return { errors, streams, counts, duration, formatName: probe.format.format_name };
}

async function sha256(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

// --- main -----------------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const names = args.filter((arg) => !arg.startsWith('--'));
  const unknown = names.filter((n) => !FIXTURES.some((f) => f.name === n));
  if (unknown.length) {
    throw new Error(
      `unknown fixture(s): ${unknown.join(', ')}; known: ${FIXTURES.map((f) => f.name).join(', ')}`,
    );
  }
  const selected = names.length ? FIXTURES.filter((f) => names.includes(f.name)) : FIXTURES;

  const { stdout: versionOut } = await run('ffmpeg', ['-version']);
  const ffmpegVersion = versionOut.split('\n')[0];
  let hevc = null;
  if (!checkOnly) {
    hevc = await pickHevcEncoder();
    await mkdir(WORK, { recursive: true });
  }
  const ctx = {
    hevc,
    async text(name, content) {
      const path = join(WORK, name);
      await writeFile(path, content);
      return path;
    },
  };

  const results = [];
  let failed = false;
  try {
    for (const fixture of selected) {
      const path = join(OUT, fixture.file);
      if (!checkOnly) {
        process.stdout.write(`generating ${fixture.file} ... `);
        await ffmpeg([...(await fixture.build(ctx)), '-t', String(DURATION), path]);
      } else if (!existsSync(path)) {
        console.log(`✗ ${fixture.file}: missing (run pnpm fixtures)`);
        failed = true;
        continue;
      } else {
        process.stdout.write(`checking ${fixture.file} ... `);
      }
      const result = verify(fixture, await ffprobe(path));
      if (result.errors.length) {
        failed = true;
        console.log(`✗\n  ${result.errors.join('\n  ')}`);
      } else {
        console.log(
          `✓ ${Object.entries(result.counts)
            .map(([t, n]) => `${n} ${t}`)
            .join(', ')}`,
        );
      }
      results.push({
        name: fixture.name,
        file: fixture.file,
        purpose: fixture.purpose,
        hevcEncoder: hevc,
        ok: result.errors.length === 0,
        errors: result.errors,
        bytes: (await stat(path)).size,
        sha256: await sha256(path),
        container: result.formatName,
        duration: result.duration,
        counts: result.counts,
        streams: result.streams,
      });
    }
  } finally {
    if (!checkOnly) await rm(WORK, { recursive: true, force: true });
  }

  if (!checkOnly) {
    const manifestPath = join(OUT, 'manifest.json');
    // keep entries of fixtures not regenerated this run
    let previous = [];
    if (names.length && existsSync(manifestPath)) {
      previous = JSON.parse(await readFile(manifestPath, 'utf8')).fixtures.filter(
        (f) => !names.includes(f.name),
      );
    }
    const manifest = {
      generatedAt: new Date().toISOString(),
      ffmpeg: ffmpegVersion,
      fixtures: [...previous, ...results].sort(
        (x, y) =>
          FIXTURES.findIndex((f) => f.name === x.name) -
          FIXTURES.findIndex((f) => f.name === y.name),
      ),
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`manifest: ${manifestPath}`);
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stderr?.toString() || error.message);
  process.exitCode = 1;
});
