import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SharedValues } from '@transcoda/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValuesInspector } from './ValuesInspector.tsx';

afterEach(cleanup);

const LANGS = {
  type: 'array',
  description: 'Languages to keep',
  items: { type: 'string', pattern: '^([a-z]{2,3}|unknown)$' },
};

const values: SharedValues = {
  position: { x: 0, y: 0 },
  entries: [
    { name: 'Languages', schema: LANGS, value: ['en', 'de'] },
    { name: 'Quality', schema: { type: 'integer', minimum: 0, maximum: 51 }, value: 24 },
  ],
};

function show(readOnly = false) {
  const h = {
    onRename: vi.fn(),
    onValue: vi.fn(),
    onRemove: vi.fn(),
    onDeleteCard: vi.fn(),
  };
  render(
    <ValuesInspector
      values={values}
      usedBy={(name) => (name === 'Languages' ? 2 : 0)}
      readOnly={readOnly}
      {...h}
    />,
  );
  return h;
}

describe('ValuesInspector', () => {
  it('lists each value with its name, content and use', () => {
    show();
    expect(screen.getByRole('heading', { name: 'Shared values' })).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: 'Name of Languages' }) as HTMLInputElement).value,
    ).toBe('Languages');
    expect(screen.getByText('Used by 2 nodes')).toBeTruthy();
    expect(screen.getByText('Not used yet')).toBeTruthy();
    expect(screen.getByText('de')).toBeTruthy();
  });

  it('a name is renamed when the field is left, not on every key', () => {
    const h = show();
    const name = screen.getByRole('textbox', { name: 'Name of Languages' });
    fireEvent.change(name, { target: { value: 'Audio languages' } });
    expect(h.onRename).not.toHaveBeenCalled();
    fireEvent.blur(name);
    expect(h.onRename).toHaveBeenCalledWith('Languages', 'Audio languages');
  });

  it('editing the content changes the value; Remove and Delete card call back', () => {
    const h = show();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '20' } });
    expect(h.onValue).toHaveBeenLastCalledWith('Quality', 20);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Quality' }));
    expect(h.onRemove).toHaveBeenCalledWith('Quality');
    fireEvent.click(screen.getByRole('button', { name: 'Delete card' }));
    expect(h.onDeleteCard).toHaveBeenCalled();
  });

  it('says how to make a value when there is none', () => {
    cleanup();
    render(
      <ValuesInspector
        values={{ position: { x: 0, y: 0 }, entries: [] }}
        usedBy={() => 0}
        readOnly={false}
        onRename={vi.fn()}
        onValue={vi.fn()}
        onRemove={vi.fn()}
        onDeleteCard={vi.fn()}
      />,
    );
    expect(screen.getByText(/link button next to a node setting/)).toBeTruthy();
  });
});
