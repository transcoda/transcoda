import { useId } from 'react';
import { Icon } from './Icon.tsx';

/**
 * A small "i" button that explains a term: the text shows as a tooltip on hover and on keyboard
 * focus (CSS), and is the button's description for screen readers. Not a toggle: it does nothing
 * on click, so a touch tap focuses it and shows the text.
 */
export function InfoTip({ label, text }: { label: string; text: string }) {
  const id = useId();
  return (
    <span className="info-tip">
      <button type="button" className="info-tip-btn" aria-label={label} aria-describedby={id}>
        <Icon name="info" size={14} round />
      </button>
      <span id={id} role="tooltip" className="info-tip-text">
        {text}
      </span>
    </span>
  );
}
