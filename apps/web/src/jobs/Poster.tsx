// A job's poster thumbnail, or a film placeholder when there is none (or it fails to load).

import type { Job } from '@transcoda/contract';
import { useState } from 'react';
import { Icon } from '../components/Icon.tsx';

/**
 * `of: 'show'`: the show's own poster the job's media names (a show card); when it fails to load,
 * the job's own (episode or season) poster is tried before the placeholder.
 */
export function Poster({
  job,
  size,
  of,
}: {
  job: Pick<Job, 'id' | 'media'>;
  size: 'row' | 'page' | 'card';
  of?: 'show' | undefined;
}) {
  const own = `/api/v1/jobs/${encodeURIComponent(job.id)}/poster`;
  const candidates = of === 'show' ? [`${own}?of=show`, own] : [own];
  const [failed, setFailed] = useState<readonly string[]>([]);
  const src = candidates.find((c) => !failed.includes(c));
  const cls = `poster poster-${size}`;
  if (job.media.poster && src !== undefined) {
    return (
      <span className={cls}>
        <img
          key={src}
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed((f) => [...f, src])}
        />
      </span>
    );
  }
  return (
    <span className={`${cls} poster-empty`} aria-hidden="true">
      <Icon name="film" size={size === 'row' ? 16 : 32} />
    </span>
  );
}
