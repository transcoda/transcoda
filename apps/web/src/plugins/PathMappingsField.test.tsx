import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ testMapping: vi.fn() }));
vi.mock('../api/client.ts', () => ({
  api: { plugins: { testMapping: mocks.testMapping } },
  isDefinedError: (e: unknown) => typeof e === 'object' && e !== null && 'defined' in e,
  safe: async (p: Promise<unknown>) => {
    try {
      return [null, await p];
    } catch (e) {
      return [e, undefined];
    }
  },
}));

import type { FieldDef } from '../editor/model/schema-fields.ts';
import { mappingsHint, PathMappingsField } from './PathMappingsField.tsx';

afterEach(cleanup);

// The Jellyfin plugin's own description had the direction backwards; it is not shown.
const def = {
  key: 'pathMappings',
  label: 'Paths as Transcoda sees them → paths as Jellyfin sees them',
  required: false,
  spec: { kind: 'path-mappings' },
} as unknown as FieldDef;

function renderField(value = [{ remote: '/shows', local: '/data/shows' }]) {
  const onChange = vi.fn();
  render(
    <PathMappingsField
      plugin="jellyfin"
      service="Jellyfin"
      def={def}
      value={value}
      onChange={onChange}
      issue={null}
    />,
  );
  return { onChange };
}

describe('PathMappingsField (#46)', () => {
  it('the help line names the fields in their order, not the plugin text', () => {
    renderField();
    const group = screen.getByRole('group', { name: 'Path mappings' });
    expect(group.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText(mappingsHint('Jellyfin'))).toBeTruthy();
    expect(mappingsHint('Jellyfin')).toMatch(
      /first the path as Jellyfin sees it, then the same folder as Transcoda sees it/,
    );
    expect(screen.queryByText(/Transcoda sees them → /)).toBeNull();
  });

  it('each mapping is a block: a label per path, the buttons on their own row, the answer below', async () => {
    mocks.testMapping.mockResolvedValue({
      ok: false,
      message: '/data/shows is not inside a library folder; add a library for it first',
    });
    const { onChange } = renderField();
    const block = screen.getByRole('group', { name: 'Mapping 1' });
    const inBlock = within(block);
    expect((inBlock.getByLabelText('Path in Jellyfin') as HTMLInputElement).value).toBe('/shows');
    expect((inBlock.getByLabelText('Path in Transcoda') as HTMLInputElement).value).toBe(
      '/data/shows',
    );
    // The paths and the buttons are separate rows of the block.
    const fields = block.querySelector('.plugin-mapping-fields') as HTMLElement;
    const actions = block.querySelector('.plugin-mapping-actions') as HTMLElement;
    expect(fields.contains(inBlock.getByRole('button', { name: 'Test mapping 1' }))).toBe(false);
    expect(actions.contains(inBlock.getByRole('button', { name: 'Test mapping 1' }))).toBe(true);
    expect(actions.contains(inBlock.getByRole('button', { name: 'Remove mapping 1' }))).toBe(true);

    fireEvent.click(inBlock.getByRole('button', { name: 'Test mapping 1' }));
    const status = await inBlock.findByRole('status');
    expect(status.textContent).toContain('is not inside a library folder');
    // The answer sits after the button row, not in it.
    expect(actions.contains(status)).toBe(false);
    expect(actions.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(status.className).toContain('is-fail');

    fireEvent.change(inBlock.getByLabelText('Path in Transcoda'), {
      target: { value: '/media/shows' },
    });
    expect(onChange).toHaveBeenLastCalledWith([{ remote: '/shows', local: '/media/shows' }]);
  });

  it('with no mappings it says paths are used as they are', () => {
    renderField([]);
    expect(screen.getByText('No mappings: paths are used as they are.')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Mapping 1' })).toBeNull();
  });

  it('the css stacks the paths full width on a phone and wraps the answer', () => {
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
    const rule = (selector: string) => {
      const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return css.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    };
    expect(rule('.plugin-mapping-fields')).toMatch(
      /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,/,
    );
    expect(rule('.plugin-mapping-fields .input')).toMatch(/width:\s*100%/);
    expect(rule('.plugin-mapping')).toMatch(/min-width:\s*0/);
    expect(rule('.plugin-test-line')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
