import type { Settings } from '@transcoda/contract';
import { useState } from 'react';
import { api } from '../../api/client.ts';
import { useAsync } from '../../hooks/useAsync.ts';

/**
 * `settings.get` for a section. `set(next)` puts a save's answer in place of the loaded values
 * (the server's answer replaces the form state); a later `reload()` brings fresh values again.
 */
export function useSettings(): {
  data: Settings | null;
  error: unknown;
  reload(): void;
  set(next: Settings): void;
} {
  const { data, error, reload } = useAsync(() => api.settings.get(), []);
  // The saved answer, tied to the load it replaces: a newer load wins over it.
  const [saved, setSaved] = useState<{ over: Settings | undefined; value: Settings } | null>(null);
  const current = saved && saved.over === data ? saved.value : (data ?? null);
  return { data: current, error, reload, set: (value) => setSaved({ over: data, value }) };
}
