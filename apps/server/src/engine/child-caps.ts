// The server keeps three ambient capabilities (SETUID, SETGID, KILL) to start plugin hosts as
// another user. Every other child it starts (ffmpeg, ffprobe) must not inherit them: with
// isolation configured they run through `setpriv` as the same user and groups, with no
// inheritable or ambient capabilities and no new privileges.
//
// With isolation off (no TRANSCODA_PLUGIN_UID) the entrypoint already starts the server without
// capabilities. As a second line, a server that still has ambient capabilities (an older
// entrypoint, a hand-made `setpriv`) runs its children through the same setpriv when it exists.

import { existsSync, readFileSync } from 'node:fs';

let setprivPath: string | null = null;

/** Called once at start-up with the isolation's setpriv path (null: isolation off, nothing wrapped). */
export function setChildCapDrop(path: string | null): void {
  setprivPath = path;
}

/** True when /proc/self/status shows a nonzero CapAmb. */
export function hasAmbientCaps(status: string): boolean {
  const m = /^CapAmb:\s*([0-9a-fA-F]+)\s*$/m.exec(status);
  return m !== null && /[1-9a-fA-F]/.test(m[1] ?? '');
}

/** The setpriv to wrap children in with isolation off: Linux, setpriv present, ambient caps set. */
export function pickOffModeSetpriv(o: {
  platform: NodeJS.Platform;
  status: string | null;
  setprivExists: boolean;
  path: string;
}): string | null {
  if (o.platform !== 'linux' || o.status === null || !o.setprivExists) return null;
  return hasAmbientCaps(o.status) ? o.path : null;
}

let offMode: string | null | undefined;

/** Decided once, on first use. `undefined` forgets the decision (tests). */
export function setOffModeSetpriv(path: string | null | undefined): void {
  offMode = path;
}

export function offModeSetpriv(): string | null {
  if (offMode !== undefined) return offMode;
  const path = process.env.TRANSCODA_SETPRIV || '/usr/bin/setpriv';
  let status: string | null = null;
  try {
    status = readFileSync('/proc/self/status', 'utf8');
  } catch {
    // not Linux, or /proc is not mounted
  }
  offMode = pickOffModeSetpriv({
    platform: process.platform,
    status,
    setprivExists: existsSync(path),
    path,
  });
  return offMode;
}

export function capDroppedCommand(
  file: string,
  args: string[],
  setpriv: string | null,
): { file: string; args: string[] } {
  if (setpriv === null) return { file, args };
  return {
    file: setpriv,
    args: ['--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--', file, ...args],
  };
}

/** The command to spawn for `file args` under the current setting. */
export function wrapChild(file: string, args: string[]): { file: string; args: string[] } {
  return capDroppedCommand(file, args, setprivPath ?? offModeSetpriv());
}
