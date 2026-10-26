import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Icon, type IconName } from './Icon.tsx';

export interface RowMenuItem {
  label: string;
  icon: IconName;
  /** The one danger style: red text in the menu, a confirmation dialog after it. */
  danger?: boolean;
  /**
   * Shown but not pickable: announced as disabled (it stays reachable by keyboard so the hint is
   * read), with `hint` as its tooltip and description.
   */
  disabled?: boolean;
  /** Why the item is disabled. */
  hint?: string;
  /** Receives the menu button, so focus can return to it after the menu has unmounted. */
  onSelect(button: HTMLButtonElement | null): void;
}

/**
 * The "…" actions menu every table row uses (at most one inline primary button sits beside it).
 * Opens on click, focuses the first item, closes on Escape (focus returns to the button), on an
 * outside click, on scroll or resize and after a pick. The list is placed against the viewport
 * (fixed), so a table that scrolls sideways never clips it; near the bottom it opens upwards.
 */
export function RowMenu({
  name,
  items,
  button: look,
}: {
  name: string;
  items: readonly RowMenuItem[];
  /** Another look for the button (the "…" by default): its icon, accessible name, visible text and class. */
  button?: { icon: IconName; label: string; text?: string; className: string };
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const hintId = useId();

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    function onDown(e: MouseEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    function onMove() {
      setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  function toggle() {
    if (!open && button.current) {
      const r = button.current.getBoundingClientRect();
      const right = Math.max(0, window.innerWidth - r.right);
      const needed = items.length * 44 + 16;
      setPlace(
        r.bottom + needed > window.innerHeight && r.top > needed
          ? { position: 'fixed', right, bottom: window.innerHeight - r.top + 4, top: 'auto' }
          : { position: 'fixed', right, top: r.bottom + 4 },
      );
    }
    setOpen((o) => !o);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !open) return;
    e.preventDefault();
    setOpen(false);
    button.current?.focus();
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the menu from any item inside it.
    <div className="row-menu" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className={look ? look.className : 'btn btn-ghost row-menu-button'}
        aria-label={look ? look.label : `Actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        {look ? (
          <>
            <Icon name={look.icon} size={14} strokeWidth={2.4} round />
            {look.text}
          </>
        ) : (
          <Icon name="more" strokeWidth={3} round />
        )}
      </button>
      {open ? (
        <div className="row-menu-list" role="menu" aria-label={`Actions for ${name}`} style={place}>
          {items.map((item, i) => {
            const hint = item.disabled && item.hint ? `${hintId}-${i}` : undefined;
            return (
              <Fragment key={item.label}>
                <button
                  type="button"
                  role="menuitem"
                  className={item.danger ? 'row-menu-danger' : undefined}
                  {...(item.disabled ? { 'aria-disabled': true } : {})}
                  {...(hint ? { title: item.hint, 'aria-describedby': hint } : {})}
                  onClick={() => {
                    if (item.disabled) return;
                    setOpen(false);
                    item.onSelect(button.current);
                  }}
                >
                  <Icon name={item.icon} size={16} />
                  {item.label}
                </button>
                {/* Under its item, outside it: the hint describes the item without joining its name. */}
                {hint ? (
                  <span id={hint} className="row-menu-hint">
                    {item.hint}
                  </span>
                ) : null}
              </Fragment>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
