let token: string | null = null;

export function setCsrfToken(t: string | null): void {
  token = t;
}

export function csrfHeaders(): Record<string, string> {
  return token ? { 'x-csrf-token': token } : {};
}

/** The session's CSRF token, for a request that cannot carry the header (sendBeacon). */
export function csrfToken(): string | null {
  return token;
}
