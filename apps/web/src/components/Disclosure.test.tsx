import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Disclosure } from './Disclosure.tsx';

afterEach(cleanup);

const toggle = () => screen.getByRole('button', { name: /Advanced/ });

describe('Disclosure', () => {
  it('is a button with aria-expanded over a region it controls, closed by default', () => {
    render(
      <Disclosure title="Advanced" meta="2 changed">
        <label>
          Preset <input />
        </label>
      </Disclosure>,
    );
    const button = toggle();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.textContent).toBe('Advanced2 changed');
    const body = document.getElementById(button.getAttribute('aria-controls') ?? '');
    expect(body?.hidden).toBe(true);
    expect(screen.queryByRole('textbox', { name: 'Preset' })).toBeNull();

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(body?.hidden).toBe(false);
    expect(screen.getByRole('textbox', { name: 'Preset' })).toBeTruthy();

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens on its own when reveal turns true (a field inside has a problem)', () => {
    function Host() {
      const [bad, setBad] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setBad(true)}>
            Break
          </button>
          <Disclosure title="Advanced" reveal={bad}>
            <p>Inside</p>
          </Disclosure>
        </>
      );
    }
    render(<Host />);
    expect(screen.queryByText('Inside')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Break' }));
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Inside')).toBeTruthy();
  });

  it('can be controlled', () => {
    const seen: boolean[] = [];
    render(
      <Disclosure title="Advanced" open onOpenChange={(o) => seen.push(o)}>
        <p>Inside</p>
      </Disclosure>,
    );
    expect(screen.getByText('Inside')).toBeTruthy();
    fireEvent.click(toggle());
    expect(seen).toEqual([false]);
    // The parent did not change `open`: it stays open.
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });
});
