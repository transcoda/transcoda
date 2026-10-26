import { ORPCError } from '@orpc/client';

/** The rejected hostname when `error` is the server's HOST_NOT_ALLOWED, else null. */
export function blockedHost(error: unknown): string | null {
  if (!(error instanceof ORPCError) || error.code !== 'HOST_NOT_ALLOWED') return null;
  const host = (error.data as { host?: unknown } | undefined)?.host;
  return typeof host === 'string' ? host : '';
}

type Listener = (host: string) => void;
const listeners = new Set<Listener>();

/** Subscribe to HOST_NOT_ALLOWED failures of any API call; returns the unsubscribe function. */
export function onHostNotAllowed(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** RPCLink interceptor: reports HOST_NOT_ALLOWED to the listeners, then rethrows. */
export async function hostGuardInterceptor<T>({ next }: { next: () => Promise<T> }): Promise<T> {
  try {
    return await next();
  } catch (e) {
    const host = blockedHost(e);
    if (host !== null) for (const l of listeners) l(host);
    throw e;
  }
}
