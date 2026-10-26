import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast.tsx';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Trigger({ onRetry }: { onRetry(): void }) {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.info('Saved v8')}>
        info
      </button>
      <button
        type="button"
        onClick={() => toast.error('Could not save', { label: 'Try again', onClick: onRetry })}
      >
        error
      </button>
    </>
  );
}

describe('Toast', () => {
  it('info toasts disappear after 4 s, error toasts stay and expose their action button', () => {
    const onRetry = vi.fn();
    render(
      <ToastProvider>
        <Trigger onRetry={onRetry} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'info' }));
    fireEvent.click(screen.getByRole('button', { name: 'error' }));
    expect(within(screen.getByRole('status')).getByText('Saved v8')).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Could not save')).toBeTruthy();
    // Each new toast is announced on its own, not the whole stack again (final review M12).
    expect(screen.getByRole('status').getAttribute('aria-atomic')).toBe('false');
    expect(alert.getAttribute('aria-atomic')).toBe('false');

    act(() => vi.advanceTimersByTime(3999));
    expect(screen.queryByText('Saved v8')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText('Saved v8')).toBeNull();

    act(() => vi.advanceTimersByTime(60_000));
    expect(within(alert).getByText('Could not save')).toBeTruthy();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Could not save')).toBeNull();
  });

  it('dismisses an error toast with its close button', () => {
    render(
      <ToastProvider>
        <Trigger onRetry={() => {}} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'error' }));
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Could not save')).toBeNull();
  });
});
