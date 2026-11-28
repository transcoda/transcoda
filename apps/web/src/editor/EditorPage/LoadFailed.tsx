import { Link } from 'wouter';
import { describeError } from '../../api/errors.ts';
import { NotFound } from '../../components/NotFound.tsx';

/** The editor page when the workflow, or the version asked for, could not be loaded. */
export function LoadFailed({
  error,
  id,
  version,
  onRetry,
}: {
  error: unknown;
  id: string;
  version: number | undefined;
  onRetry(): void;
}) {
  const notFound = describeError(error).code === 'NOT_FOUND';
  if (notFound && version !== undefined) {
    return (
      <div className="page editor-load-failed">
        <p role="alert" className="alert alert-danger">
          Version {version} doesn't exist
        </p>
        <p>
          <Link href={`/workflows/${id}`}>Open the current version</Link>
        </p>
      </div>
    );
  }
  if (notFound) return <NotFound what="workflow" />;
  return (
    <div className="page editor-load-failed">
      <p role="alert" className="alert alert-danger">
        {describeError(error).message}
      </p>
      <p>
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          Try again
        </button>{' '}
        <Link href="/">Back to workflows</Link>
      </p>
    </div>
  );
}
