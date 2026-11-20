// A job's poster thumbnail, or a film placeholder when there is none (or it fails to load).

import type { Job } from '@transcoda/contract';
import { useState } from 'react';
import { Icon } from '../components/Icon';

/** `of: 'show'`: the show's own poster the job's media names (a show card), not the episode's. */
export function Poster({
  job,
  size,
  of,
}: {
  job: Pick<Job, 'id' | 'media'>;
  size: 'row' | 'page' | 'card';
  of?: 'show' | undefined;
}) {
  const src = `/api/v1/jobs/${encodeURIComponent(job.id)}/poster${of === 'show' ? '?of=show' : ''}`;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === src;
  const cls = `poster poster-${size}`;
  if (job.media.poster && !failed) {
    return (
      <span className={cls}>
        <img src={src} alt="" loading="lazy" onError={() => setFailedSrc(src)} />
      </span>
    );
  }
  return (
    <span className={`${cls} poster-empty`} aria-hidden="true">
      <Icon name="film" size={size === 'row' ? 16 : 32} />
    </span>
  );
}
