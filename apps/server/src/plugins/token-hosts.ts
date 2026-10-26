/** The catalog token is sent only to these hosts (over https). */
export const CATALOG_TOKEN_HOSTS = [
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
];

/** True when `url` is https on one of the hosts that may receive the catalog token. */
export function tokenAllowedFor(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && CATALOG_TOKEN_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

const MAX_REDIRECTS = 5;

/**
 * GET `url`. Without a token this is a plain fetch. With a token, redirects are followed by hand
 * and the token is attached only to hops whose host is in CATALOG_TOKEN_HOSTS (re-checked per hop).
 */
export async function fetchGuarded(
  fetchFn: typeof fetch,
  url: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal },
  token: string | null,
): Promise<Response> {
  if (token === null) return fetchFn(url, init);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers = { ...init.headers };
    if (tokenAllowedFor(current)) headers.authorization = `Bearer ${token}`;
    const res = await fetchFn(current, {
      headers,
      redirect: 'manual',
      ...(init.signal !== undefined ? { signal: init.signal } : {}),
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location !== null) {
      await res.body?.cancel().catch(() => undefined);
      current = new URL(location, current).href;
      continue;
    }
    return res;
  }
  throw new Error('too many redirects');
}

/** Read a body up to `limit` bytes; returns null when it is larger. */
export async function readLimited(res: Response, limit: number): Promise<Buffer | null> {
  if (res.body === null) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
