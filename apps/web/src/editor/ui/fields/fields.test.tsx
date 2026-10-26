import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { JsonValue } from '@transcoda/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type FieldDef, fieldsFor } from '../../model/schema-fields.ts';
import { LanguagePicker } from '../LanguagePicker.tsx';
import { defaultText, type FieldProps } from './Field.tsx';
import { LanguageField } from './LanguageField.tsx';
import { LanguageListField } from './LanguageListField.tsx';
import { RawJsonField } from './RawJsonField.tsx';
import { SettingField } from './SettingField.tsx';

afterEach(cleanup);

const LANG = '^([a-z]{2,3}|unknown)$';

/** One optional property per field kind; each label is distinct so label queries stay exact. */
const schema = {
  type: 'object',
  properties: {
    flag: { type: 'boolean', description: 'Keep cover images', default: true },
    bitrate: { type: 'integer', minimum: 32, maximum: 1024, description: 'Bitrate (kbps)' },
    quality: { type: 'integer', minimum: 0, maximum: 63, description: 'Quality (CRF)' },
    method: { type: 'string', enum: ['POST', 'PUT'], description: 'HTTP method' },
    preset: {
      type: 'string',
      enum: ['ultrafast', 'fast', 'medium', 'slow', 'slower', 'veryslow'],
      description: 'Encoder preset',
    },
    url: { type: 'string', format: 'uri', description: 'URL' },
    secret: { type: 'string', format: 'password', description: 'API key' },
    language: { type: 'string', pattern: LANG, description: 'Language' },
    languages: {
      type: 'array',
      items: { type: 'string', pattern: LANG },
      description: 'Languages to keep',
    },
    targets: {
      type: 'array',
      items: { type: 'string', enum: ['tv', 'phone'] },
      description: 'Targets',
    },
    codecs: { type: 'array', items: { type: 'string' }, description: 'Codecs' },
    videoCodecs: {
      type: 'array',
      items: { type: 'string' },
      description: 'Video codecs',
      'x-transcoda': 'video-codecs',
    },
    glob: { type: 'string', description: 'Path glob', default: '**/*.mkv' },
    overrides: { type: 'object', description: 'Setting overrides' },
  },
};

const defs = fieldsFor(schema);

function defOf(key: string): FieldDef {
  const d = defs.find((f) => f.key === key);
  if (!d) throw new Error(`no def ${key}`);
  return d;
}

const ACCESSIBLE_LABEL: Record<string, string> = {
  bitrate: 'Bitrate (kbps)',
  quality: 'Quality (CRF)',
  overrides: 'Setting overrides (raw JSON)',
};

const SAMPLE: Record<string, JsonValue> = {
  flag: true,
  bitrate: 160,
  quality: 24,
  method: 'PUT',
  preset: 'slow',
  url: 'https://example.test/hook',
  secret: 'example-key',
  language: 'de',
  languages: ['en'],
  targets: ['tv'],
  codecs: ['hevc'],
  videoCodecs: ['hevc'],
  glob: '*.mkv',
  overrides: { a: 1 },
};

function renderField(props: Partial<FieldProps> & { def: FieldDef }) {
  const onChange = vi.fn<(v: JsonValue | undefined) => void>();
  const view = render(
    <SettingField value={undefined} issue={null} readOnly={false} onChange={onChange} {...props} />,
  );
  return { onChange, ...view };
}

