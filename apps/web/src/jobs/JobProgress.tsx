// A job's progress bar: the Jobs list's running rows and the top bar's activity panel.
import type { Job } from './jobText.ts';

export function JobProgress({ job, percent }: { job: Job; percent: number }) {
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={`${job.fileName} progress`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div className="progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}
