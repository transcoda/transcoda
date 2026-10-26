import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/Toast.tsx';
import { CommandBlock } from './CommandBlock.tsx';

const COMMAND = 'ffmpeg -i in.mkv -c:v libx265 out.mkv';

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}
function setExecCommand(value: unknown) {
  Object.defineProperty(document, 'execCommand', { value, configurable: true, writable: true });
}

function renderBlock() {
  return render(
    <ToastProvider>
      <CommandBlock command={COMMAND} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  setClipboard(undefined);
  setExecCommand(undefined);
});
afterEach(() => {
  cleanup();
  setClipboard(undefined);
  setExecCommand(undefined);
});

describe('CommandBlock', () => {
  it('copies with the clipboard API and says "Copied"', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    renderBlock();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Copied')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(COMMAND);
  });

  it('copies through execCommand on plain http', async () => {
    const exec = vi.fn().mockReturnValue(true);
    setExecCommand(exec);
    renderBlock();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Copied')).toBeTruthy();
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('selects the command and says which keys to press when copying is impossible', async () => {
    setExecCommand(vi.fn().mockReturnValue(false));
    renderBlock();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText(/^Selected\. Press (⌘C|Ctrl\+C) to copy\.$/)).toBeTruthy();
    expect(window.getSelection()?.toString()).toBe(COMMAND);
    expect(screen.queryByText(/could not copy/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
