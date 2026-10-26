import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icon.tsx';

export interface ListboxOption {
  value: string;
  label: string;
}

/**
 * A custom dropdown with listbox semantics, styled like the action menus (`.row-menu-list`).
 * The button opens the list; the list holds focus and points at the active option with
 * `aria-activedescendant`. Arrows, Home and End move, Enter or Space picks, Escape and Tab close;
 * focus returns to the button.
 */
export function ListboxSelect({
  label,
  value,
  options,
  onChange,
  visibleLabel = false,
}: {
  /** The accessible name of the control (also the listbox's). */
  label: string;
  value: string;
  options: readonly ListboxOption[];
  onChange(value: string): void;
  /**
   * A form field: the label shows above a full-width button (styled like the other fields)
   * instead of being screen-reader text beside a compact one.
   */
  visibleLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const uid = useId();
  const labelId = `${uid}-label`;
  const buttonId = `${uid}-button`;
  const optionId = (i: number) => `${uid}-option-${i}`;
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    function onDown(e: MouseEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function openList() {
    setActive(selectedIndex);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    button.current?.focus();
  }

  function pick(i: number) {
    const o = options[i];
    close();
    if (o && o.value !== value) onChange(o.value);
  }

  function onKeyDown(e: KeyboardEvent) {
    const last = options.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        setActive((a) => Math.min(a + 1, last));
        break;
      case 'ArrowUp':
        setActive((a) => Math.max(a - 1, 0));
        break;
      case 'Home':
        setActive(0);
        break;
      case 'End':
        setActive(last);
        break;
      case 'Enter':
      case ' ':
        pick(active);
        break;
      case 'Escape':
        close();
        break;
      case 'Tab':
        setOpen(false);
        return;
      default:
        return;
    }
    e.preventDefault();
  }

  return (
    <div
      className={`row-menu listbox-select${visibleLabel ? ' listbox-select-field' : ''}`}
      ref={root}
    >
      <span id={labelId} className={visibleLabel ? 'listbox-select-label' : 'sr-only'}>
        {label}
      </span>
      <button
        ref={button}
        id={buttonId}
        type="button"
        className="btn btn-secondary listbox-select-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${buttonId}`}
        onClick={() => (open ? close() : openList())}
      >
        {options[selectedIndex]?.label}
        <Icon name="chevron-down" size={16} />
      </button>
      {open ? (
        <div
          ref={list}
          className="row-menu-list listbox-select-list"
          role="listbox"
          tabIndex={0}
          aria-labelledby={labelId}
          aria-activedescendant={optionId(active)}
          onKeyDown={onKeyDown}
        >
          {options.map((o, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the listbox (activedescendant pattern).
            <div
              key={o.value}
              id={optionId(i)}
              role="option"
              tabIndex={-1}
              aria-selected={o.value === value}
              className={`listbox-option${i === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(i)}
            >
              <span className="listbox-option-check">
                {o.value === value ? <Icon name="check" size={16} strokeWidth={2.6} /> : null}
              </span>
              {o.label}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
