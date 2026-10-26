import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
  useEffect,
  useId,
  useRef,
} from 'react';
import { Icon } from './Icon.tsx';

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function initialFocus(dialog: HTMLDialogElement, tone: 'default' | 'danger'): HTMLElement {
  const marked = dialog.querySelector<HTMLElement>('[data-autofocus]');
  if (marked) return marked;
  if (tone === 'danger') {
    const buttons = dialog.querySelectorAll<HTMLButtonElement>('.dialog-footer button');
    return [...buttons].find((b) => b.textContent?.trim() === 'Cancel') ?? dialog;
  }
  // The top Close button comes first in the DOM but is never where a dialog starts.
  const first = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].find(
    (el) => !el.classList.contains('dialog-close'),
  );
  return first ?? dialog;
}

/**
 * Modal dialog on the native <dialog> element (showModal). Escape calls onClose. Initial focus:
 * the child marked `data-autofocus`; else, in a danger dialog, the footer's "Cancel" button
 * (never the destructive action) or the dialog itself; else the first focusable child after the top
 * Close button (shown unless `showClose` is false). On close,
 * focus goes to `returnFocusTo` when given and still in the document (pass the menu button when
 * the dialog was opened from a menu item that unmounts), else to the element focused at open.
 * Children render only while open.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  tone = 'default',
  returnFocusTo,
  showClose = true,
  describedBy,
  wide = false,
}: {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  tone?: 'default' | 'danger';
  returnFocusTo?: RefObject<HTMLElement | null> | HTMLElement | null;
  /** A close button at the top right, on by default (Escape and the footer's Cancel stay). */
  showClose?: boolean;
  /** 720 px instead of 480 px, for content with long names (the file picker). */
  wide?: boolean;
  /** Ids of the elements that describe the dialog (read after its title). */
  describedBy?: string | undefined;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const returnTo = useRef(returnFocusTo);
  returnTo.current = returnFocusTo;

  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    initialFocus(dialog, tone).focus();
    return () => {
      if (dialog.open) dialog.close();
      const r = returnTo.current;
      const target = r instanceof HTMLElement ? r : (r?.current ?? null);
      if (target?.isConnected) target.focus();
      else if (opener?.isConnected) opener.focus();
    };
  }, [open, tone]);

  function onKeyDown(e: KeyboardEvent<HTMLDialogElement>) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    // A dialog opened from inside another one closes alone.
    e.stopPropagation();
    onClose();
  }

  // The browser's own close request (e.g. a back gesture) also goes through onClose, so the
  // parent's `open` stays the single source of truth.
  function onCancel(e: SyntheticEvent<HTMLDialogElement>) {
    e.preventDefault();
    onClose();
  }

  return (
    <dialog
      ref={ref}
      className={['dialog', tone === 'danger' && 'dialog-danger', wide && 'dialog-wide']
        .filter(Boolean)
        .join(' ')}
      aria-labelledby={titleId}
      aria-describedby={describedBy || undefined}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onCancel={onCancel}
    >
      {open && (
        <>
          {showClose && (
            <button type="button" className="dialog-close" aria-label="Close" onClick={onClose}>
              <Icon name="cross" size={16} strokeWidth={2.4} />
            </button>
          )}
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-footer">{footer}</div>}
        </>
      )}
    </dialog>
  );
}
