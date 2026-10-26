export const SESSION_COOKIE = 'tcd_session';

export function sessionCookie(id: string, opts: { secure: boolean; expires: Date }): string {
  const parts = [
    `${SESSION_COOKIE}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${opts.expires.toUTCString()}`,
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(opts: { secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}
