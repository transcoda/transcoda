// The one stat tile (convention 6): a mono capital label, a large value and an optional muted
// detail line. No fills or coloured borders. `zero` dims the value; pass it only when zero is not
// good news (nothing saved, nothing queued), never for "0 failed". With `onClick` the whole tile is
// a toggle button (a filter); `pressed` rings it and adds a check, so the state is not colour alone.
import { Icon } from './Icon.tsx';

export function StatTile({
  label,
  value,
  sub,
  zero = false,
  onClick,
  pressed = false,
  buttonLabel,
  className,
  as: Tag = 'li',
}: {
  label: string;
  value: string;
  sub?: string | null | undefined;
  zero?: boolean;
  onClick?: (() => void) | undefined;
  pressed?: boolean;
  /** The button's accessible name ("Show Failed: 0"). */
  buttonLabel?: string;
  className?: string;
  /** `li` inside a `.stat-tiles` list (the default), `div` on its own. */
  as?: 'li' | 'div';
}) {
  const cls = ['stat-tile', onClick ? 'is-button' : null, zero ? 'is-zero' : null, className]
    .filter(Boolean)
    .join(' ');
  const inner = (
    <>
      <span className="stat-label">
        {pressed ? <Icon name="check" size={12} strokeWidth={3} /> : null}
        {label}
      </span>
      <span className="stat-value">{value}</span>
      {sub ? <span className="stat-sub">{sub}</span> : null}
    </>
  );
  return (
    <Tag className={cls}>
      {onClick ? (
        <button
          type="button"
          className="stat-tile-button"
          aria-label={buttonLabel}
          aria-pressed={pressed}
          onClick={onClick}
        >
          {inner}
        </button>
      ) : (
        inner
      )}
    </Tag>
  );
}
