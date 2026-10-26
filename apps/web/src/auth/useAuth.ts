import { useContext } from 'react';
import { AuthContext, type AuthValue } from './AuthProvider.tsx';

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
