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
    if (err.defined && err.code === 'LIBRARY_UNREACHABLE') {
      // The library exists (unlike NOT_FOUND): its folder is unmounted or not readable for now.
      const path = (err.data as { path?: unknown } | undefined)?.path;
      return {
        code: err.code,
        status: err.status,
        message:
          typeof path === 'string'
            ? `The library folder can't be reached: ${path}`
            : "The library folder can't be reached",
      };
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
