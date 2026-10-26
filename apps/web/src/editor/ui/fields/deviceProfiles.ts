// Device profile names for the `targets` setting's chips, from `system.capabilities()`. Fetched
// once per page load and shared; a failed fetch leaves the chips showing ids and is retried by the
// next field that mounts.
import { useEffect, useState } from 'react';
import { api } from '../../../api/client.ts';

export type ProfileNames = ReadonlyMap<string, string>;

let cached: Promise<ProfileNames> | null = null;

function load(): Promise<ProfileNames> {
  if (!cached) {
    cached = (async () => {
      const caps = await api.system.capabilities();
      return new Map(caps.deviceProfiles.map((p) => [p.id, p.name]));
    })().catch(() => {
      cached = null;
      return new Map();
    });
  }
  return cached;
}

/** Names by profile id once loaded (empty until then, or when `enabled` is false). */
export function useDeviceProfileNames(enabled: boolean): ProfileNames {
  const [names, setNames] = useState<ProfileNames>(() => new Map());
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void load().then((n) => {
      if (live) setNames(n);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return names;
}
