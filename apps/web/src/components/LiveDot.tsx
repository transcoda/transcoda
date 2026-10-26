import { useStreamStatus } from '../hooks/useEvents.ts';

/** The stream indicator of screens 04/07/08: "Live" (capitals by its class) with a lime dot, or a muted "reconnecting…". */
export function LiveDot() {
  const live = useStreamStatus() === 'live';
  return (
    <span className={live ? 'live-dot is-live' : 'live-dot'} role="status">
      {live ? (
        <>
          <span className="live-dot-mark" aria-hidden="true" />
          Live
        </>
      ) : (
        'reconnecting…'
      )}
    </span>
  );
}
