import { PluginSummarySchema } from '@transcoda/contract';
import { z } from 'zod';
import { type AnyToolDef, defineTool } from '../tool.ts';

/**
 * The only plugin tool: what is installed and whether it runs. Installing, updating, removing,
 * enabling, disabling, the catalog and the integration settings (secrets) are the Plugins page's,
 * session only; there is no MCP tool for any of them.
 */
const listPlugins = defineTool({
  name: 'list_plugins',
  title: 'List plugins',
  description:
    'The installed plugins: name, version, whether it runs (state and why not), the node types it adds, any update the catalog offers and whether the blocklist stops it. Read-only: plugins are installed and configured by a person on the Plugins page.',
  scopes: ['read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: {},
  // The icon is SVG markup for the Plugins page: nothing a tool caller reads.
  output: { plugins: z.array(PluginSummarySchema.omit({ icon: true })) },
  async run({ api }) {
    const plugins = (await api.plugins.list()).plugins.map(({ icon: _icon, ...p }) => p);
    const lines = plugins.map(
      (p) =>
        `${p.name} ${p.version} — ${p.state}${p.stateReason ? ` (${p.stateReason})` : ''}, nodes: ${p.nodes.join(', ') || 'none'}${p.updateAvailable ? `, update ${p.updateAvailable} available` : ''}${p.blocked ? `, BLOCKLISTED: ${p.blocked.reason}` : ''}`,
    );
    return {
      text: lines.length > 0 ? lines.join('\n') : 'No plugins installed.',
      data: { plugins },
    };
  },
});

export const pluginTools: AnyToolDef[] = [listPlugins];
