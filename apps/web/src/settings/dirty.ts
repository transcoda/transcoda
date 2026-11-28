import type { SettingsUpdateInput } from '@transcoda/contract';

/** null, undefined and blank text are all "no value"; text is compared without its outer spaces. */
function norm(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  return v;
}

/** One field: numbers as numbers ("07" is 7, "" is no number), '' ≡ null, text trimmed. */
function same(a: unknown, b: unknown): boolean {
  // A list (the GPU order) is the same when it holds the same items in the same order.
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  const x = norm(a);
  const y = norm(b);
  if (typeof x === 'number' || typeof y === 'number') {
    if (x === null || y === null) return x === y;
    return Number(x) === Number(y);
  }
  return x === y;
}

/** The section's draft differs from the saved values (numbers compared as numbers, '' ≡ null for the name). */
export function sectionDirty<T extends Record<string, unknown>>(draft: T, saved: T): boolean {
  return Object.keys(draft).some((k) => !same(draft[k], saved[k]));
}

/** Only the changed fields, as the update input (never sends unchanged fields); each section maps its draft to update-input field names first. */
export function changedFields(
  draft: SettingsUpdateInput,
  saved: SettingsUpdateInput,
): SettingsUpdateInput {
  const keys = Object.keys(draft) as (keyof SettingsUpdateInput)[];
  return Object.fromEntries(
    keys.filter((k) => !same(draft[k], saved[k])).map((k) => [k, draft[k]]),
  ) as SettingsUpdateInput;
}
