import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type SigningKey, verifySignature } from './signature.ts';
import { fetchGuarded, readLimited } from './token-hosts.ts';

/** Largest detached signature file accepted. */
export const MAX_SIGNATURE_BYTES = 16 * 1024;

/** The signature file of a document sits beside it: `<url>.sig`. */
export function sigUrlOf(url: string): string {
  if (url.includes('?') || url.includes('#')) {
    throw new Error('a signed document url may not have a query string');
  }
  return `${url}.sig`;
}

export class SignatureError extends Error {
  constructor(
    readonly reason: 'missing' | 'malformed' | 'unknown-key' | 'mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'SignatureError';
  }
}

export interface SignedFetchResult {
  status: number;
  /** null on a non-2xx answer (including 304). */
  body: Buffer | null;
  etag: string | null;
  /** The verbatim signature file; null when `keys` was null or the document was not fetched. */
  sigText: string | null;
  /** The key that verified the document. */
  keyId: string | null;
}

const NOT_FETCHED = { body: null, etag: null, sigText: null, keyId: null } as const;

function verified(body: Buffer, sigText: string, keys: readonly SigningKey[]): string {
  const check = verifySignature(body, sigText, keys);
  if (!check.ok) throw new SignatureError(check.reason, check.message);
  return check.keyId;
}

/**
 * GET a document and, when `keys` is given, its detached signature, and verify one against the
 * other. `keys === null` is a plain unsigned GET; an empty list accepts no signature at all.
 * Any signature problem throws `SignatureError`: the body is never returned unverified when keys
 * were given. A `file:` url reads both files from disk (the caller decides whether that is allowed).
 */
export async function fetchSigned(
  fetchFn: typeof fetch,
  url: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal },
  token: string | null,
  limit: number,
  keys: readonly SigningKey[] | null,
): Promise<SignedFetchResult> {
  const sigUrl = keys === null ? null : sigUrlOf(url);
  if (url.startsWith('file:')) {
    const size = (await stat(fileURLToPath(url))).size;
    if (size > limit) throw new Error(`document is larger than ${limit} bytes`);
    const body = await readFile(fileURLToPath(url));
    if (body.byteLength > limit) throw new Error(`document is larger than ${limit} bytes`);
    if (keys === null || sigUrl === null) {
      return { status: 200, body, etag: null, sigText: null, keyId: null };
    }
    let sigText: string;
    try {
      sigText = await readFile(fileURLToPath(sigUrl), 'utf8');
    } catch {
      throw new SignatureError('missing', 'signature missing (file not found)');
    }
    return { status: 200, body, etag: null, sigText, keyId: verified(body, sigText, keys) };
  }

  const res = await fetchGuarded(fetchFn, url, init, token);
  if (res.status === 304 || !res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, ...NOT_FETCHED };
  }
  const body = await readLimited(res, limit);
  if (body === null) throw new Error(`document is larger than ${limit} bytes`);
  const etag = res.headers.get('etag');
  if (keys === null || sigUrl === null) {
    return { status: res.status, body, etag, sigText: null, keyId: null };
  }
  // The document's conditional headers describe the document, never its signature.
  const sigHeaders = Object.fromEntries(
    Object.entries(init.headers ?? {}).filter(
      ([k]) => !['if-none-match', 'if-modified-since'].includes(k.toLowerCase()),
    ),
  );
  const sigRes = await fetchGuarded(fetchFn, sigUrl, { ...init, headers: sigHeaders }, token);
  if (!sigRes.ok) {
    await sigRes.body?.cancel().catch(() => undefined);
    // A server error is a fetch failure (the caller may serve its verified cache); a 4xx is a missing signature.
    if (sigRes.status >= 500) throw new Error(`signature HTTP ${sigRes.status}`);
    throw new SignatureError('missing', `signature missing (HTTP ${sigRes.status})`);
  }
  const sigBytes = await readLimited(sigRes, MAX_SIGNATURE_BYTES);
  if (sigBytes === null) {
    throw new SignatureError(
      'malformed',
      `malformed signature file: larger than ${MAX_SIGNATURE_BYTES} bytes`,
    );
  }
  const sigText = sigBytes.toString('utf8');
  return { status: res.status, body, etag, sigText, keyId: verified(body, sigText, keys) };
}
