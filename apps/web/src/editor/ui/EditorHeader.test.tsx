import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { WorkflowSummary } from '@transcoda/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '../../test/render.tsx';
import { EditorHeader, versionPill } from './EditorHeader.tsx';

afterEach(cleanup);

const workflow = {
  id: 'wf1',
  name: 'TV cleanup',
  kind: 'workflow',
  currentVersion: 3,
  active: null,
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
    />,
  );
  return { onTry };
}

const items = () =>
  within(screen.getByRole('menu', { name: 'More actions' }))
    .getAllByRole('menuitem')
    .map((i) => i.textContent);

describe('versionPill', () => {
  const at = new Date(Date.now() - 8 * 60_000).toISOString();
  const active = (version: number, runnable = true) => ({
    version,
    runnable,
    activatedAt: at,
    activatedBy: 'u1',
  });

  it('says the version, whether it runs on files and when it was saved, in one line', () => {
    expect(versionPill({ kind: 'workflow', active: null }, 2, at, false)).toEqual({
      text: 'v2 · Not active · saved 8 min ago',
      tone: 'neutral',
    });
    expect(versionPill({ kind: 'workflow', active: active(2) }, 2, at, false)).toEqual({
      text: 'Active v2 · saved 8 min ago',
      tone: 'active',
    });
    expect(versionPill({ kind: 'workflow', active: active(2) }, 3, at, true)).toEqual({
      text: 'v3 · Active v2 · unsaved changes',
      tone: 'neutral',
    });
    expect(versionPill({ kind: 'workflow', active: active(2, false) }, 2, at, false)).toEqual({
      text: "Active v2 · can't run · saved 8 min ago",
      tone: 'danger',
    });
  });

  it('a sub-workflow has no activation state', () => {
    expect(versionPill({ kind: 'subworkflow', active: null }, 4, at, false).text).toBe(
      'v4 · saved 8 min ago',
    );
  });
});

describe('EditorHeader', () => {
  it('wide: Undo, Redo, "Dry run on a file" and Save inline; "Run on a file", activation and "Save with a note…" in "More actions"', () => {
    const onRun = vi.fn();
    const onActivate = vi.fn();
    header({
      readOnly: false,
      dirty: true,
      onRun,
      noteMenu: true,
      activationItems: [{ label: 'Activate v3', onSelect: onActivate }],
    });
    const inline = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(inline.slice(-5)).toEqual(['Undo', 'Redo', 'Save, then try', 'Save v4', 'More actions']);
    expect(screen.queryByRole('button', { name: 'Run on a file' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Activate/ })).toBeNull();
    const save = screen.getByRole('button', { name: 'Save v4' });
    expect(save.className).toContain('btn-primary');

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(items()).toEqual(['Run on a file', 'Activate v3', 'Save with a note…']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run on a file' }));
    expect(onRun).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Activate v3' }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save with a note…' }));
    expect(screen.getByRole('dialog', { name: 'Save with a note' })).toBeTruthy();
  });

  it('wide: Save is secondary with nothing to save, and "Save with a note…" is blocked', () => {
    header({ readOnly: false, noteMenu: true });
    expect(screen.getByRole('button', { name: 'Save v4' }).className).toContain('btn-secondary');
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(
      screen.getByRole('menuitem', { name: 'Save with a note…' }).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('the version pill carries the activation state; no separate "Not active" chip', () => {
    header({ workflow: { ...workflow, active: null } as WorkflowSummary });
    expect(screen.getByRole('button', { name: /^v3 · Not active · saved/ })).toBeTruthy();
    expect(screen.getAllByText(/Not active/)).toHaveLength(1);
  });

  it("an active version that can't run has the danger pill with the first active issue as its tooltip", () => {
    header({
      workflow: {
        ...workflow,
        active: { version: 3, runnable: false, activatedAt: '', activatedBy: 'u1' },
      } as WorkflowSummary,
      activeIssue: 'Needs a plugin.',
    });
    const pill = screen.getByRole('button', { name: /^Active v3 · can't run/ });
    expect(pill.className).toContain('is-danger');
    expect(pill.title).toBe('Needs a plugin.');
  });

  it('compact: undo, redo, Try, Run and activation move into one "More actions" menu and Save (read-only here) is gone', () => {
    const { onTry } = header({
      compact: true,
      activationItems: [{ label: 'Deactivate', onSelect: () => {} }],
    });
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Save v/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /try/i })).toBeNull();
    const more = screen.getByRole('button', { name: 'More actions' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(items()).toEqual(['Undo', 'Redo', 'Dry run on a file', 'Run on a file', 'Deactivate']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Dry run on a file' }));
    expect(onTry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('compact: one row for the name and the menu, the version pill after them as the status line', () => {
    header({ compact: true });
    const head = document.querySelector('header.editor-head.is-compact') as HTMLElement;
    const order = [...head.children].map((c) => c.className);
    expect(order).toEqual(['crumb', 'editor-head-end', 'version-pill-wrap']);
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

  it('"Run on a file" is blocked with its reason when no version is active', () => {
    header({ runBlockedReason: 'Activate a version to run for real' });
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const run = screen.getByRole('menuitem', { name: 'Run on a file' });
    expect(run.getAttribute('aria-disabled')).toBe('true');
    expect(run.title).toBe('Activate a version to run for real');
  });

  it('a disabled "Dry run on a file" has its reason as a hidden description; an enabled one has none', () => {
    header({ onTry: undefined, tryBlockedReason: 'Add an input first' });
    const dry = screen.getByRole('button', { name: 'Dry run on a file' }) as HTMLButtonElement;
    expect(dry.disabled).toBe(true);
    expect(dry.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('eye');
    const described = dry.getAttribute('aria-describedby');
    expect(described && document.getElementById(described)?.textContent).toBe('Add an input first');
    cleanup();
    header({ onRun: () => {} });
    expect(
      screen.getByRole('button', { name: 'Dry run on a file' }).hasAttribute('aria-describedby'),
    ).toBe(false);
  });

  it('a sub-workflow has no "Run on a file" (and no menu with nothing in it)', () => {
    header({ workflow: { ...workflow, kind: 'subworkflow' } as WorkflowSummary, onRun: vi.fn() });
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    expect(screen.queryByText('Run on a file')).toBeNull();
  });
});
