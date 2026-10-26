import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => vi.fn());
vi.mock('../../../api/client.ts', () => ({ api: { system: { capabilities } } }));

import type { FieldDef } from '../../model/schema-fields.ts';
import { EnumListField } from './EnumListField.tsx';

afterEach(cleanup);

const def = (key: string): FieldDef => ({
  key,
  label: 'Target devices',
  unit: null,
  required: false,
  default: [],
  spec: { kind: 'enum-list', options: ['android-tv', 'chrome', 'new-box'] },
  schema: {},
});

describe('EnumListField device profiles', () => {
  it('labels `targets` chips with the device profile names; unknown ids show as the id', async () => {
    capabilities.mockResolvedValue({
      available: false,
      path: 'ffmpeg',
      error: 'x',
      deviceProfiles: [
        { id: 'android-tv', name: 'Android TV (Google TV / Shield class)' },
        { id: 'chrome', name: 'Chrome (desktop)' },
      ],
    });
    render(
      <EnumListField
        def={def('targets')}
        value={['chrome']}
        onChange={() => {}}
        issue={null}
        readOnly={false}
      />,
    );
    expect(
      await screen.findByRole('button', { name: 'Android TV (Google TV / Shield class)' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Chrome (desktop)' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByRole('button', { name: 'new-box' })).toBeTruthy();
    expect(capabilities).toHaveBeenCalledTimes(1);
  });

  it('other enum lists keep their humanised labels and never ask for capabilities', async () => {
    capabilities.mockClear();
    render(
      <EnumListField
        def={def('kinds')}
        value={[]}
        onChange={() => {}}
        issue={null}
        readOnly={false}
      />,
    );
    expect(screen.getByRole('button', { name: 'Android tv' })).toBeTruthy();
    await waitFor(() => expect(capabilities).not.toHaveBeenCalled());
  });
});
