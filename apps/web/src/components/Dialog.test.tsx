import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog.tsx';

afterEach(cleanup);

describe('Dialog', () => {
  it('renders as a modal dialog with the title as its accessible name and closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Dialog
        open
        title="Enable TV cleanup?"
        onClose={onClose}
        footer={<button type="button">Enable</button>}
      >
        <p>Files will be changed.</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Enable TV cleanup?' });
    expect(dialog).toHaveProperty('open', true);
    expect(screen.getByText('Files will be changed.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Enable' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('gives initial focus to the element marked data-autofocus (Cancel in danger dialogs)', () => {
    render(
      <Dialog
        open
        tone="danger"
        title="Delete TV cleanup?"
        onClose={() => {}}
        footer={
          <>
            <button type="button">Delete</button>
            <button type="button" data-autofocus>
              Cancel
            </button>
          </>
        }
      >
        <p>This removes the workflow.</p>
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('focuses Cancel by default in a danger dialog, never the destructive button', () => {
    render(
      <Dialog
        open
        tone="danger"
        title="Delete TV cleanup?"
        onClose={() => {}}
        footer={
          <>
            <button type="button">Delete</button>
            <button type="button">Cancel</button>
          </>
        }
      >
        <p>This removes the workflow.</p>
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('returns focus to returnFocusTo (element or ref) instead of an opener that unmounted', () => {
    function Harness({ open, asRef }: { open: boolean; asRef: boolean }) {
      const menu = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button type="button" ref={menu}>
            Actions
          </button>
          {/* The menu item that opened the dialog is gone once it is open. */}
          {open ? null : <button type="button">Delete item</button>}
          <Dialog
            open={open}
            title="Delete?"
            onClose={() => {}}
            returnFocusTo={asRef ? menu : (menu.current ?? null)}
          >
            <button type="button">Cancel</button>
          </Dialog>
        </>
      );
    }
    for (const asRef of [true, false]) {
      const { rerender, unmount } = render(<Harness open={false} asRef={asRef} />);
      screen.getByRole('button', { name: 'Delete item' }).focus();
      rerender(<Harness open asRef={asRef} />);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
      rerender(<Harness open={false} asRef={asRef} />);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions' }));
      unmount();
    }
  });

  it('has a Close button at the top by default; showClose={false} opts out', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog open title="Library" onClose={onClose}>
        <p>Body</p>
      </Dialog>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <Dialog open title="Library" onClose={onClose} showClose={false}>
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('does not render children while closed', () => {
    render(
      <Dialog open={false} title="Enable TV cleanup?" onClose={() => {}}>
        <p>Files will be changed.</p>
      </Dialog>,
    );
    expect(screen.queryByText('Files will be changed.')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('returns focus to the opener when it closes', () => {
    function Harness({ open }: { open: boolean }) {
      return (
        <>
          <button type="button">Open</button>
          <Dialog open={open} title="Rename" onClose={() => {}}>
            <input aria-label="Name" />
          </Dialog>
        </>
      );
    }
    const { rerender } = render(<Harness open={false} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    rerender(<Harness open />);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
    rerender(<Harness open={false} />);
    expect(document.activeElement).toBe(opener);
  });
});
