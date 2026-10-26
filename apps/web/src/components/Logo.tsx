// Transcoda mark "L1d" (branch mark) and wordmark, from the design handoff's
// brand/02-logo-and-tagline sheet (kept outside the repo). Colours are brand constants,
// not theme tokens, so the mark looks the same in every theme.
const INK = '#17161A';
const LIME = '#C6F35A';

export interface MarkProps {
  size?: number;
  /** 'lime': lime tile with ink strokes (on dark ground). 'ink': ink tile with lime strokes (on lime). */
  tone?: 'lime' | 'ink';
}

/** Decorative: it always sits next to the wordmark, which carries the name. */
export function Mark({ size = 30, tone = 'lime' }: MarkProps) {
  const tile = tone === 'lime' ? LIME : INK;
  const ink = tone === 'lime' ? INK : LIME;
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect x="2" y="2" width="36" height="36" rx="10" fill={tile} />
      <path
        d="M16.6 20.4 C 20.5 21.2, 20 27, 24.4 27"
        stroke={ink}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="1.6 3.4"
        fill="none"
      />
      <path d="M12 20 C 20 20, 20 13, 28 13" stroke={ink} strokeWidth="2.6" fill="none" />
      <circle cx="12" cy="20" r="4" fill={ink} />
      <circle cx="28" cy="13" r="4" fill={ink} />
      <circle cx="28" cy="27" r="3.4" fill={tile} stroke={ink} strokeWidth="2" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return <span className={className ? `wordmark ${className}` : 'wordmark'}>transcoda</span>;
}
