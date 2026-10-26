import type { ReactNode } from 'react';

/**
 * The one required-field mark: a neutral asterisk after the label text, hidden from assistive
 * technology (the input carries `aria-required`). Never shown on a read-only field.
 */
export function RequiredMark() {
  return (
    <span className="required-mark" aria-hidden="true">
      *
    </span>
  );
}

/**
 * The one-line reason under a disabled primary button ("Enter a name"). Point the button's
 * `aria-describedby` at `id`; render nothing once the form is valid.
 */
export function DisabledReason({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="form-reason">
      {children}
    </p>
  );
}
