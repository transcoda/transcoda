import { readFileSync } from 'node:fs';
import type { Capabilities, NodeInfo } from '@transcoda/contract';
import { nodeMetadata } from '@transcoda/sdk';
import { parseVersion } from '../capabilities/ffmpeg.ts';
import { nodeAvailability } from './availability.ts';
import { createCoreRegistry } from './registry.ts';

/**
 * Fixed capabilities for the web test fixture (apps/web/src/test/fixtures/nodes.json), so the
 * fixture does not depend on the ffmpeg of the machine that regenerates it.
 */
export const FIXTURE_CAPABILITIES: Capabilities = {
  available: true,
  path: '/usr/bin/ffmpeg',
  version: parseVersion(
    readFileSync(new URL('../capabilities/fixtures/ffmpeg-version.txt', import.meta.url), 'utf8'),
  ),
  encoders: ['libx265', 'aac'],
  filters: ['pan'],
  hwaccels: [],
};

/** The core catalogue as `nodes.list` returns it (same mapping as WorkflowService.listNodes). */
export function fixtureNodes(): NodeInfo[] {
  return createCoreRegistry()
    .list()
    .map((entry) => {
      const { def, source } = entry;
      const m = nodeMetadata(def);
      return {
        type: m.type,
        version: m.version,
        kind: m.kind,
        title: m.title,
        description: m.description,
        icon: m.icon,
        inputs: m.inputs,
        outputs: m.outputs,
        settingsSchema: m.settingsSchema,
        onNodeSettings: m.onNodeSettings,
        finishPhase: m.finishPhase,
        source,
        availability: nodeAvailability(entry, FIXTURE_CAPABILITIES, { outputRoots: ['/output'] }),
      };
    });
}
