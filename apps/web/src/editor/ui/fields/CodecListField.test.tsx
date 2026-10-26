import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { JsonValue } from '@transcoda/shared';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogFixture } from '../../../test/fixtures/catalog.ts';
import { type FieldDef, fieldsFor } from '../../model/schema-fields.ts';
import { SettingField } from './SettingField.tsx';

afterEach(cleanup);

const videoIs = catalogFixture.byType.get('core:video-is');
const videoCodecs = fieldsFor(videoIs?.settingsSchema ?? null).find((f) => f.key === 'codecs');
const [audioCodecs] = fieldsFor({
  type: 'object',
  properties: {
    audioCodecs: {
      type: 'array',
      items: { type: 'string' },
      description: 'Audio codecs',
      'x-transcoda': 'audio-codecs',
    },
  },
});

/** The field with its value kept (a form would): each change is the next value. */
function Harness({
  def,
  initial,
  onChange,
}: {
  def: FieldDef;
  initial: string[];
  onChange(v: JsonValue | undefined): void;
}) {
  const [value, setValue] = useState<JsonValue | undefined>(initial);
  return (
    <SettingField
      def={def}
      value={value}
      issue={null}
      readOnly={false}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

function open(def: FieldDef | undefined, initial: string[] = []) {
  if (!def) throw new Error('no def');
  const onChange = vi.fn<(v: JsonValue | undefined) => void>();
  render(<Harness def={def} initial={initial} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add codec' }));
  const dialog = screen.getByRole('dialog', { name: 'Add codecs' });
  const search = within(dialog).getByRole('combobox', { name: 'Search codecs' });
  const listbox = within(dialog).getByRole('listbox', { name: 'Codecs' });
  return { onChange, dialog, search, listbox };
}

const groupNames = (listbox: HTMLElement) =>
  within(listbox)
    .getAllByRole('group')
    .map((g) => g.getAttribute('aria-label'));
const optionsIn = (listbox: HTMLElement, group: string) =>
  within(within(listbox).getByRole('group', { name: group }))
    .getAllByRole('option')
    .map((o) => o.textContent);

describe('CodecListField (UI list #40)', () => {
  it('core:video-is codecs is a video codec list', () => {
    expect(videoCodecs?.spec).toEqual({ kind: 'codec-list', media: 'video' });
  });

  it('chips show the plain name and the id; the stored value stays the ffmpeg id', () => {
    const onChange = vi.fn<(v: JsonValue | undefined) => void>();
    if (!videoCodecs) throw new Error('no def');
    render(<Harness def={videoCodecs} initial={['h264', 'dvvideo']} onChange={onChange} />);
    const chip = screen.getByText('H.264 / AVC').closest('.lang-chip');
    expect(chip?.textContent).toContain('h264');
    // A hand-typed id the table does not know shows as it is.
    expect(screen.getByText('dvvideo')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove H.264 / AVC' }));
    expect(onChange).toHaveBeenLastCalledWith(['dvvideo']);
  });

  it('groups the video codecs: Efficient (target), Common, Older (worth re-encoding)', () => {
    const { listbox, search } = open(videoCodecs, ['hevc']);
    expect(document.activeElement).toBe(search);
    expect(listbox.getAttribute('aria-multiselectable')).toBe('true');
    expect(groupNames(listbox)).toEqual([
      'Efficient (target)',
      'Common',
      'Older (worth re-encoding)',
    ]);
    expect(optionsIn(listbox, 'Efficient (target)')).toEqual(['HEVC / H.265hevc', 'AV1av1']);
    expect(optionsIn(listbox, 'Common')).toEqual(['H.264 / AVCh264', 'VP9vp9']);
    expect(optionsIn(listbox, 'Older (worth re-encoding)')).toHaveLength(9);
    expect(
      within(listbox).getByRole('option', { name: /HEVC/ }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(within(listbox).getByRole('option', { name: /AV1/ }).getAttribute('aria-selected')).toBe(
      'false',
    );
  });

  it('a click toggles a codec and the picker stays open for more; Done closes it', () => {
    const { onChange, listbox, dialog } = open(videoCodecs, ['hevc']);
    fireEvent.click(within(listbox).getByRole('option', { name: /^VP9/ }));
    expect(onChange).toHaveBeenLastCalledWith(['hevc', 'vp9']);
    fireEvent.click(within(listbox).getByRole('option', { name: /^HEVC/ }));
    expect(onChange).toHaveBeenLastCalledWith(['vp9']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('VP9')).toBeTruthy();
  });

  it('"Add all" per group and the presets "Efficient (HEVC, AV1)" and "Everything else"', () => {
    const { onChange, dialog } = open(videoCodecs, ['vp8']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add all: Common' }));
    expect(onChange).toHaveBeenLastCalledWith(['vp8', 'h264', 'vp9']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Efficient (HEVC, AV1)' }));
    expect(onChange).toHaveBeenLastCalledWith(['vp8', 'h264', 'vp9', 'hevc', 'av1']);
    cleanup();

    const again = open(videoCodecs);
    fireEvent.click(within(again.dialog).getByRole('button', { name: 'Everything else' }));
    expect(again.onChange).toHaveBeenLastCalledWith([
      'h264',
      'vp9',
      'mpeg4',
      'mpeg2video',
      'vc1',
      'wmv3',
      'msmpeg4v3',
      'mpeg1video',
      'h263',
      'vp8',
      'theora',
    ]);
  });

  it('searches names and ids; arrows move the active option and Enter toggles it', () => {
    const { onChange, search, listbox } = open(videoCodecs);
    fireEvent.change(search, { target: { value: 'xvid' } });
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['MPEG-4 Part 2 (Xvid, DivX)mpeg4', 'Add “xvid”']);
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const active = document.getElementById(search.getAttribute('aria-activedescendant') ?? '');
    expect(active?.textContent).toBe('AV1av1');
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['av1']);
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['av1', 'hevc']);
  });

  it('a typed custom name is still allowed (Enter adds it, the search clears)', () => {
    const { onChange, search, listbox } = open(videoCodecs);
    fireEvent.change(search, { target: { value: ' dvvideo ' } });
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Add “dvvideo”']);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['dvvideo']);
    expect((search as HTMLInputElement).value).toBe('');
  });

  it('audio codec lists use the same picker with Lossless, Surround (lossy), Stereo-friendly', () => {
    expect(audioCodecs?.spec).toEqual({ kind: 'codec-list', media: 'audio' });
    const { listbox, dialog, onChange } = open(audioCodecs);
    expect(groupNames(listbox)).toEqual(['Lossless', 'Surround (lossy)', 'Stereo-friendly']);
    expect(optionsIn(listbox, 'Stereo-friendly')).toEqual([
      'AACaac',
      'Opusopus',
      'MP3mp3',
      'Vorbisvorbis',
    ]);
    expect(within(listbox).getByRole('option', { name: /DTS-HD MA/ }).textContent).toContain(
      'not told apart by codec',
    );
    // No presets for audio: only "Add all" per group.
    expect(within(dialog).queryByRole('button', { name: 'Everything else' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add all: Surround (lossy)' }));
    expect(onChange).toHaveBeenLastCalledWith(['ac3', 'eac3', 'dts']);
    // dts is in two groups: both options read selected.
    const dts = within(listbox)
      .getAllByRole('option')
      .filter((o) => o.textContent?.includes('dts'));
    expect(dts.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'true']);
  });
});
