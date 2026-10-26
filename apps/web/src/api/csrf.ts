let token: string | null = null;

export function setCsrfToken(t: string | null): void {
  token = t;
}

export function csrfHeaders(): Record<string, string> {
  return token ? { 'x-csrf-token': token } : {};
}