describe('field controls', () => {
  it('every field kind renders a labelled control, "not set" + clear when optional, and the issue text', () => {
    expect(new Set(defs.map((d) => d.spec.kind))).toEqual(
      new Set([
        'boolean',
        'number',
        'enum',
        'url',
        'password',
        'language',
        'languages',
        'enum-list',
        'string-list',
        'codec-list',
        'text',
        'raw',
      ]),
    );
    for (const def of defs) {
      const name = ACCESSIBLE_LABEL[def.key] ?? def.label;
      const { container, unmount } = renderField({ def, issue: 'Check this value' });
      expect(screen.getAllByLabelText(name).length, def.key).toBeGreaterThan(0);
      expect(container.querySelector(`[data-field="${def.key}"]`), def.key).toBeTruthy();
      expect(
        screen.getByText(
          def.spec.kind === 'language' ? 'Any language' : (defaultText(def) ?? 'not set'),
        ),
        def.key,
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: `Clear ${def.label}` }), def.key).toBeNull();
      expect(screen.getByText('Check this value'), def.key).toBeTruthy();
      unmount();

      const { onChange } = renderField({ def, value: SAMPLE[def.key] });
      expect(screen.queryByText('not set'), def.key).toBeNull();
      expect(screen.queryByText('Any language'), def.key).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: `Clear ${def.label}` }));
      expect(onChange, def.key).toHaveBeenLastCalledWith(undefined);
      cleanup();
    }
  });

  it('a required field never offers "not set" or clear, and read-only fields cannot change', () => {
    const required = { ...defOf('url'), required: true };
    renderField({ def: required, value: 'https://example.test/a' });
    expect(screen.queryByRole('button', { name: 'Clear URL' })).toBeNull();
    cleanup();
    renderField({ def: required });
    expect(screen.queryByText('not set')).toBeNull();
    cleanup();
    renderField({ def: defOf('url'), value: 'https://example.test/a', readOnly: true });
    expect(screen.queryByRole('button', { name: 'Clear URL' })).toBeNull();
    expect(screen.getByLabelText('URL')).toHaveProperty('readOnly', true);
    cleanup();
    renderField({ def: defOf('flag'), value: true, readOnly: true });
    expect(screen.getByRole('switch', { name: 'Keep cover images' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('the issue is announced with the control and marks it invalid', () => {
    renderField({ def: defOf('url'), issue: 'Required' });
    const input = screen.getByLabelText('URL');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toContain('Required');
  });

  it('BooleanField is a switch that flips the value', () => {
    const { onChange } = renderField({ def: defOf('flag'), value: true });
    const sw = screen.getByRole('switch', { name: 'Keep cover images' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('an unset BooleanField shows the default the server applies, and flips from it', () => {
    const { onChange } = renderField({ def: defOf('flag') });
    const sw = screen.getByRole('switch', { name: 'Keep cover images' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    // The unset switch is drawn on: its note says that is the default, never "not set".
    expect(screen.getByText('Default: on')).toBeTruthy();
    expect(screen.queryByText('not set')).toBeNull();
    fireEvent.click(sw);
    expect(onChange).toHaveBeenLastCalledWith(false);
    cleanup();
    renderField({ def: { ...defOf('flag'), default: undefined } });
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('NumberField coerces input, shows the unit and a slider only for small ranges', () => {
    const { onChange } = renderField({ def: defOf('bitrate'), value: 160 });
    const input = screen.getByRole('spinbutton', { name: 'Bitrate (kbps)' });
    expect(input.getAttribute('min')).toBe('32');
    expect(input.getAttribute('max')).toBe('1024');
    expect(input.getAttribute('step')).toBe('1');
    expect(screen.queryByRole('slider')).toBeNull();
    fireEvent.change(input, { target: { value: '192.6' } });
    expect(onChange).toHaveBeenLastCalledWith(192);
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    cleanup();

    const q = renderField({ def: defOf('quality'), value: 24 });
    const slider = screen.getByRole('slider', { name: 'Quality (CRF)' });
    fireEvent.change(slider, { target: { value: '30' } });
    expect(q.onChange).toHaveBeenLastCalledWith(30);
  });

  it('NumberField: a percent field (size gate) moves in whole steps and shows a stored fraction rounded', () => {
    const [percent] = fieldsFor({
      type: 'object',
      properties: {
        minSavingPercent: {
          type: 'number',
          minimum: 0,
          maximum: 100,
          default: 10,
          description: 'Saved at least (%)',
        },
      },
    });
    if (!percent) throw new Error('no field');
    const { onChange } = renderField({ def: percent, value: 11.581583 });
    const input = screen.getByRole('spinbutton', {
      name: 'Saved at least (%)',
    }) as HTMLInputElement;
    const slider = screen.getByRole('slider', { name: 'Saved at least (%)' }) as HTMLInputElement;
    expect(input.getAttribute('step')).toBe('1');
    expect(slider.getAttribute('step')).toBe('1');
    expect(input.value).toBe('12');
    fireEvent.change(input, { target: { value: '7.4' } });
    expect(onChange).toHaveBeenLastCalledWith(7);
    fireEvent.change(slider, { target: { value: '33' } });
    expect(onChange).toHaveBeenLastCalledWith(33);
  });

  it('NumberField shows the default as placeholder when cleared', () => {
    const def = { ...defOf('bitrate'), default: 160 };
    renderField({ def });
    expect(screen.getByLabelText('Bitrate (kbps)').getAttribute('placeholder')).toBe('160');
  });

  it('EnumField: a segmented radio group for ≤ 5 options, a select otherwise', () => {
    const { onChange } = renderField({ def: defOf('method'), value: 'POST' });
    const group = screen.getByRole('radiogroup', { name: 'HTTP method' });
    const post = within(group).getByRole('radio', { name: 'POST' });
    expect(post.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(group).getByRole('radio', { name: 'PUT' }));
    expect(onChange).toHaveBeenLastCalledWith('PUT');
    fireEvent.keyDown(post, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('PUT');
    cleanup();

    const s = renderField({ def: defOf('preset'), value: 'slow' });
    const select = screen.getByRole('combobox', { name: 'Encoder preset' });
    expect(select).toHaveProperty('value', 'slow');
    fireEvent.change(select, { target: { value: 'fast' } });
    expect(s.onChange).toHaveBeenLastCalledWith('fast');
  });

  it('TextField: url and plain text inputs; a password is never read back', () => {
    const { onChange } = renderField({ def: defOf('url') });
    const url = screen.getByLabelText('URL');
    expect(url.getAttribute('type')).toBe('url');
    fireEvent.change(url, { target: { value: 'https://example.test/b' } });
    expect(onChange).toHaveBeenLastCalledWith('https://example.test/b');
    cleanup();

    renderField({ def: defOf('glob') });
    expect(screen.getByLabelText('Path glob').getAttribute('placeholder')).toBe('**/*.mkv');
    cleanup();

    const p = renderField({ def: defOf('secret'), value: 'example-key' });
    const secret = screen.getByLabelText('API key');
    expect(secret.getAttribute('type')).toBe('password');
    expect(secret).toHaveProperty('value', '');
    fireEvent.change(secret, { target: { value: 'example-key-2' } });
    expect(p.onChange).toHaveBeenLastCalledWith('example-key-2');
  });

  it('EnumListField toggles chips in option order', () => {
    const { onChange } = renderField({ def: defOf('targets'), value: ['phone'] });
    const tv = screen.getByRole('button', { name: 'tv' });
    expect(tv.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(tv);
    expect(onChange).toHaveBeenLastCalledWith(['tv', 'phone']);
    fireEvent.click(screen.getByRole('button', { name: 'phone' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('StringListField adds on Enter and removes a chip', () => {
    const { onChange } = renderField({ def: defOf('codecs'), value: ['hevc'] });
    const input = screen.getByRole('textbox', { name: 'Add to Codecs' });
    fireEvent.change(input, { target: { value: ' av1 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['hevc', 'av1']);
    onChange.mockClear();
    fireEvent.change(input, { target: { value: 'hevc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove hevc' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('RawJsonField shows "Not valid JSON" for a bad edit and does not call onChange', () => {
    const onChange = vi.fn<(v: JsonValue | undefined) => void>();
    render(
      <RawJsonField
        def={defOf('overrides')}
        value={{ a: 1 }}
        issue="Expected object, received number"
        readOnly={false}
        onChange={onChange}
      />,
    );
    const area = screen.getByRole('textbox', { name: 'Setting overrides (raw JSON)' });
    expect(JSON.parse((area as HTMLTextAreaElement).value)).toEqual({ a: 1 });
    expect(screen.getByText('Expected object, received number')).toBeTruthy();
    fireEvent.change(area, { target: { value: '{"a": ' } });
    const parseLine = screen.getByText('Not valid JSON');
    expect(parseLine.querySelector('[data-icon="alert"]')).toBeTruthy();
    expect(area.getAttribute('aria-invalid')).toBe('true');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(area, { target: { value: '{"a": 2}' } });
    expect(screen.queryByText('Not valid JSON')).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({ a: 2 });
  });

  it('RawJsonField edits a non-object value without throwing', () => {
    for (const value of [null, 3, ['x']] as JsonValue[]) {
      render(
        <RawJsonField
          def={defOf('overrides')}
          value={value}
          issue={null}
          readOnly={false}
          onChange={() => {}}
        />,
      );
      const area = screen.getByRole('textbox', { name: 'Setting overrides (raw JSON)' });
      expect(JSON.parse((area as HTMLTextAreaElement).value)).toEqual(value);
      cleanup();
    }
  });

  it('LanguageListField adds "German de" from the picker and removes a chip', () => {
    const onChange = vi.fn<(v: JsonValue | undefined) => void>();
    const props = { def: defOf('languages'), issue: null, readOnly: false, onChange };
    const { rerender } = render(<LanguageListField {...props} value={['en', 'unknown']} />);
    expect(screen.getByText('English')).toBeTruthy();
    expect(screen.getByText('Untagged')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add language' }));
    const dialog = screen.getByRole('dialog', { name: 'Add language' });
    const search = within(dialog).getByRole('searchbox', { name: 'Search languages' });
    expect(document.activeElement).toBe(search);
    expect(within(dialog).queryByRole('button', { name: 'English en' })).toBeNull();
    fireEvent.change(search, { target: { value: 'germ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'German de' }));
    expect(onChange).toHaveBeenLastCalledWith(['en', 'unknown', 'de']);
    expect(screen.queryByRole('dialog')).toBeNull();

    rerender(<LanguageListField {...props} value={['en', 'de']} />);
    const chip = screen.getByText('German').closest('.lang-chip');
    expect(chip?.textContent).toContain('de');
    fireEvent.click(screen.getByRole('button', { name: 'Remove German' }));
    expect(onChange).toHaveBeenLastCalledWith(['en']);
  });

  it('LanguageField: unset reads "Any language" and is never aliased to "Original (from data)"', () => {
    const onChange = vi.fn<(v: JsonValue | undefined) => void>();
    const props = { def: defOf('language'), issue: null, readOnly: false, onChange };
    const { rerender } = render(<LanguageField {...props} value="de" originalOption />);
    const button = screen.getByLabelText('Language');
    expect(button.textContent).toContain('German');
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Pick a language' });
    expect(within(dialog).queryByRole('button', { name: 'Original (from data)' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turkish tr' }));
    expect(onChange).toHaveBeenLastCalledWith('tr');
    fireEvent.click(screen.getByRole('button', { name: 'Clear Language' }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);

    rerender(<LanguageField {...props} value={undefined} originalOption />);
    expect(screen.getByLabelText('Language').textContent).toBe('Any language');
    expect(screen.queryByText(/Original/)).toBeNull();
  });

  it('a hint under the label is part of the control description', () => {
    const def: FieldDef = { ...defOf('glob'), hint: 'Empty means every file' };
    renderField({ def, issue: 'Check this value' });
    const input = screen.getByLabelText('Path glob');
    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ');
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toEqual(['Empty means every file', 'Check this value']);
  });

  it('enum options show humanised words but store the value', () => {
    const def: FieldDef = {
      ...defOf('method'),
      spec: { kind: 'enum', options: ['keep', 'drop-incompatible'], control: 'segmented' },
    };
    const { onChange } = renderField({ def, value: 'keep' });
    fireEvent.click(screen.getByRole('radio', { name: 'Drop incompatible' }));
    expect(onChange).toHaveBeenLastCalledWith('drop-incompatible');
    expect(screen.getByRole('radio', { name: 'keep' })).toBeTruthy();
    cleanup();
    const select = renderField({
      def: { ...def, spec: { kind: 'enum', options: ['already_target_codec'], control: 'select' } },
      value: 'already_target_codec',
    });
    expect(screen.getByRole('option', { name: 'Already target codec' })).toBeTruthy();
    expect(select.onChange).not.toHaveBeenCalled();
    cleanup();
    renderField({
      def: { ...def, spec: { kind: 'enum-list', options: ['smart-tv'] } },
      value: [],
    });
    expect(screen.getByRole('button', { name: 'Smart tv' })).toBeTruthy();
  });

  it('an unset slider shows the default, muted, and says so', () => {
    renderField({ def: { ...defOf('quality'), default: 24 } });
    const slider = screen.getByRole('slider', { name: 'Quality (CRF)' });
    expect(slider).toHaveProperty('value', '24');
    expect(slider.getAttribute('aria-valuetext')).toBe('24 (default)');
    expect(screen.getByText('default')).toBeTruthy();
    cleanup();
    renderField({ def: { ...defOf('quality'), default: 24 }, value: 30 });
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBeNull();
    expect(screen.queryByText('default')).toBeNull();
  });

  it('a password field clears with an empty input and forgets its text when the value is cleared', () => {
    const onChange = vi.fn<(v: JsonValue | undefined) => void>();
    const props = { def: defOf('secret'), issue: null, readOnly: false, onChange };
    const { rerender } = render(<SettingField {...props} value="example-key" />);
    const input = screen.getByLabelText('API key');
    expect(input.getAttribute('autocomplete')).toBe('new-password');
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(onChange).toHaveBeenLastCalledWith('abc');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    fireEvent.change(input, { target: { value: 'xyz' } });
    rerender(<SettingField {...props} value="xyz" />);
    rerender(<SettingField {...props} value={undefined} />);
    expect(screen.getByLabelText('API key')).toHaveProperty('value', '');
  });
});

describe('TextField with a redacted (write-only) webhook URL', () => {
  const REDACTED = 'https://hooks.example.test/…';

  it('reads like a saved secret, keeps the redacted value until typed over and goes back to it when emptied', () => {
    const onChange = vi.fn<(v: JsonValue | undefined) => void>();
    const props = { def: defOf('url'), issue: null, readOnly: false, onChange };
    const { rerender } = render(<SettingField {...props} value={REDACTED} />);
    const input = screen.getByLabelText('URL');
    expect(input).toHaveProperty('value', '');
    expect(input.getAttribute('placeholder')).toBe(`Saved (${REDACTED}); type to replace`);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'https://hooks.example.test/new' } });
    expect(onChange).toHaveBeenLastCalledWith('https://hooks.example.test/new');
    rerender(<SettingField {...props} value="https://hooks.example.test/new" />);
    expect(screen.getByLabelText('URL')).toHaveProperty('value', 'https://hooks.example.test/new');

    fireEvent.change(screen.getByLabelText('URL'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(REDACTED);

    // Undo back to the saved value: the typed text goes, the placeholder returns.
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://x.test/y' } });
    rerender(<SettingField {...props} value={REDACTED} />);
    expect(screen.getByLabelText('URL')).toHaveProperty('value', '');
    expect(screen.getByLabelText('URL').getAttribute('placeholder')).toBe(
      `Saved (${REDACTED}); type to replace`,
    );
  });

  it('a plain URL is still read back', () => {
    render(
      <SettingField
        def={defOf('url')}
        value="https://hooks.example.test/t0k3n"
        issue={null}
        readOnly={false}
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText('URL')).toHaveProperty(
      'value',
      'https://hooks.example.test/t0k3n',
    );
  });
});

describe('LanguagePicker', () => {
  it('filters by name or code and picks the first match on Enter', () => {
    const onPick = vi.fn();
    render(<LanguagePicker open exclude={['de']} onPick={onPick} onClose={() => {}} />);
    const search = screen.getByRole('searchbox', { name: 'Search languages' });
    fireEvent.change(search, { target: { value: 'tr' } });
    expect(screen.getByRole('button', { name: 'Turkish tr' })).toBeTruthy();
    fireEvent.change(search, { target: { value: 'ger' } });
    expect(screen.queryByRole('button', { name: 'German de' })).toBeNull();
    fireEvent.change(search, { target: { value: 'japan' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('ja');
  });

  it('says so when nothing matches and offers the original only when asked', () => {
    const { rerender } = render(
      <LanguagePicker open exclude={[]} onPick={() => {}} onClose={() => {}} />,
    );
    expect(screen.queryByRole('button', { name: 'Original (from data)' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzzz' } });
    expect(screen.getByText('No language matches')).toBeTruthy();
    rerender(
      <LanguagePicker open exclude={[]} originalOption onPick={() => {}} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Original (from data)' })).toBeTruthy();
  });
});
