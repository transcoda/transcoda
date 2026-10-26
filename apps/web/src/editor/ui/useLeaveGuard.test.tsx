import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { GuardedLink, guardedRun, useGuardedNavigate } from '../../lib/navigation.tsx';
import { LeaveDialog } from './LeaveDialog.tsx';
import { useLeaveGuard } from './useLeaveGuard.ts';

function Harness({
  dirty,
  save = async () => true,
  error = null,
  onRun = () => {},
}: {
  dirty: boolean;
  save?(): Promise<boolean>;
  error?: string | null;
  onRun?(): void;
}) {
  const [saving, setSaving] = useState(false);
  const leave = useLeaveGuard({
    dirty,
    save: async () => {
      setSaving(true);
      try {
        return await save();
      } finally {
        setSaving(false);
      }
    },
  });
  const go = useGuardedNavigate();
  return (
    <>
      <GuardedLink href="/elsewhere">Elsewhere</GuardedLink>
      <GuardedLink href="/workflows/wf1">Here</GuardedLink>
      <button type="button" onClick={() => go('/by-code')}>
        By code
      </button>
      <button type="button" onClick={() => guardedRun(onRun)}>
        Log out
      </button>
      <LeaveDialog
        open={leave.pending !== null}
        saving={saving}
        error={error}
        onSaveAndLeave={() => void leave.saveAndLeave()}
        onLeave={leave.confirmLeave}
        onStay={leave.cancelLeave}
      />
    </>
  );
}

/** Like `renderAt`, but `rerender` keeps the router (it is the wrapper, not part of `ui`). */
function renderAt(path: string, ui: ReactNode) {
  const memory = memoryLocation({ path, record: true });
  const view = render(ui, {
    wrapper: ({ children }) => (
      <Router hook={memory.hook} searchHook={memory.searchHook}>
        {children}
      </Router>
    ),
  });
  return {
    ...view,
    navigate: (to: string) => act(() => memory.navigate(to)),
    location: () => memory.history.at(-1) ?? path,
  };
}

const leaveDialog = () => screen.getByRole('dialog', { name: 'Leave without saving?' });

afterEach(() => {
  cleanup();
});

describe('useLeaveGuard', () => {
  it('navigating away with a dirty draft opens "Leave without saving?"; Stay keeps the route; Leave navigates; Save and leave saves first', async () => {
    const save = vi.fn(async () => true);
    const view = renderAt('/workflows/wf1', <Harness dirty save={save} />);

    fireEvent.click(screen.getByRole('link', { name: 'Elsewhere' }));
    const dialog = leaveDialog();
    expect(within(dialog).getByText('Your unsaved changes will be lost.')).toBeTruthy();
    const footer = dialog.querySelector('.dialog-footer') as HTMLElement;
    const buttons = within(footer)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(buttons).toEqual(['Stay', 'Leave', 'Save and leave']);
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Save and leave' }).className).toContain(
      'btn-primary',
    );
    // The safe choice has the focus.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Stay' }));
    expect(view.location()).toBe('/workflows/wf1');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay' }));
    expect(screen.queryByRole('dialog', { name: 'Leave without saving?' })).toBeNull();
    expect(view.location()).toBe('/workflows/wf1');

    fireEvent.click(screen.getByRole('button', { name: 'By code' }));
    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Leave' }));
    expect(view.location()).toBe('/by-code');
    expect(save).not.toHaveBeenCalled();

    view.navigate('/workflows/wf1');
    fireEvent.click(screen.getByRole('link', { name: 'Elsewhere' }));
    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Save and leave' }));
    expect(save).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(view.location()).toBe('/elsewhere'));
  });

  it('a failed "Save and leave" stays on the route with the dialog open', async () => {
    const save = vi.fn(async () => false);
    const view = renderAt(
      '/workflows/wf1',
      <Harness dirty save={save} error="Could not reach the server" />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Elsewhere' }));
    await act(async () => {
      fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Save and leave' }));
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(view.location()).toBe('/workflows/wf1');
    expect(within(leaveDialog()).getByRole('alert').textContent).toBe('Could not reach the server');
  });

  it('a clean draft navigates without a dialog', () => {
    const view = renderAt('/workflows/wf1', <Harness dirty={false} />);
    fireEvent.click(screen.getByRole('link', { name: 'Elsewhere' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(view.location()).toBe('/elsewhere');
  });

  it('a link to the route already shown is not leaving', () => {
    const view = renderAt('/workflows/wf1', <Harness dirty />);
    fireEvent.click(screen.getByRole('link', { name: 'Here' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(view.location()).toBe('/workflows/wf1');
  });

  it('beforeunload is armed only while dirty', () => {
    const unload = () => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const view = renderAt('/workflows/wf1', <Harness dirty={false} />);
    expect(unload()).toBe(false);
    view.rerender(<Harness dirty />);
    expect(unload()).toBe(true);
    view.rerender(<Harness dirty={false} />);
    expect(unload()).toBe(false);
    view.rerender(<Harness dirty />);
    view.unmount();
    expect(unload()).toBe(false);
  });

  it('the guard is gone once the page unmounts', () => {
    const view = renderAt(
      '/workflows/wf1',
      <>
        <GuardedLink href="/after">After</GuardedLink>
        <Harness dirty />
      </>,
    );
    view.rerender(<GuardedLink href="/after">After</GuardedLink>);
    fireEvent.click(screen.getByRole('link', { name: 'After' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a guarded action (log out) is held while dirty: Stay drops it, Leave and Save and leave run it', async () => {
    const onRun = vi.fn();
    const save = vi.fn(async () => true);
    const view = renderAt('/workflows/wf1', <Harness dirty save={save} onRun={onRun} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Stay' }));
    expect(onRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Leave' }));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Save and leave' }));
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenCalledTimes(1);
    expect(view.location()).toBe('/workflows/wf1');

    view.rerender(<Harness dirty={false} onRun={onRun} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(onRun).toHaveBeenCalledTimes(3);
  });
});

describe('useLeaveGuard: browser Back/Forward (final review I1)', () => {
  /** The browser location (wouter's default hook): `/` then the editor route. */
  function atEditor() {
    window.history.replaceState(null, '', '/');
    window.history.pushState(null, '', '/workflows/wf1?version=2');
  }
  const back = () => act(() => window.history.back());
  const where = () => `${window.location.pathname}${window.location.search}`;

  it('Back with a dirty draft stays on the editor and asks; Stay keeps it, Leave goes where Back went', async () => {
    atEditor();
    render(<Harness dirty />);
    await back();
    await waitFor(() => leaveDialog());
    expect(where()).toBe('/workflows/wf1?version=2');

    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Stay' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(where()).toBe('/workflows/wf1?version=2');

    await back();
    await waitFor(() => leaveDialog());
    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Leave' }));
    expect(where()).toBe('/');
  });

  it('"Save and leave" after Back saves, then goes where Back went', async () => {
    atEditor();
    const save = vi.fn(async () => true);
    render(<Harness dirty save={save} />);
    await back();
    await waitFor(() => leaveDialog());
    fireEvent.click(within(leaveDialog()).getByRole('button', { name: 'Save and leave' }));
    await waitFor(() => expect(where()).toBe('/'));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('Back with a clean draft just goes back', async () => {
    atEditor();
    render(<Harness dirty={false} />);
    await back();
    await waitFor(() => expect(where()).toBe('/'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
