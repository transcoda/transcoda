// What the Plugins page says: state words, the install warnings and the remove confirmation.
import type { NodeInfo, PluginSettingsGetOutput, PluginSummary } from '@transcoda/contract';
import { fmtAgo } from '../lib/time.ts';

/** 'running' | 'starting' | 'restarting in 12 s' | 'stopped: <reason>' | 'disabled'. */
export function stateLabel(p: PluginSummary, now: Date): string {
  switch (p.state) {
    case 'running':
      return 'running';
    case 'starting':
      return 'starting';
    case 'restarting': {
      const at = p.nextRestartAt === null ? Number.NaN : Date.parse(p.nextRestartAt);
      const seconds = Number.isNaN(at) ? 0 : Math.max(0, Math.ceil((at - now.getTime()) / 1000));
      return `restarting in ${seconds} s`;
    }
    case 'stopped':
      return p.stateReason ? `stopped: ${p.stateReason}` : 'stopped';
    case 'disabled':
      return 'disabled';
  }
}

/** The install dialog's Source row: where the build came from. */
export function provenanceSource(official: boolean): string {
  return official ? 'Built by CI' : 'From a custom catalog';
}

/** The install dialog's Signature row: the catalog's signing keys, or "Unsigned". */
export function provenanceSignature(keyIds: readonly string[]): string {
  if (keyIds.length === 0) return 'Unsigned';
  return `Signed with key${keyIds.length > 1 ? 's' : ''} ${keyIds.join(', ')}`;
}

/** The tooltip on the install dialog's Attestation row. */
export const ATTESTATION_TIP =
  'Proof from GitHub that this plugin was built from the public source in the transcoda-plugins repository, so the code you run in Transcoda is exactly the code you can read there.';

/** The alert on an installed plugin the blocklist names. */
export function blockedText(b: { reason: string }): string {
  return `Blocklisted: ${b.reason}`;
}

