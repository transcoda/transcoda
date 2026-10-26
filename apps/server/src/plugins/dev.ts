// Dev mode (TRANSCODA_DEV_PLUGINS): bundles loaded from arbitrary absolute paths, still sandboxed.
// Never persisted, never from a catalog, refused in production (config.ts).
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import type { SupervisorLimits } from '@transcoda/shared';
import { checkPluginBundle } from './check-plugin.ts';
import type { PluginRuntime } from './supervisor.ts';

export interface DevRuntimes {
  runtimes: PluginRuntime[];
  /** Paths that were not loaded, each with the reason (logged as errors, never skipped silently). */
  refused: Array<{ path: string; reason: string }>;
}

/**
 * Reads each bundle's own manifest by importing it in a host (one throw-away start), and yields a
 * runtime per bundle: enabled, empty settings, no catalog. A name that an installed plugin (or an
 * earlier dev bundle) already has is refused.
 */
export async function devPluginRuntimes(
  paths: string[],
  hostPath: string,
  opts: {
    installed: Iterable<string>;
    limits?: SupervisorLimits | undefined;
    sdkVersion?: string | undefined;
  },
): Promise<DevRuntimes> {
  const taken = new Set(opts.installed);
  const out: DevRuntimes = { runtimes: [], refused: [] };
  for (const path of paths) {
    const checked = await checkPluginBundle(path, {
      hostPath,
      limits: opts.limits,
      sdkVersion: opts.sdkVersion,
    });
    if (!checked.ok) {
      out.refused.push({ path, reason: checked.error });
      continue;
    }
    if (!checked.compatible) {
      out.refused.push({
        path,
        reason: `sdk ${checked.sdk} is not supported by this server`,
      });
      continue;
    }
    if (taken.has(checked.name)) {
      out.refused.push({
        path,
        reason: `dev plugin ${checked.name} shadows the installed one; remove it first`,
      });
      continue;
    }
    taken.add(checked.name);
    // The sandbox's read grant is for this exact file, not for a link to it.
    const bundlePath = await realpath(path);
    out.runtimes.push({
      name: checked.name,
      version: checked.version,
      bundlePath,
      sha256: createHash('sha256')
        .update(await readFile(bundlePath))
        .digest('hex'),
      manifest: {
        name: checked.name,
        version: checked.version,
        sdk: checked.sdk,
        nodes: checked.nodes,
        integration: checked.integration,
        triggers: checked.triggers,
        hooks: checked.hooks,
      },
      settings: {},
      policy: { allowedOrigins: [], allowInsecureTls: false },
      enabled: true,
      // Run as the server's user from the bundle's own path: not isolated, never staged.
      isolated: false,
    });
  }
  return out;
}
