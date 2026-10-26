import crypto from 'node:crypto';

export const CSRF_HEADER = 'x-csrf-token';

export function csrfTokenFor(secretKey: Buffer, sessionIdHash: string): string {
  return crypto.createHmac('sha256', secretKey).update(`csrf:${sessionIdHash}`).digest('base64url');
}

export function verifyCsrfToken(
  secretKey: Buffer,
  sessionIdHash: string,
  presented: string | null,
): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(csrfTokenFor(secretKey, sessionIdHash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
