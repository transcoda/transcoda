// A segmented control of buttons: one tab stop on the checked option, arrow keys move the choice.

import type { KeyboardEvent } from 'react';

const ARROW_STEP: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

export function SegmentedSwitch<T extends string>({
  label,
  className,
  value,
  options,
  onChange,
}: {
  label: string;
  className?: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string; count?: number | null }>;
  onChange(v: T): void;
}) {
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = ARROW_STEP[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = (index + step + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onChange(option.id);
    const group = e.currentTarget.parentElement;
    group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }
  return (
    <div role="radiogroup" aria-label={label} className={className}>
      {options.map((o, i) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control of buttons with a roving tab stop and arrow keys.
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          tabIndex={o.id === value ? 0 : -1}
          onClick={() => onChange(o.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {o.label}
          {o.count === null || o.count === undefined ? null : (
            <>
              {' '}
              <span className="plugins-show-count">{o.count}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}
