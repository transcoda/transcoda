import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NodeInfo } from '@transcoda/contract';
import type { Issue, JsonValue, NodeInstance } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLibrariesCache } from '../../hooks/useLibraries.ts';
import { catalogFixture } from '../../test/fixtures/catalog.ts';
import type { ZoomLevel } from '../flow/useZoomLevel.ts';
import { NEEDS_A_SETTING, nodeStateFor } from '../model/issues.ts';
import { OnNodeRow } from './OnNodeRow.tsx';

const mocks = vi.hoisted(() => ({ librariesList: vi.fn() }));
vi.mock('../../api/client.ts', () => ({ api: { libraries: { list: mocks.librariesList } } }));

const lib = (id: string, name: string) => ({ id, name });
const libraries = [lib('l1', 'Shows'), lib('l2', 'Movies'), lib('l3', 'Anime')];

beforeEach(() => {
  resetLibrariesCache();
  mocks.librariesList.mockReset().mockResolvedValue({ libraries });
});
afterEach(cleanup);

function defOf(type: string): NodeInfo {
  const def = catalogFixture.byType.get(type);
  if (!def) throw new Error(`no ${type} in the fixture`);
  return def;
}

function instance(type: string, settings: JsonValue): NodeInstance {
  return { id: 'n', type, typeVersion: 1, settings, position: { x: 0, y: 0 } };
}

function row(
  def: NodeInfo,
  settings: JsonValue,
  opts: { zoom?: ZoomLevel; issues?: Issue[]; readOnly?: boolean } = {},
) {
  const onChange = vi.fn();
  const onFocus = vi.fn();
  const view = render(
    <OnNodeRow
      def={def}
      instance={instance(def.type, settings)}
      state={nodeStateFor('n', opts.issues ?? [])}
      zoom={opts.zoom ?? 'full'}
      readOnly={opts.readOnly ?? false}
      onChange={onChange}
      onFocus={onFocus}
    />,
  );
  return { ...view, onChange, onFocus };
}

const encodeSettings = {
  codec: 'hevc',
  encoder: 'libx265',
  quality: 24,
  preset: 'medium',
  skipIf: 'already-target-codec',
};

