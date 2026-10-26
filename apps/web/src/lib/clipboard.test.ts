import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyShortcut, copyText } from './clipboard.ts';

/** jsdom has no `navigator.clipboard` and no `document.execCommand` (like plain http for the first). */
function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}
function setExecCommand(value: unknown) {
  Object.defineProperty(document, 'execCommand', { value, configurable: true, writable: true });
}

beforeEach(() => {
  setClipboard(undefined);
  setExecCommand(undefined);
});
afterEach(() => {
  setClipboard(undefined);
  setExecCommand(undefined);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('uses navigator.clipboard.writeText when it exists', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    await expect(copyText('tcd_abc')).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith('tcd_abc');
  });

  it('falls back to a hidden textarea and execCommand without navigator.clipboard', async () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    let copiedValue: string | undefined;
    const exec = vi.fn((cmd: string) => {
      const active = document.activeElement;
      if (cmd === 'copy' && active instanceof HTMLTextAreaElement) copiedValue = active.value;
      return true;
    });
    setExecCommand(exec);
    await expect(copyText('ffmpeg -i in.mkv out.mkv')).resolves.toBe('copied');
    expect(exec).toHaveBeenCalledWith('copy');
    expect(copiedValue).toBe('ffmpeg -i in.mkv out.mkv');
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('falls through to execCommand when writeText rejects (permission)', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    setClipboard({ writeText });
    const exec = vi.fn().mockReturnValue(true);
    setExecCommand(exec);
    await expect(copyText('x')).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('selects the given input when both ways fail', async () => {
    setExecCommand(vi.fn().mockReturnValue(false));
    const input = document.createElement('input');
    input.value = 'tcd_secret';
    document.body.append(input);
    await expect(copyText('tcd_secret', input)).resolves.toBe('selected');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('tcd_secret'.length);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('selects the text of any other element through a range', async () => {
    const code = document.createElement('code');
    code.textContent = 'tcd_secret';
    document.body.append(code);
    await expect(copyText('tcd_secret', code)).resolves.toBe('selected');
    expect(window.getSelection()?.toString()).toBe('tcd_secret');
  });

  it('returns "failed" when nothing works and there is nothing to select', async () => {
    setExecCommand(
      vi.fn(() => {
        throw new Error('not supported');
      }),
    );
    await expect(copyText('x')).resolves.toBe('failed');
    await expect(copyText('x', null)).resolves.toBe('failed');
  });
});

describe('copyShortcut', () => {
  it('says ⌘C on Apple platforms and Ctrl+C elsewhere', () => {
    const platform = vi.spyOn(navigator, 'platform', 'get');
    platform.mockReturnValue('MacIntel');
    expect(copyShortcut()).toBe('⌘C');
    platform.mockReturnValue('iPhone');
    expect(copyShortcut()).toBe('⌘C');
    platform.mockReturnValue('Win32');
    expect(copyShortcut()).toBe('Ctrl+C');
    platform.mockReturnValue('Linux x86_64');
    expect(copyShortcut()).toBe('Ctrl+C');
  });
});
