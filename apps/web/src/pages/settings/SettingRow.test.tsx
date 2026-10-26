import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingRow } from './SettingRow.tsx';

afterEach(cleanup);

describe('SettingRow', () => {
  it('labels an editable control and says where the value comes from', () => {
    render(
      <SettingRow
        label="Server name"
        hint="Shown in the top bar"
        source={{ kind: 'database' }}
        htmlFor="n"
      >
        <input id="n" />
      </SettingRow>,
    );
    expect(screen.getByRole('textbox', { name: 'Server name' })).toBeTruthy();
    expect(screen.getByText('Shown in the top bar')).toBeTruthy();
    expect(screen.getByText('Set here')).toBeTruthy();
  });

  it('a read-only env value shows the variable in <code> and links to the docs', () => {
    const { container } = render(
      <SettingRow
        label="Public URL"
        source={{ kind: 'env', variable: 'TRANSCODA_PUBLIC_URL', set: true }}
      >
        https://t.example
      </SettingRow>,
    );
    const source = container.querySelector('.setting-source') as HTMLElement;
    expect(source.textContent).toContain('From TRANSCODA_PUBLIC_URL');
    expect(source.querySelector('code')?.textContent).toBe('TRANSCODA_PUBLIC_URL');
    const link = screen.getByRole('link', { name: 'Docs for TRANSCODA_PUBLIC_URL' });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/transcoda/transcoda/blob/main/docs/env.md#server',
    );
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('an unset env variable reads "Default · set X to change"', () => {
    const { container } = render(
      <SettingRow
        label="Stall hours"
        source={{ kind: 'env', variable: 'TRANSCODA_HEALTH_STALL_HOURS', set: false }}
      >
        6
      </SettingRow>,
    );
    const source = container.querySelector('.setting-source') as HTMLElement;
    expect(source.textContent).toContain('Default · set TRANSCODA_HEALTH_STALL_HOURS to change');
    expect(source.querySelector('code')?.textContent).toBe('TRANSCODA_HEALTH_STALL_HOURS');
  });
});
