import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilePath, splitPath } from './FilePath.tsx';
import { ToastProvider } from './Toast.tsx';

afterEach(cleanup);

const PATH = '/media/films/Example Film (1950)/Example Film (1950).mkv';

function renderPath(path = PATH) {
  return render(
    <ToastProvider>
      <FilePath path={path} />
    </ToastProvider>,
  );
}

const toggle = () => screen.getByRole('button', { name: /full path/ });

describe('splitPath', () => {
  it('cuts at the last slash, keeping the slash on the folder', () => {
    expect(splitPath(PATH)).toEqual({
      folder: '/media/films/Example Film (1950)/',
      name: 'Example Film (1950).mkv',
    });
    expect(splitPath('C:\\Films\\a.mkv')).toEqual({ folder: 'C:\\Films\\', name: 'a.mkv' });
    expect(splitPath('a.mkv')).toEqual({ folder: '', name: 'a.mkv' });
  });
});

describe('FilePath', () => {
  it('the short line shows the file name whole and the folder in its own part', () => {
    const { container } = renderPath();
    const short = container.querySelector('.file-path-short') as HTMLElement;
    expect(short.getAttribute('aria-hidden')).toBe('true');
    expect(short.getAttribute('title')).toBe(PATH);
    expect(short.querySelector('.file-path-name')?.textContent).toBe('Example Film (1950).mkv');
    expect(short.querySelector('.file-path-folder')?.textContent).toBe(
      '\u200e/media/films/Example Film (1950)/\u200e',
    );
  });

  it('Show full path is a disclosure over the whole path and toggles it', () => {
    const { container } = renderPath();
    const row = container.querySelector('.file-path') as HTMLElement;
    const button = toggle();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.textContent).toBe('Show full path');
    expect(row.classList.contains('is-open')).toBe(false);
    const full = document.getElementById(button.getAttribute('aria-controls') ?? '');
    expect(full?.textContent).toBe(PATH);

    fireEvent.click(button);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(toggle().textContent).toBe('Hide full path');
    expect(row.classList.contains('is-open')).toBe(true);

    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(row.classList.contains('is-open')).toBe(false);
  });

  it('screen readers get the whole path while it is closed: in the text and as Copy path’s description', () => {
    renderPath();
    const full = screen.getByText(PATH);
    expect(full.closest('[aria-hidden="true"]')).toBeNull();
    expect(full.hidden).toBe(false);
    expect(screen.getByRole('button', { name: 'Copy path', description: PATH })).toBeTruthy();
  });

  it('Copy path writes the whole path', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const real = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      renderPath();
      fireEvent.click(screen.getByRole('button', { name: 'Copy path' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(PATH));
      expect(await screen.findByText('Copied')).toBeTruthy();
    } finally {
      if (real) Object.defineProperty(navigator, 'clipboard', real);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});

describe('FilePath styles', () => {
  const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');
  const phone = css.slice(css.indexOf('/* Phones: one line, the folder cut from the left'));
  const block = phone.slice(0, phone.indexOf('\n}\n'));

  it('wide screens hide the short line and the toggle', () => {
    expect(css).toMatch(/\.file-path-short,\s*\.file-path-toggle\s*\{\s*display:\s*none;/);
  });

  it('phones visually hide the closed whole path (never display: none) and cut the folder from the left', () => {
    expect(block).toMatch(/@media \(max-width: 639px\)/);
    const hidden = block.match(/\.file-path:not\(\.is-open\) \.file-path-full \{([^}]*)\}/)?.[1];
    expect(hidden).toMatch(/clip: rect\(0 0 0 0\)/);
    expect(hidden).not.toMatch(/display:\s*none/);
    expect(block).toMatch(/\.file-path-folder \{[^}]*direction: rtl;[^}]*\}/);
    expect(block).toMatch(/\.file-path-folder \{[^}]*text-overflow: ellipsis;[^}]*\}/);
    expect(block).toMatch(/\.file-path-name \{[^}]*flex: 0 0 auto;[^}]*\}/);
  });
});
