import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DisabledReason, RequiredMark } from './Form.tsx';

afterEach(cleanup);

describe('Form bits', () => {
  it('the required mark is a hidden asterisk, so the label keeps its plain name', () => {
    render(
      <label>
        Name
        <RequiredMark />
        <input />
      </label>,
    );
    expect(screen.getByLabelText(/^Name/)).toBeTruthy();
    const mark = document.querySelector('.required-mark');
    expect(mark?.textContent).toBe('*');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
  });

  it('the disabled reason is a one-line paragraph with the id the button points at', () => {
    render(<DisabledReason id="r">Enter a name</DisabledReason>);
    expect(screen.getByText('Enter a name').id).toBe('r');
  });
});