describe('OnNodeRow', () => {
  it('encode-video shows a "Quality (CRF)" number input on the card bound to settings.quality', () => {
    const { onChange } = row(defOf('core:encode-video'), encodeSettings);
    const input = screen.getByRole('spinbutton', { name: 'Quality (CRF)' }) as HTMLInputElement;
    expect(input.value).toBe('24');
    expect(input.min).toBe('0');
    expect(input.max).toBe('63');
    expect(input.classList).toContain('nodrag');
    expect(input.classList).toContain('nopan');
    expect(input.classList).toContain('tc-onnode-input');
    fireEvent.change(input, { target: { value: '22' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...encodeSettings, quality: 22 });
  });

  it('encode-video in bitrate mode shows the target bitrate on the card instead of the quality', () => {
    const settings = { ...encodeSettings, rateControl: 'bitrate', bitrateKbps: 4000 };
    const { onChange } = row(defOf('core:encode-video'), settings);
    expect(screen.queryByRole('spinbutton', { name: 'Quality (CRF)' })).toBeNull();
    const input = screen.getByRole('spinbutton', {
      name: 'Target bitrate (kb/s)',
    }) as HTMLInputElement;
    expect(input.value).toBe('4000');
    fireEvent.change(input, { target: { value: '3500' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, bitrateKbps: 3500 });
  });

  it('a typed value that is not a number is not applied; an out-of-range one names the bound', () => {
    const { onChange, rerender, onFocus } = row(defOf('core:encode-video'), encodeSettings);
    const input = screen.getByRole('spinbutton', { name: 'Quality (CRF)' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).not.toHaveBeenCalled();
    rerender(
      <OnNodeRow
        def={defOf('core:encode-video')}
        instance={instance('core:encode-video', { ...encodeSettings, quality: 70 })}
        state={nodeStateFor('n', [])}
        zoom="full"
        readOnly={false}
        onChange={onChange}
        onFocus={onFocus}
      />,
    );
    expect(input.title).toBe('Must be at most 63');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('the number can be cleared while typing; leaving it empty brings the stored value back', () => {
    const { onChange, rerender, onFocus } = row(defOf('core:encode-video'), encodeSettings);
    const input = screen.getByRole('spinbutton', { name: 'Quality (CRF)' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(input.value).toBe('24');
    // A value changed from outside (undo) replaces the text.
    fireEvent.change(input, { target: { value: '' } });
    rerender(
      <OnNodeRow
        def={defOf('core:encode-video')}
        instance={instance('core:encode-video', { ...encodeSettings, quality: 30 })}
        state={nodeStateFor('n', [])}
        zoom="full"
        readOnly={false}
        onChange={onChange}
        onFocus={onFocus}
      />,
    );
    expect(input.value).toBe('30');
  });

  it('size-gate shows "Saved at least (%)" with its value', () => {
    row(defOf('core:size-gate'), { minSavingPercent: 15 });
    const input = screen.getByRole('spinbutton', {
      name: 'Saved at least (%)',
    }) as HTMLInputElement;
    expect(input.value).toBe('15');
  });

  it('size-gate moves in whole percent: step 1, a stored fraction shows rounded, typed fractions round', () => {
    const { onChange } = row(defOf('core:size-gate'), { minSavingPercent: 11.581583 });
    const input = screen.getByRole('spinbutton', {
      name: 'Saved at least (%)',
    }) as HTMLInputElement;
    expect(input.getAttribute('step')).toBe('1');
    expect(input.value).toBe('12');
    fireEvent.change(input, { target: { value: '7.6' } });
    expect(onChange).toHaveBeenLastCalledWith({ minSavingPercent: 8 });
  });

  it('size-gate summary below full zoom shows whole percent', () => {
    const { container } = row(
      defOf('core:size-gate'),
      { minSavingPercent: 11.581583 },
      { zoom: 'compact' },
    );
    expect(container.textContent).toBe('Saved at least (%) · 12');
  });

  it('keep-languages shows the summary chips "en · de · original · untagged" and focuses the inspector field on click', () => {
    const { onFocus, container } = row(defOf('core:keep-languages'), {
      languages: ['en', 'de'],
      keepOriginal: true,
      keepUntagged: true,
    });
    const chips = [...container.querySelectorAll('.chips-mini > span')].map((c) => c.textContent);
    expect(chips).toEqual(['en', 'de', 'original', 'untagged']);
    expect(container.querySelector('.chips-mini > span')?.getAttribute('title')).toBe('English');
    const summary = screen.getByRole('button', {
      name: 'Languages to keep: en · de · original · untagged. Edit in the inspector',
    });
    fireEvent.click(summary);
    expect(onFocus).toHaveBeenCalledWith('languages');
  });

  it('keep-languages leaves out "original" and "untagged" when they are off and caps the chips at 4', () => {
    const { container } = row(defOf('core:keep-languages'), {
      languages: ['en', 'de', 'fr', 'es', 'it'],
      keepOriginal: false,
      keepUntagged: false,
    });
    const chips = [...container.querySelectorAll('.chips-mini > span')].map((c) => c.textContent);
    expect(chips).toEqual(['en', 'de', 'fr', 'es', '+1']);
  });

  it('at compact zoom the number control collapses to "Quality (CRF) · 24"', () => {
    const { container } = row(defOf('core:encode-video'), encodeSettings, { zoom: 'compact' });
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.textContent).toBe('Quality (CRF) · 24');
  });

  it('at compact zoom a summary is text only; at icon zoom there is nothing', () => {
    const settings = { languages: ['en', 'de'], keepOriginal: true, keepUntagged: true };
    const { container } = row(defOf('core:keep-languages'), settings, { zoom: 'compact' });
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.textContent).toBe('en · de · original · untagged');
    cleanup();
    const icon = row(defOf('core:keep-languages'), settings, { zoom: 'icon' });
    expect(icon.container.innerHTML).toBe('');
  });

  it('a missing value shows the schema default, muted', () => {
    const { container } = row(defOf('core:encode-video'), {}, { zoom: 'compact' });
    expect(container.textContent).toBe('Quality (CRF) · 24');
    cleanup();
    row(defOf('core:encode-video'), {});
    const input = screen.getByRole('spinbutton', { name: 'Quality (CRF)' }) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('24');
  });

  it('a missing required on-node value shows "needs a setting"', () => {
    const base = defOf('core:size-gate');
    const def: NodeInfo = {
      ...base,
      settingsSchema: {
        type: 'object',
        properties: {
          minSavingPercent: {
            type: 'number',
            minimum: 0,
            maximum: 100,
            description: 'Saved at least (%)',
          },
        },
        required: ['minSavingPercent'],
      },
    };
    const issues = [
      {
        code: 'INVALID_SETTINGS',
        severity: 'error',
        message: NEEDS_A_SETTING,
        nodeId: 'n',
        settingPath: 'minSavingPercent',
      } as Issue,
    ];
    const { container } = row(def, {}, { issues });
    expect(container.textContent).toBe('needs a setting');
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('a select control for an enum of at most five values', () => {
    const base = defOf('core:encode-video');
    const def: NodeInfo = { ...base, onNodeSettings: ['codec'] };
    const { onChange } = row(def, encodeSettings);
    const select = screen.getByRole('combobox', { name: 'Target codec' }) as HTMLSelectElement;
    expect(select.classList).toContain('nodrag');
    expect([...select.options].map((o) => o.value)).toEqual(['hevc', 'h264', 'av1']);
    fireEvent.change(select, { target: { value: 'av1' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...encodeSettings, codec: 'av1' });
  });

  it('read-only (a past version, the job page flow): the value is text, never a field that looks editable', () => {
    const { container } = row(defOf('core:encode-video'), encodeSettings, { readOnly: true });
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(container.querySelector('.tc-node-summary')?.textContent).toMatch(/^Quality \(CRF\)/);
  });

  it('settings that are not an object render no row', () => {
    const { container } = row(defOf('core:encode-video'), null);
    expect(container.innerHTML).toBe('');
  });

  describe('Library (core:input-library)', () => {
    const def = () => defOf('core:input-library');

    it('is a select of the libraries bound to settings.libraryId, nodrag nopan', async () => {
      const { onChange } = row(def(), { libraryId: 'l2' });
      const select = (await screen.findByRole('combobox', {
        name: 'Library',
      })) as HTMLSelectElement;
      expect(select.classList).toContain('nodrag');
      expect(select.classList).toContain('nopan');
      expect([...select.options].map((o) => o.textContent)).toEqual(['Shows', 'Movies', 'Anime']);
      expect(select.value).toBe('l2');
      fireEvent.change(select, { target: { value: 'l3' } });
      expect(onChange).toHaveBeenLastCalledWith({ libraryId: 'l3' });
    });

    it('stays a select with more than five libraries', async () => {
      const many = Array.from({ length: 8 }, (_, i) => lib(`x${i}`, `Lib ${i}`));
      mocks.librariesList.mockResolvedValue({ libraries: many });
      row(def(), { libraryId: 'x3' });
      const select = (await screen.findByRole('combobox', {
        name: 'Library',
      })) as HTMLSelectElement;
      expect(select.options.length).toBe(8);
    });

    it('an unset library offers the pick with a placeholder and is marked missing', async () => {
      const { onChange } = row(def(), { libraryId: '' });
      const select = (await screen.findByRole('combobox', {
        name: 'Library',
      })) as HTMLSelectElement;
      expect(select.value).toBe('');
      expect(select.options[0]?.textContent).toBe('—');
      fireEvent.change(select, { target: { value: 'l1' } });
      expect(onChange).toHaveBeenLastCalledWith({ libraryId: 'l1' });
    });

    it('a library that no longer exists is kept visible, not silently replaced', async () => {
      row(def(), { libraryId: 'gone' });
      const select = (await screen.findByRole('combobox', {
        name: 'Library',
      })) as HTMLSelectElement;
      expect(select.value).toBe('gone');
      expect(select.selectedOptions[0]?.textContent).toBe('Missing library');
    });

    it('while the list loads or when it fails it is the inspector-focusing summary', async () => {
      mocks.librariesList.mockRejectedValue(new Error('offline'));
      const { onFocus } = row(def(), { libraryId: 'l1' });
      const button = await screen.findByRole('button', { name: /Library/ });
      fireEvent.click(button);
      expect(onFocus).toHaveBeenCalledWith('libraryId');
      expect(screen.queryByRole('combobox')).toBeNull();
    });

    it('at compact zoom it collapses to "Library · Shows"; at icon zoom nothing', async () => {
      const { container } = row(def(), { libraryId: 'l1' }, { zoom: 'compact' });
      await waitFor(() => expect(container.textContent).toBe('Library · Shows'));
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
      cleanup();
      const icon = row(def(), { libraryId: 'l1' }, { zoom: 'icon' });
      expect(icon.container.innerHTML).toBe('');
    });

    it('read-only shows the library as text, not a disabled select', async () => {
      const { container } = row(def(), { libraryId: 'l1' }, { readOnly: true });
      await waitFor(() =>
        expect(container.querySelector('.tc-node-summary')?.textContent).toMatch(/^Library/),
      );
      expect(screen.queryByRole('combobox')).toBeNull();
    });
  });

  describe('Default audio (core:set-default-track)', () => {
    const def = () => defOf('core:set-default-track');
    const base = { audioLanguages: ['ja', 'en', 'de'], subtitleLanguages: ['en'] };

    it('is a select of at most five languages editing only the first entry', () => {
      const { onChange } = row(def(), base);
      const select = screen.getByRole('combobox', { name: 'Default audio' }) as HTMLSelectElement;
      expect(select.classList).toContain('nodrag');
      expect(select.classList).toContain('nopan');
      expect(select.options.length).toBeLessThanOrEqual(5);
      expect(select.value).toBe('ja');
      // The node's own list comes first, then common languages.
      expect([...select.options].slice(0, 3).map((o) => o.value)).toEqual(['ja', 'en', 'de']);
      fireEvent.change(select, { target: { value: 'fr' } });
      // Only the first entry changes; the rest of the list and the other fields stay.
      expect(onChange).toHaveBeenLastCalledWith({ ...base, audioLanguages: ['fr', 'en', 'de'] });
    });

    it('picking a language that is already later in the list does not duplicate it', () => {
      const { onChange } = row(def(), base);
      fireEvent.change(screen.getByRole('combobox', { name: 'Default audio' }), {
        target: { value: 'de' },
      });
      expect(onChange).toHaveBeenLastCalledWith({ ...base, audioLanguages: ['de', 'en'] });
    });

    it('stays at five options with a long list; an empty list offers a placeholder', () => {
      row(def(), { audioLanguages: ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7'] });
      expect(
        (screen.getByRole('combobox', { name: 'Default audio' }) as HTMLSelectElement).options
          .length,
      ).toBe(5);
      cleanup();
      const { onChange } = row(def(), { audioLanguages: [] });
      const select = screen.getByRole('combobox', { name: 'Default audio' }) as HTMLSelectElement;
      expect(select.value).toBe('');
      fireEvent.change(select, { target: { value: 'en' } });
      expect(onChange).toHaveBeenLastCalledWith({ audioLanguages: ['en'] });
    });

    it('at compact zoom it collapses to "Default audio · ja"', () => {
      const { container } = row(def(), base, { zoom: 'compact' });
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(container.textContent).toBe('Default audio · ja');
    });

    it('keep-languages and reorder-tracks are still chips only, never a select', () => {
      row(defOf('core:keep-languages'), {
        languages: ['en'],
        keepOriginal: true,
        keepUntagged: true,
      });
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.getByRole('button', { name: /^Languages to keep:/ })).toBeTruthy();
      cleanup();
      row(defOf('core:reorder-tracks'), { languages: ['en', 'de'] });
      expect(screen.queryByRole('combobox')).toBeNull();
    });
  });
});
