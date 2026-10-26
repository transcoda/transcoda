import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NodeInfo } from '@transcoda/contract';
import type { JsonValue } from '@transcoda/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLibrariesCache } from '../../../hooks/useLibraries.ts';
import { catalogFixture } from '../../../test/fixtures/catalog.ts';
import { nodeStateFor } from '../../model/issues.ts';
import { NodeForm } from '../NodeForm.tsx';
import { OnNodeRow } from '../OnNodeRow.tsx';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../../../api/client.ts', () => ({ api: { libraries: { list: mocks.list } } }));

const libraries = [
  { id: 'l1', name: 'Shows' },
  { id: 'l2', name: 'Movies' },
];
const def = catalogFixture.byType.get('core:input-library') as NodeInfo;
const instance = (libraryId: string) => ({
  id: 'n',
  type: 'core:input-library',
  typeVersion: 1,
  settings: { libraryId },
  position: { x: 0, y: 0 },
});

function form(libraryId: string, readOnly = false) {
  const onChange = vi.fn();
  render(
    <NodeForm
      def={def}
      instance={instance(libraryId)}
      issues={new Map()}
      readOnly={readOnly}
      onChange={onChange}
      focusField={null}
    />,
  );
  return onChange;
}

beforeEach(() => {
  resetLibrariesCache();
  mocks.list.mockReset().mockResolvedValue({ libraries });
});
afterEach(cleanup);

describe('inspector Library field', () => {
  it('is a select of library names (not ids) that sets libraryId', async () => {
    const onChange = form('l1');
    const select = (await screen.findByRole('combobox', { name: 'Library' })) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Shows', 'Movies']);
    expect(select.value).toBe('l1');
    fireEvent.change(select, { target: { value: 'l2' } });
    expect(onChange).toHaveBeenLastCalledWith({ libraryId: 'l2' }, 'libraryId');
  });

  it('keeps a missing library visible with a warning instead of dropping it', async () => {
    form('gone');
    const select = (await screen.findByRole('combobox', { name: 'Library' })) as HTMLSelectElement;
    expect(select.value).toBe('gone');
    expect(select.selectedOptions[0]?.textContent).toBe('Missing library');
    expect(screen.getByText(/no longer exists/i)).toBeTruthy();
  });

  it('read-only disables it; a failed list falls back to the plain text field', async () => {
    form('l1', true);
    expect(
      ((await screen.findByRole('combobox', { name: 'Library' })) as HTMLSelectElement).disabled,
    ).toBe(true);
    cleanup();
    resetLibrariesCache();
    mocks.list.mockRejectedValue(new Error('offline'));
    form('l1');
    const input = (await screen.findByRole('textbox', { name: 'Library' })) as HTMLInputElement;
    expect(input.value).toBe('l1');
  });

  it('the card and the inspector share one list: one fetch', async () => {
    render(
      <>
        <OnNodeRow
          def={def}
          instance={instance('l1')}
          state={nodeStateFor('n', [])}
          zoom="full"
          readOnly={false}
          onChange={() => {}}
          onFocus={() => {}}
        />
        <NodeForm
          def={def}
          instance={instance('l1')}
          issues={new Map()}
          readOnly={false}
          onChange={(_: JsonValue) => {}}
          focusField={null}
        />
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByRole('combobox', { name: 'Library' })).toHaveLength(2),
    );
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });
});
