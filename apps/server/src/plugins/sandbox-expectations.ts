/**
 * What each denial probe must report under the host's exact flags (verified on Node 24.21.0).
 * Plain data, not test code: the sandbox suite and `--expect-denials` (Task 11) both read it.
 */
const BASE: Record<string, string | RegExp> = {
  writeOwnDir: 'ERR_ACCESS_DENIED',
  writeTmp: 'ERR_ACCESS_DENIED',
  readOtherBundle: 'ERR_ACCESS_DENIED',
  readEtcPasswd: 'ERR_ACCESS_DENIED',
  readdirOwnDir: 'ERR_ACCESS_DENIED',
  readOwnBundleAfterDrop: 'ERR_ACCESS_DENIED',
  spawn: 'ERR_ACCESS_DENIED',
  worker: 'ERR_ACCESS_DENIED',
  addon: 'ERR_DLOPEN_DISABLED',
  wasi: 'ERR_ACCESS_DENIED',
  inspector: 'ERR_ACCESS_DENIED',
  envKeys: 'NODE_ENV,PATH',
  // fd 4 is Node's own poll fd: kqueue gives ENXIO on macOS, epoll gives EINVAL on Linux.
  // Never fd 3, which is the IPC socket.
  fd4: /^(EBADF|ENXIO|EINVAL|ERR_ACCESS_DENIED)$/,
  globalFetch: 'use ctx.fetch',
  // The fetch a plugin captures at module top level is already the replaced one.
  topLevelFetch: 'use ctx.fetch',
  evalString: 'EvalError',
  processBinding: 'ERR_ACCESS_DENIED',
};

/**
 * The table for one way of running hosts: `isolatedUid` is the plugin user when hosts are started
 * through setpriv (they cannot signal the server: EPERM, and are that uid), null when they share
 * the server's user (`ownUid`; signalling the server works).
 */
export function sandboxExpectations(opts: {
  isolatedUid: number | null;
  ownUid: number | null;
}): Record<string, string | RegExp> {
  return {
    ...BASE,
    signalServer: opts.isolatedUid === null ? 'OK' : 'EPERM',
    uid: String(opts.isolatedUid ?? opts.ownUid ?? 'n/a'),
  };
}

/** Hosts sharing the server's user (dev, tests, macOS). */
export const SANDBOX_EXPECTATIONS: Record<string, string | RegExp> = sandboxExpectations({
  isolatedUid: null,
  ownUid: process.getuid?.() ?? null,
});
