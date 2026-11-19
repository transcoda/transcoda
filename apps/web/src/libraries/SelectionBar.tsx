import type { JSX } from 'react';

/** "N selected · Run a workflow… · Clear": shown while files are ticked. */
export function SelectionBar({
  count,
  onRun,
  onClear,
}: {
  count: number;
  onRun(opener: HTMLElement): void;
  onClear(): void;
}): JSX.Element {
  return (
    <section className="selection-bar" aria-label="Selection">
      <span className="selection-count" aria-live="polite">{`${count} selected`}</span>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={(e) => onRun(e.currentTarget)}
      >
        Run a workflow…
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>
        Clear
      </button>
    </section>
  );
}
