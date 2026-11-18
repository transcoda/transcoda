// A job's poster thumbnail, or a film placeholder when there is none (or it fails to load).

import type { Job } from '@transcoda/contract';
import { useState } from 'react';
import { Icon } from '../components/Icon';

export function Poster({ job, size }: { job: Pick<Job, 'id' | 'media'>; size: 'row' | 'page' }) {
  const [failed, setFailed] = useState(false);
  const cls = `poster poster-${size}`;
  if (job.media.poster && !failed) {
    return (
      <span className={cls}>
        <img
          src={`/api/v1/jobs/${encodeURIComponent(job.id)}/poster`}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <span className={`${cls} poster-empty`} aria-hidden="true">
      <Icon name="film" size={size === 'page' ? 32 : 16} />
    </span>
  );
}
