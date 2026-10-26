import type { NodeInfo } from '@transcoda/contract';
import type { JsonValue, NodeInstance } from '@transcoda/shared';
import { useId, useMemo, useState } from 'react';
import { languageName } from '../../data/languages.ts';
import { useLibraries } from '../../hooks/useLibraries.ts';
import type { ZoomLevel } from '../flow/useZoomLevel.ts';
import { NEEDS_A_SETTING, type NodeState } from '../model/issues.ts';
import {
  clientIssue,
  coerce,
  type FieldDef,
  fieldShown,
  fieldsFor,
  LANGUAGE_PATTERN,
  numberStep,
  onNodeControlKeys,
} from '../model/schema-fields.ts';
import { humanise } from './fields/Field.tsx';
import { LibrarySelect, libraryName, MISSING_LIBRARY } from './fields/LibrarySelect.tsx';
import { numberText } from './fields/NumberField.tsx';

type JsonObject = { [key: string]: JsonValue };

function isObject(v: JsonValue | undefined): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** At most this many chips; the rest is one "+N" chip. */
const MAX_CHIPS = 4;
const SEP = ' · ';

/** "Quality" + unit "CRF" → "Quality (CRF)", as the schema describes it. */
const labelOf = (field: FieldDef) => (field.unit ? `${field.label} (${field.unit})` : field.label);

type Chip = { text: string; title?: string };

/** A boolean sibling setting's effective value (stored, else its default). */
function flag(fields: FieldDef[], settings: JsonObject, key: string): boolean {
  const field = fields.find((f) => f.key === key && f.spec.kind === 'boolean');
  if (!field) return false;
  return (settings[key] ?? field.default) === true;
}

/**
 * A list setting as chips: language codes in their short form (the code; "unknown" reads
 * "untagged"). A language list with `keepOriginal` / `keepUntagged` siblings (Keep languages) is a
 * view over the three fields: those add the words "original" and "untagged".
 */
function chipsOf(field: FieldDef, value: JsonValue[], fields: FieldDef[], settings: JsonObject) {
  const chips: Chip[] = value.map((v) => {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    if (field.spec.kind === 'languages') {
      return text === 'unknown'
        ? { text: 'untagged', title: languageName(text) }
        : { text, title: languageName(text) };
    }
    return { text: field.spec.kind === 'enum-list' ? humanise(text) : text };
  });
  if (field.spec.kind === 'languages') {
    if (flag(fields, settings, 'keepOriginal')) chips.push({ text: 'original' });
    if (flag(fields, settings, 'keepUntagged') && !chips.some((c) => c.text === 'untagged')) {
      chips.push({ text: 'untagged' });
    }
  }
  if (chips.length <= MAX_CHIPS) return chips;
  return [...chips.slice(0, MAX_CHIPS), { text: `+${chips.length - MAX_CHIPS}` }];
}

/** A single value as short text. */
function textOf(field: FieldDef, value: JsonValue | undefined): string {
  if (value === undefined || value === null) return 'not set';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'string') {
    if (field.spec.kind === 'password') return 'set';
    return field.spec.kind === 'enum' ? humanise(value) : value;
  }
  if (typeof value === 'number') return numberText(field.spec, value);
  return 'set';
}

/**
 * N12, the card's on-node row for the first of the node's `onNodeSettings`: at zoom `full` a
 * 28 px number input or a small select bound to the setting (`nodrag nopan`), or a summary of the
 * value (chips for lists, "label · value" otherwise) that focuses the inspector field on click.
 * Below `full` only the summary text is left (no controls); at `icon` nothing. A missing required
 * value reads "needs a setting". A typed value that is not a number is not applied; a value out
 * of range is (the server decides) and its bound shows as the input's title.
 */
