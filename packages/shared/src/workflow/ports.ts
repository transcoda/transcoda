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
