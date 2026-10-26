import { describe, expect, it } from 'vitest';
import { blueyPlan, blueyProbe, identityPlan } from '../test/fixtures/plan.ts';
import {
  containerLine,
  dropLine,
  groupByLanguage,
  keptSummary,
  shownDrops,
  sidecarSummary,
  sizeLine,
  trackLabel,
  wouldDo,
} from './planText.ts';

const plan = blueyPlan();
const probe = blueyProbe();
const ofType = (type: string) => plan.streams.filter((s) => s.type === type);
function byIndex(index: number) {
  const s = plan.streams.find((x) => x.index === index);
  if (!s) throw new Error(`no stream ${index}`);
  return s;
}

describe('planText', () => {
  it('planText reproduces the screen: "3 of 20 tracks kept", "Drop 16 more in 14 languages: French, Spanish, Italian, Portuguese …", wouldDo "Rewrite once", container "MP4 → MKV · remux"', () => {
    const audio = ofType('audio');
    expect(keptSummary(audio, 'audio')).toBe('3 of 20 tracks kept');
    expect(keptSummary(ofType('subtitle'), 'subtitle')).toBe('4 of 21 tracks kept');

    const groups = groupByLanguage(audio, 'audio');
    expect(groups.slice(0, 4).map((g) => [g.name, g.language, g.original])).toEqual([
      ['English', 'eng', false],
      ['German', 'deu', false],
      ['Japanese', 'jpn', true],
      ['Turkish', 'tur', false],
    ]);
    // Two French and two Spanish tracks make one group each.
    expect(groups).toHaveLength(18);
    expect(groups.find((g) => g.language === 'fra')?.streams).toHaveLength(2);

    // Turkish was the default: it stays a row; the other 16 dropped tracks fold into one line.
    const { rows, folded } = shownDrops(audio, 'audio');
    expect(rows.map((g) => g.name)).toEqual(['English', 'German', 'Japanese', 'Turkish']);
    expect(dropLine(folded)).toBe(
      'Drop 16 more in 14 languages: French, Spanish, Italian, Portuguese …',
    );
    expect(dropLine([])).toBeNull();
    expect(dropLine(folded.slice(0, 1))).toBe('Drop 1 more in 1 language: French');

    expect(wouldDo(plan)).toBe('Rewrite once');
    expect(wouldDo(identityPlan())).toBe('Nothing');
    expect(containerLine(plan)).toBe('MP4 → MKV · remux');
    expect(containerLine(identityPlan())).toBe('MKV');
  });

  it('labels tracks by type-relative index, codec and channels; subtitles by full or forced', () => {
    expect(trackLabel(byIndex(3), probe)).toBe('a:2 · AAC 5.1');
    expect(trackLabel(byIndex(6), probe)).toBe('a:5 · AAC 2.0');
    expect(trackLabel(byIndex(22), probe)).toBe('s:1 · full');
    expect(trackLabel(byIndex(23), probe)).toBe('s:2 · signs and songs');
    expect(trackLabel(byIndex(0), probe)).toBe('v:0 · HEVC 1080p · 6.1 Mb/s');
    // Without a probe the stream's own index is all there is.
    expect(trackLabel(byIndex(3), null)).toBe('a:3 · AAC');
  });

  it('untagged tracks group as "Untagged"', () => {
    const audio = ofType('audio').map((s, i) => (i < 2 ? { ...s, language: null } : s));
    const untagged = groupByLanguage(audio, 'audio').find((g) => g.language === null);
    expect(untagged?.name).toBe('Untagged');
    expect(untagged?.streams).toHaveLength(2);
  });

  it('prints the estimated size with one unit when both sides share it', () => {
    expect(sizeLine(2_410_000_000, 1_620_000_000)).toBe('2.41 → 1.62 GB');
    expect(sizeLine(2_410_000_000, 790_000_000)).toBe('2.41 GB → 790 MB');
    expect(sizeLine(2_410_000_000, null)).toBe('2.41 GB');
    expect(sizeLine(null, null)).toBe('—');
  });
});

describe('sidecarSummary', () => {
  it('counts embedded files; null without sidecars', () => {
    const entry = (action: 'embed' | 'drop') => ({
      file: 'a.srt',
      language: 'deu',
      forced: false,
      sdh: false,
      codec: 'subrip',
      action,
      note: '',
    });
    expect(sidecarSummary(blueyPlan())).toBeNull();
    expect(
      sidecarSummary({ ...blueyPlan(), sidecars: [entry('embed'), entry('drop'), entry('embed')] }),
    ).toBe('2 of 3 embedded');
  });
});
