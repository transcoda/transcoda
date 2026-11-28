import type { JsonValue } from '../json.ts';

/**
 * What people read on a two-way branch. The port ids `pass` and `else` are stored in saved
 * graphs, examples and plugin manifests and never change; the words shown for them are "Yes"
 * (the pass side) and "No" (the else side).
 */
const BRANCH_WORDS = new Map([
  ['pass', 'Yes'],
  ['else', 'No'],
]);

/** "Yes" for `pass`, "No" for `else`, null for any other port id. */
export function branchWord(portId: string): string | null {
  return BRANCH_WORDS.get(portId) ?? null;
}

/**
 * The words shown for an output port. A `pass`/`else` port reads Yes/No when its label is the
 * generic one ("Pass", "Else", "pass", "else", "Yes", "No"); a plugin that gives such a port its
 * own words ("Matches", "Other") keeps them. Every other port keeps its label.
 */
export function branchPortLabel(port: { id: string; label: string }): string {
  const word = branchWord(port.id);
  if (word === null) return port.label;
  return /^(pass|else|yes|no)$/i.test(port.label.trim()) ? word : port.label;
}

/** When an output port is shown: only while the node's `setting` deep-equals `equals`. */
export interface PortShownWhen {
  setting: string;
  equals: JsonValue;
}

function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
}

/**
 * Whether an output port is shown for a node's settings: always without `shownWhen`; otherwise
 * only when the settings are an object whose `shownWhen.setting` deep-equals `shownWhen.equals`.
 */
export function portShown(
  port: { id: string; shownWhen?: PortShownWhen | undefined },
  settings: JsonValue,
): boolean {
  const when = port.shownWhen;
  if (when === undefined) return true;
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return false;
  return Object.hasOwn(settings, when.setting) && jsonEqual(settings[when.setting], when.equals);
}
