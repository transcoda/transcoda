/** The node flags a plugin host process is forked with. Pure; shared by the supervisor and the test harness. */
export function hostExecArgv(opts: {
  hostPath: string;
  bundlePath: string;
  heapMb: number;
  inspect: boolean;
}): string[] {
  // `--allow-fs-read` takes a comma-separated list with `*` wildcards: such a path would widen the grant.
  for (const path of [opts.hostPath, opts.bundlePath]) {
    if (/[,*]/.test(path)) throw new Error(`path may not contain ',' or '*': ${path}`);
  }
  return [
    '--permission',
    `--allow-fs-read=${opts.hostPath}`,
    `--allow-fs-read=${opts.bundlePath}`,
    '--disallow-code-generation-from-strings',
    `--max-old-space-size=${opts.heapMb}`,
    ...(opts.inspect ? ['--allow-inspector', '--inspect'] : []),
  ];
}

/** The only environment variables a plugin host process receives. */
export const HOST_ENV_KEYS = ['PATH', 'NODE_ENV'] as const;

/**
 * The command that starts a host. Without isolation: node runs the host module directly. With
 * isolation: `setpriv` switches to the plugin user, drops every capability the process would carry
 * and sets no-new-privs, then execs node. Either way the caller spawns it with a plain pipe on fd 3
 * that the host's Node opens as its (json) IPC channel; the server frames that pipe itself. There is no `--bounding-set`: dropping bounding-set capabilities needs
 * CAP_SETPCAP, which the server deliberately lacks, and the host would not start. With nothing
 * permitted, effective or ambient and no-new-privs set, the bounding set cannot be exercised.
 */
export function hostSpawn(opts: {
  execPath: string;
  execArgv: string[];
  hostPath: string;
  bundlePath: string;
  isolation: { uid: number; gid: number; setprivPath: string } | null;
  /**
   * Without isolation: a setpriv that only drops the inheritable and ambient capabilities (same
   * user), for a server that still carries some. Null or absent: a plain fork.
   */
  capDropSetpriv?: string | null | undefined;
}): { command: string; args: string[]; viaFork: boolean } {
  const tail = [...opts.execArgv, opts.hostPath, opts.bundlePath];
  const iso = opts.isolation;
  if (iso === null) {
    if (opts.capDropSetpriv) {
      return {
        command: opts.capDropSetpriv,
        args: [
          '--inh-caps=-all',
          '--ambient-caps=-all',
          '--no-new-privs',
          '--',
          opts.execPath,
          ...tail,
        ],
        viaFork: false,
      };
    }
    return { command: opts.execPath, args: tail, viaFork: true };
  }
  return {
    command: iso.setprivPath,
    args: [
      `--reuid=${iso.uid}`,
      `--regid=${iso.gid}`,
      '--clear-groups',
      '--inh-caps=-all',
      '--ambient-caps=-all',
      '--no-new-privs',
      '--',
      opts.execPath,
      ...tail,
    ],
    viaFork: false,
  };
}
