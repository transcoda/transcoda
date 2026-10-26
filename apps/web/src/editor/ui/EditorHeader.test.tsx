import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { WorkflowSummary } from '@transcoda/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '../../test/render.tsx';
import { EditorHeader } from './EditorHeader.tsx';

afterEach(cleanup);

const workflow = {
  id: 'wf1',
  name: 'TV cleanup',
  kind: 'workflow',
  currentVersion: 3,
  usedBy: [],
} as unknown as WorkflowSummary;

function header(props: Partial<Parameters<typeof EditorHeader>[0]> = {}) {
  const onTry = vi.fn();
  renderAt(
    '/workflows/wf1',
    <EditorHeader
      workflow={workflow}
      savedVersion={3}
      savedAt={new Date().toISOString()}
      dirty={false}
      readOnly
      saving={false}
      onSave={() => {}}
      onRename={() => {}}
      onUndo={() => {}}
      onRedo={() => {}}
      onTry={onTry}
      {...props}
    >
      <span>activation</span>
    </EditorHeader>,
  );
  return { onTry };
}

describe('EditorHeader', () => {
  it('compact: undo, redo and Try move into one "More actions" menu and Save (read-only here) is gone', () => {
    const { onTry } = header({ compact: true });
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Save v/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /try/i })).toBeNull();
    const more = screen.getByRole('button', { name: 'More actions' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu', { name: 'More actions' });
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent);
    expect(items).toEqual(['Undo', 'Redo', 'Dry run on a file', 'Run on a file']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Dry run on a file' }));
    expect(onTry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('compact: Escape closes the menu and returns focus to its button', () => {
    header({ compact: true });
    const more = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(more);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('compact: a disabled item says why', () => {
    header({ compact: true, onTry: undefined, tryBlockedReason: 'No catalogue' });
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const item = screen.getByRole('menuitem', { name: 'Dry run on a file' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.getAttribute('title')).toBe('No catalogue');
  });

  it('wide: "Run on a file" follows "Dry run on a file" and calls onRun', () => {
    const onRun = vi.fn();
    header({ onRun });
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    const at = buttons.indexOf('Dry run on a file');
    expect(at).toBeGreaterThan(-1);
    expect(buttons[at + 1]).toBe('Run on a file');
    fireEvent.click(screen.getByRole('button', { name: 'Run on a file' }));
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('a dry run shows the eye and a real run the play icon, so the two buttons look different', () => {
    header({ onRun: vi.fn() });
    const icon = (name: string) =>
      screen.getByRole('button', { name }).querySelector('[data-icon]')?.getAttribute('data-icon');
    expect(icon('Dry run on a file')).toBe('eye');
    expect(icon('Run on a file')).toBe('play');
  });

  it('"Run on a file" is disabled with its reason when no version is active', () => {
    header({ runBlockedReason: 'Activate a version to run for real' });
    const run = screen.getByRole('button', { name: 'Run on a file' }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(run.title).toBe('Activate a version to run for real');
    const described = run.getAttribute('aria-describedby');
    expect(described && document.getElementById(described)?.textContent).toBe(
      'Activate a version to run for real',
    );
  });

  it('a disabled "Dry run on a file" has its reason as a hidden description; enabled buttons have none', () => {
    header({ onTry: undefined, tryBlockedReason: 'Add an input first' });
    const dry = screen.getByRole('button', { name: 'Dry run on a file' }) as HTMLButtonElement;
    expect(dry.disabled).toBe(true);
    const described = dry.getAttribute('aria-describedby');
    expect(described && document.getElementById(described)?.textContent).toBe('Add an input first');
    cleanup();
    header({ onRun: () => {} });
    expect(
      screen.getByRole('button', { name: 'Dry run on a file' }).hasAttribute('aria-describedby'),
    ).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Run on a file' }).hasAttribute('aria-describedby'),
    ).toBe(false);
  });

  it('compact: a blocked "Run on a file" says why', () => {
    header({ compact: true, runBlockedReason: 'Activate a version to run for real' });
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const item = screen.getByRole('menuitem', { name: 'Run on a file' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.getAttribute('title')).toBe('Activate a version to run for real');
  });

  it('a sub-workflow has no "Run on a file"', () => {
    header({ workflow: { ...workflow, kind: 'subworkflow' } as WorkflowSummary, onRun: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Run on a file' })).toBeNull();
  });

  it('wide: keeps the inline buttons and has no overflow menu', () => {
    header();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });
});
