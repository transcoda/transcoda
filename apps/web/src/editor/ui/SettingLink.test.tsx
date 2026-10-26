import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { NodeInstance, SharedValue } from '@transcoda/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogFixture } from '../../test/fixtures/catalog.ts';
import { NodeForm, type Sharing } from './NodeForm.tsx';

afterEach(cleanup);

const def = catalogFixture.byType.get('core:keep-languages');
if (!def) throw new Error('fixture');
const props = def.settingsSchema as { properties: Record<string, SharedValue['schema']> };
const LANGS = props.properties.languages ?? null;

function form(links: Record<string, string> | undefined, values: SharedValue[]) {
  const instance: NodeInstance = {
    id: 'kl',
    type: def?.type ?? '',
    typeVersion: 1,
    settings: { languages: ['en'], keepOriginal: true },
    position: { x: 0, y: 0 },
    ...(links ? { links } : {}),
  };
  const sharing: Sharing = {
    values,
    usedBy: vi.fn(() => 3),
    onFollow: vi.fn(),
    onUnlink: vi.fn(),
    onShare: vi.fn(),
    onValue: vi.fn(),
  };
  const onChange = vi.fn();
  render(
    <NodeForm
      def={def ?? null}
      instance={instance}
      issues={new Map()}
      readOnly={false}
      onChange={onChange}
      focusField={null}
      sharing={sharing}
    />,
  );
  return { sharing, onChange };
}

const field = (key: string) => document.querySelector(`[data-field="${key}"]`) as HTMLElement;

describe('linking a setting to a shared value', () => {
  it('an unlinked setting offers a new value and every value of the same kind', () => {
    const { sharing } = form(undefined, [
      { name: 'Languages', schema: LANGS, value: ['en', 'de'] },
      { name: 'Level', schema: { type: 'number' }, value: 3 },
    ]);
    fireEvent.click(within(field('languages')).getByRole('button', { name: /^Share Languages/ }));
    const menu = screen.getByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((b) => b.textContent),
    ).toEqual(['Follow Languages (en, de)', 'New shared value']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'New shared value' }));
    expect(sharing.onShare).toHaveBeenCalledWith('languages', 'Languages to keep', LANGS);
    fireEvent.click(within(field('languages')).getByRole('button', { name: /^Share Languages/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Follow Languages (en, de)' }));
    expect(sharing.onFollow).toHaveBeenCalledWith('languages', 'Languages');
  });

  it('a linked setting shows the value, edits the value and can stop following it', () => {
    const { sharing, onChange } = form({ languages: 'Languages' }, [
      { name: 'Languages', schema: LANGS, value: ['en', 'de'] },
    ]);
    const box = field('languages');
    const chip = within(box).getByRole('button', { name: /follows the shared value Languages/ });
    expect(chip.textContent).toBe('Languages');
    expect(within(box).getByText('Also used by 2 other nodes')).toBeTruthy();
    fireEvent.click(within(box).getAllByRole('button', { name: /Remove/ })[0] as HTMLElement);
    expect(sharing.onValue).toHaveBeenCalledWith('Languages', ['de']);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop following Languages' }));
    expect(sharing.onUnlink).toHaveBeenCalledWith('languages');
  });

  it('without sharing (a read-only view) there is no link control', () => {
    render(
      <NodeForm
        def={def ?? null}
        instance={{
          id: 'kl',
          type: def?.type ?? '',
          typeVersion: 1,
          settings: { languages: ['en'] },
          position: { x: 0, y: 0 },
        }}
        issues={new Map()}
        readOnly
        onChange={() => {}}
        focusField={null}
      />,
    );
    expect(screen.queryByRole('button', { name: /^Share/ })).toBeNull();
  });
});