/** Only web links become links: advisory and attestation urls come from documents we do not write. */
export function webLink(url: string | null): string | null {
  if (url === null) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

export const CUSTOM_CATALOG_WARNING =
  'Plugins are code that runs inside Transcoda. Only install from sources you trust. The sandbox stops file writes and new processes, not the network; an unsigned catalog is only as trustworthy as whoever controls its URL.';

/** The design's "Security promise", verbatim; paragraphs are separated by a blank line. */
export const SECURITY_PROMISE = `Plugins are code that runs inside Transcoda. Treat installing one like installing software on the server. Each plugin runs in its own process under Node's permission model: it can read only its own bundle, cannot write files, start programs, load native code or read other plugins' settings, and it never touches your media or the database — Transcoda does all file work and gives plugins data only. Its memory and the time each call may take are limited, and a plugin that crashes is restarted and, if it keeps crashing, stopped, with its nodes marked in the editor.

This is accident protection, not a wall. A malicious plugin could still use the network freely (Transcoda offers a controlled HTTP client, but cannot block raw sockets: the network is outside Node's permission model) or exhaust memory the heap limit does not count. In the Docker image every plugin process runs as a separate unprivileged user, shared by all plugins, so it cannot signal Transcoda's own process or read \`/config\` (plugins can still signal each other); outside the image, when the container is started with \`--user\`, or with \`TRANSCODA_PLUGIN_ISOLATION=off\`, plugins share Transcoda's user and can do both. The official catalog only lists builds made by our CI from the public source, signed with a key this version of Transcoda knows; the signature and checksum are verified before every start, and a blocklist we publish stops known-bad builds within an hour. Custom catalogs are unsigned unless you pin their key, and show a warning for this reason. Install only what you would run on the server yourself.`;

/**
 * The remove confirmation. A removed plugin's nodes read "plugin missing" in the editor (design
 * N6; "unknown node" is left for a core or un-namespaced type the server does not know).
 */
export function removeConfirmText(
  name: string,
  usedBy: Array<{ name: string; active: boolean }>,
): string {
  let text = `Remove ${name}? Its settings are deleted too.`;
  if (usedBy.length > 0) {
    const names = usedBy.map((w) => w.name).join(', ');
    text +=
      usedBy.length === 1
        ? ` 1 workflow uses its nodes and will show "plugin missing": ${names}.`
        : ` ${usedBy.length} workflows use its nodes and will show "plugin missing": ${names}.`;
  }
  const active = usedBy.filter((w) => w.active).map((w) => w.name);
  if (active.length > 0) {
    text += ` ${active.join(', ')} ${active.length === 1 ? 'is' : 'are'} active and will stop running until a version without these nodes is activated.`;
  }
  return text;
}

/** The Disable confirmation (asked only when workflows use the plugin). */
export function disableConfirmText(
  name: string,
  usedBy: Array<{ name: string; active: boolean }>,
): string {
  const names = usedBy.map((w) => w.name).join(', ');
  let text = `Disable ${name}? ${usedBy.length === 1 ? '1 workflow uses its nodes and they' : `${usedBy.length} workflows use its nodes and they`} will show "plugin not running": ${names}.`;
  const active = usedBy.filter((w) => w.active).map((w) => w.name);
  if (active.length > 0) {
    text += ` ${active.join(', ')} ${active.length === 1 ? 'is' : 'are'} active and will stop running until ${name} is enabled again.`;
  }
  return text;
}

/** The badge on an installed plugin's row: always a word, the tone only colours it. */
export interface PluginStatus {
  tone: 'ok' | 'error' | 'warning' | 'neutral';
  label: string;
}

const FAILED_TEST: Record<string, string> = {
  unreachable: "Can't reach server",
  unauthorized: 'Access refused',
  'wrong-product': 'Wrong server',
  'too-old': 'Server too old',
};

/**
 * A plugin that does not run says so first (Blocked, Stopped, Restarting, Starting, Disabled);
 * a running one with settings says how its last stored connection test went, else Running.
 */
export function statusOf(p: PluginSummary, now: Date): PluginStatus {
  if (p.blocked) return { tone: 'error', label: 'Blocked' };
  switch (p.state) {
    case 'stopped':
      return { tone: 'error', label: 'Stopped' };
    case 'restarting': {
      const label = stateLabel(p, now);
      return { tone: 'warning', label: label.charAt(0).toUpperCase() + label.slice(1) };
    }
    case 'starting':
      return { tone: 'neutral', label: 'Starting' };
    case 'disabled':
      return { tone: 'neutral', label: 'Disabled' };
    case 'running':
      break;
  }
  if (!p.hasIntegration) return { tone: 'ok', label: 'Running' };
  if (p.lastTest === null) return { tone: 'warning', label: 'Not tested' };
  if (p.lastTest.ok) return { tone: 'ok', label: 'Connected' };
  return { tone: 'error', label: FAILED_TEST[p.lastTest.kind ?? 'other'] ?? 'Test failed' };
}

/** "Used by TV cleanup, Movie shrink"; past three names, "and 2 more". */
export function usedByText(usedBy: ReadonlyArray<{ name: string }>): string {
  if (usedBy.length === 0) return 'Not used by any workflow yet';
  const names = usedBy.slice(0, 3).map((w) => w.name);
  const rest = usedBy.length - names.length;
  return `Used by ${names.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`;
}

/** "Test failed 2 min ago: connection refused" (the plugin's own message, never a secret). */
export function testSentence(
  last: NonNullable<PluginSettingsGetOutput['lastTest']>,
  now: Date,
): string {
  return `Test ${last.result.ok ? 'passed' : 'failed'} ${fmtAgo(last.at, now)}: ${last.result.message}`;
}

/**
 * What a failed connection costs, from the plugin's nodes: finish steps in one phase skip only
 * their own part (they run after the file is written); anything else, a generic line.
 */
export function testEffect(
  title: string,
  nodes: ReadonlyArray<Pick<NodeInfo, 'kind' | 'finishPhase'>>,
): string {
  const phases = new Set(nodes.map((n) => (n.kind === 'finish' ? n.finishPhase : null)));
  const only = phases.size === 1 ? [...phases][0] : null;
  if (only === 'media-server')
    return 'Files are still replaced; only the library refresh is skipped.';
  if (only === 'library-manager') {
    return `Files are still replaced; only the rescan in ${title} is skipped.`;
  }
  if (only === 'notify') return `Jobs still finish; only the ${title} notification is skipped.`;
  return `Steps that need ${title} won't work until it connects.`;
}
