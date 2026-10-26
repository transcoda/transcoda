import type { Appearance, User } from '@transcoda/contract';
import { createContext, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.ts';
import { setCsrfToken } from '../api/csrf.ts';
import { blockedHost as blockedHostOf, onHostNotAllowed } from '../api/host-guard.ts';
import { setServerTitle } from '../lib/pageTitle.ts';
import { applyTheme, cachedTheme } from '../lib/theme.ts';

export type AuthStatus = 'loading' | 'setup' | 'anonymous' | 'authenticated' | 'host-not-allowed';

export interface AuthValue {
  status: AuthStatus;
  user: User | null;
  /** The hostname the server rejected (status 'host-not-allowed'), else null. */
  blockedHost: string | null;
  /** The server's theme and name (`auth.me`); the theme is applied to the page. */
  appearance: Appearance;
  /** After a settings save: the new appearance, applied at once. */
  setAppearance(a: Appearance): void;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

export const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [blockedHost, setBlockedHost] = useState<string | null>(null);
  // Until auth.me answers: the theme main.tsx applied from the cache, no name.
  const [appearance, setAppearanceState] = useState<Appearance>(() => ({
    theme: cachedTheme() ?? 'system',
    serverName: null,
  }));

  const setAppearance = useCallback((a: Appearance) => {
    applyTheme(a.theme);
    setAppearanceState(a);
  }, []);

  // The browser tab carries the server's name (signed in only: auth.me sends none before).
  useEffect(() => setServerTitle(appearance.serverName), [appearance.serverName]);

  const refresh = useCallback(async () => {
    const me = await api.auth.me();
    setCsrfToken(me.csrfToken);
    setAppearance(me.appearance);
    setUser(me.user);
    setStatus(me.setupRequired ? 'setup' : me.user ? 'authenticated' : 'anonymous');
  }, [setAppearance]);

  const logout = useCallback(async () => {
    await api.auth.logout();
    await refresh();
  }, [refresh]);

  const block = useCallback((host: string) => {
    setCsrfToken(null);
    setUser(null);
    setBlockedHost(host);
    setStatus('host-not-allowed');
  }, []);

  // Any API call rejected by the server's host check switches to the host-not-allowed screen.
  useEffect(() => onHostNotAllowed(block), [block]);

  useEffect(() => {
    refresh().catch((e: unknown) => {
      const host = blockedHostOf(e);
      if (host !== null) {
        block(host);
        return;
      }
      setCsrfToken(null);
      setUser(null);
      setStatus('anonymous');
    });
  }, [refresh, block]);

  const value = useMemo(
    () => ({ status, user, blockedHost, appearance, setAppearance, refresh, logout }),
    [status, user, blockedHost, appearance, setAppearance, refresh, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
