import { type ReactNode, useEffect, useId, useState } from 'react';
import { Icon } from './Icon.tsx';

/**
 * A titled section that opens and closes: a real button (`aria-expanded`, `aria-controls`) over
 * a region that is only rendered while open. Settings screens use it for "Advanced"; `meta` is a
 * quiet note after the title ("2 changed") so a closed section still says it holds something.
 * `reveal` opens it (once per change to true): a field inside has a problem or is asked for.
 * `open` with `onOpenChange` makes it controlled; otherwise it starts at `defaultOpen`.
 */
export function Disclosure({
  title,
  meta,
  defaultOpen = false,
  open: controlled,
  onOpenChange,
  reveal = false,
  className,
  children,
}: {
  title: string;
  meta?: string | null | undefined;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  reveal?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const [own, setOwn] = useState(defaultOpen || reveal);
  const open = controlled ?? own;

  function set(next: boolean) {
    if (controlled === undefined) setOwn(next);
    onOpenChange?.(next);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: opens on the change to true only.
  useEffect(() => {
    if (reveal && !open) set(true);
  }, [reveal]);

  return (
    <div className={className ? `disclosure ${className}` : 'disclosure'}>
      <button
        type="button"
        className="disclosure-toggle"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={() => set(!open)}
      >
        <span className="disclosure-chevron" aria-hidden="true">
          <Icon name="chevron-right" size={16} strokeWidth={2.4} />
        </span>
        <span className="disclosure-title">{title}</span>
        {meta ? <span className="disclosure-meta">{meta}</span> : null}
      </button>
      <div id={`${id}-body`} className="disclosure-body" hidden={!open}>
        {open ? children : null}
      </div>
    </div>
  );
}
