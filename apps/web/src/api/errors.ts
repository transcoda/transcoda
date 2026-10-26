import { ORPCError } from '@orpc/client';

export type ApiFailure = { code: string | null; status: number | null; message: string };

/** One plain-language description for any failed API call (defined, undefined or network). */
export function describeError(err: unknown): ApiFailure {
  if (err instanceof ORPCError) {
    if (!err.defined && err.status === 413) {
      return {
        code: 'PAYLOAD_TOO_LARGE',
        status: 413,
        message: 'The workflow is too large to save (2 MB limit)',
      };
    }
    if (!err.defined && err.status === 400) {
      return { code: err.code, status: 400, message: 'The server rejected the request' };
    }
    return { code: err.code, status: err.status, message: err.message };
  }
  if (err instanceof TypeError) {
    return { code: null, status: null, message: 'Could not reach the server' };
  }
  return {
    code: null,
    status: null,
    message: err instanceof Error && err.message ? err.message : 'Something went wrong',
  };
}
