import type { JsonValue } from '@transcoda/shared';

/** A Run sub-workflow node's settings, as the card and the inspector both read them. */

type JsonObject = { [key: string]: JsonValue };

function isObject(v: JsonValue | undefined): v is JsonObject {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);
}

/** A Run node's settings, read leniently (no zod on settings in the browser). */
export interface RunSettings {
  subworkflowId?: string;
  version?: number;
  overrides: Record<string, JsonValue>;
}

export function readRunSettings(settings: JsonValue): RunSettings {
  const s = isObject(settings) ? settings : {};
  const id = s.subworkflowId;
  const version = s.version;
  return {
    ...(typeof id === 'string' && id !== '' ? { subworkflowId: id } : {}),
    ...(typeof version === 'number' && Number.isInteger(version) && version >= 1
      ? { version }
      : {}),
    overrides: isObject(s.overrides) ? s.overrides : {},
  };
}