export function OnNodeRow({
  def,
  instance,
  state,
  zoom,
  readOnly,
  onChange,
  onFocus,
}: {
  def: NodeInfo;
  instance: NodeInstance;
  state: NodeState;
  zoom: ZoomLevel;
  readOnly: boolean;
  onChange(settings: JsonValue): void;
  onFocus(key: string): void;
}) {
  const fields = useMemo(() => fieldsFor(def.settingsSchema), [def.settingsSchema]);
  const entries = useMemo(() => onNodeControlKeys(def), [def]);
  const settings = instance.settings;
  if (zoom === 'icon' || !isObject(settings)) return null;
  // Read-only (a past version, the job page's flow) reads like the compact card: text, never a
  // disabled field that looks editable.
  const level: ZoomLevel = readOnly && zoom === 'full' ? 'compact' : zoom;
  // The first on-node setting the inspector shows for these settings (Encode video: the quality,
  // or the target bitrate in bitrate mode).
  const fieldOf = (key: string) => fields.find((f) => f.key === key);
  const entry = entries.find((e) => {
    const f = fieldOf(e.key);
    return f !== undefined && fieldShown(f, settings, fields);
  });
  const field = entry && fieldOf(entry.key);
  if (!entry || !field) return null;

  const stored = settings[field.key];
  const value = stored ?? field.default;
  const label = entry.control === 'first-language' ? DEFAULT_AUDIO : labelOf(field);
  if (entry.control === 'library') {
    return (
      <OnNodeLibrary
        field={field}
        label={label}
        id={typeof stored === 'string' ? stored : ''}
        flagged={!!state.fieldIssues.get(field.key)?.some((i) => i.message === NEEDS_A_SETTING)}
        zoom={level}
        readOnly={readOnly}
        onChange={(v) => onChange({ ...settings, [field.key]: v })}
        onFocus={onFocus}
      />
    );
  }
  const flagged = state.fieldIssues.get(field.key)?.some((i) => i.message === NEEDS_A_SETTING);
  if ((value === undefined && field.required) || flagged) {
    const cls = level === 'full' ? 'tc-onnode is-missing' : 'tc-node-summary is-missing';
    return <div className={cls}>needs a setting</div>;
  }

  if (entry.control === 'first-language' && field.spec.kind === 'languages') {
    const list = Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : [];
    if (level !== 'full') {
      return <div className="tc-node-summary">{`${label}${SEP}${list[0] ?? 'not set'}`}</div>;
    }
    return (
      <OnNodeFirstLanguage
        label={label}
        list={list}
        readOnly={readOnly}
        onChange={(next) => onChange({ ...settings, [field.key]: next })}
      />
    );
  }

  const chips = Array.isArray(value) ? chipsOf(field, value, fields, settings) : null;
  const summary = chips
    ? chips.length > 0
      ? chips.map((c) => c.text).join(SEP)
      : 'none'
    : `${label}${SEP}${textOf(field, value)}`;

  if (level !== 'full') return <div className="tc-node-summary">{summary}</div>;

  const set = (v: JsonValue) => onChange({ ...settings, [field.key]: v });

  if (entry.control === 'number' && field.spec.kind === 'number') {
    return (
      <OnNodeNumber
        field={field}
        label={label}
        stored={stored}
        readOnly={readOnly}
        onChange={set}
      />
    );
  }

  if (entry.control === 'select' && field.spec.kind === 'enum') {
    const { options } = field.spec;
    const current = typeof value === 'string' && options.includes(value) ? value : undefined;
    return (
      <label className="tc-onnode">
        <span className="tc-onnode-label">{label}</span>
        <select
          className="tc-onnode-select nodrag nopan"
          value={current ?? ''}
          disabled={readOnly}
          onChange={(e) => {
            if (e.target.value !== '') set(e.target.value);
          }}
        >
          {current === undefined && <option value="">—</option>}
          {options.map((o) => (
            <option key={o} value={o}>
              {humanise(o)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <button
      type="button"
      className="tc-onnode tc-onnode-summary nodrag nopan"
      aria-label={`${chips ? `${label}: ` : ''}${summary}. Edit in the inspector`}
      title="Edit in the inspector"
      onClick={() => onFocus(field.key)}
    >
      {chips ? (
        <span className="chips-mini">
          {chips.length === 0 ? (
            <span className="is-empty">none</span>
          ) : (
            chips.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a list may repeat a value.
              <span key={i} {...(c.title ? { title: c.title } : {})}>
                {c.text}
              </span>
            ))
          )}
        </span>
      ) : (
        <span className="tc-onnode-text">{summary}</span>
      )}
    </button>
  );
}

const DEFAULT_AUDIO = 'Default audio';
/** A select never offers more than this many languages (N12: a pick of at most five). */
const MAX_LANGUAGE_OPTIONS = 5;
/** Offered after the node's own languages, to fill the select. */
const COMMON_LANGUAGES = ['en', 'de', 'fr', 'es', 'ja'];
const LANGUAGE_RE = new RegExp(LANGUAGE_PATTERN);

/**
 * Default audio: a select that edits the first entry of the node's ordered `audioLanguages`; the
 * rest of the list stays (the inspector edits all of it). Options: the node's own languages, then
 * common ones, five at most. A language picked that is already further down the list moves up
 * instead of repeating. The pick must match the language pattern the schema states.
 */
function OnNodeFirstLanguage({
  label,
  list,
  readOnly,
  onChange,
}: {
  label: string;
  list: string[];
  readOnly: boolean;
  onChange(next: string[]): void;
}) {
  const first = list[0];
  const options = [...new Set([...list, ...COMMON_LANGUAGES])].slice(0, MAX_LANGUAGE_OPTIONS);
  return (
    <label className="tc-onnode">
      <span className="tc-onnode-label">{label}</span>
      <select
        className="tc-onnode-select nodrag nopan"
        value={first ?? ''}
        disabled={readOnly}
        onChange={(e) => {
          const code = e.target.value;
          if (!LANGUAGE_RE.test(code)) return;
          onChange([code, ...list.slice(1).filter((l) => l !== code)]);
        }}
      >
        {first === undefined && <option value="">—</option>}
        {options.map((code) => (
          <option key={code} value={code}>
            {languageName(code)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Library: a select of the existing libraries. Until the list is there (or when it cannot be
 * loaded) the card shows the plain summary that opens the inspector field. A stored id that no
 * library has stays selectable as "Missing library" rather than being replaced.
 */
function OnNodeLibrary({
  field,
  label,
  id,
  flagged,
  zoom,
  readOnly,
  onChange,
  onFocus,
}: {
  field: FieldDef;
  label: string;
  id: string;
  flagged: boolean;
  zoom: ZoomLevel;
  readOnly: boolean;
  onChange(v: JsonValue): void;
  onFocus(key: string): void;
}) {
  const selectId = useId();
  const { libraries, error } = useLibraries();
  const name = libraries ? libraryName(libraries, id) : undefined;
  const text = id === '' ? 'needs a setting' : (name ?? (libraries ? MISSING_LIBRARY : '…'));
  if (zoom !== 'full') {
    return (
      <div className={id === '' ? 'tc-node-summary is-missing' : 'tc-node-summary'}>
        {id === '' ? text : `${label}${SEP}${text}`}
      </div>
    );
  }
  if (!libraries || error) {
    return (
      <button
        type="button"
        className="tc-onnode tc-onnode-summary nodrag nopan"
        aria-label={`${label}: ${text}. Edit in the inspector`}
        title="Edit in the inspector"
        onClick={() => onFocus(field.key)}
      >
        <span className="tc-onnode-text">{`${label}${SEP}${text}`}</span>
      </button>
    );
  }
  return (
    <label
      htmlFor={selectId}
      className={id === '' || flagged ? 'tc-onnode is-missing' : 'tc-onnode'}
    >
      <span className="tc-onnode-label">{label}</span>
      <LibrarySelect
        libraries={libraries}
        id={selectId}
        value={id}
        className="tc-onnode-select nodrag nopan"
        disabled={readOnly}
        onChange={onChange}
      />
    </label>
  );
}

/** The 28 px number input; keeps the typed text while it still means the stored value. */
function OnNodeNumber({
  field,
  label,
  stored,
  readOnly,
  onChange,
}: {
  field: FieldDef;
  label: string;
  stored: JsonValue | undefined;
  readOnly: boolean;
  onChange(v: JsonValue): void;
}) {
  const spec = field.spec.kind === 'number' ? field.spec : null;
  const asText = (v: JsonValue | undefined) => numberText(field.spec, v);
  // The typed text stays while it is not a number (emptied, "-"): leaving the field or a value
  // changed from outside (undo) brings the stored value back.
  const [draft, setDraft] = useState(() => asText(stored));
  const [seen, setSeen] = useState(stored);
  const typed = (text: string) => (spec ? coerce(spec, text) : undefined);
  if (seen !== stored) {
    setSeen(stored);
    if (typed(draft) !== stored) setDraft(asText(stored));
  }
  const issue = clientIssue(field, stored);
  return (
    <label className="tc-onnode">
      <span className="tc-onnode-label">{label}</span>
      <input
        type="number"
        className="tc-onnode-input nodrag nopan nowheel"
        inputMode={spec?.integer ? 'numeric' : 'decimal'}
        min={spec?.min}
        max={spec?.max}
        step={spec ? numberStep(spec) : 'any'}
        value={draft}
        placeholder={typeof field.default === 'number' ? String(field.default) : undefined}
        readOnly={readOnly}
        title={issue ?? undefined}
        aria-invalid={issue ? true : undefined}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          if (!spec) return;
          const v = coerce(spec, raw);
          // Not a number (or emptied): the old value stays.
          if (v !== undefined) onChange(v);
        }}
        onBlur={() => {
          if (typed(draft) !== stored) setDraft(asText(stored));
        }}
      />
    </label>
  );
}
