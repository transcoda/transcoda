import type { JsonValue } from '@transcoda/shared';
import { createContext, type ReactNode, useContext, useId } from 'react';
import { Icon } from '../../../components/Icon.tsx';
import type { FieldDef } from '../../model/schema-fields.ts';

export interface FieldProps<T = JsonValue> {
  def: FieldDef;
  value: T | undefined;
  onChange(v: JsonValue | undefined): void;
  /** The client or server message for this setting; amber under the control. */
  issue: string | null;
  readOnly: boolean;
  autoFocus?: boolean;
  /**
   * The node has a `data:language` input. Off by default; reserved for an "Original (from data)"
   * choice once a settings value can express it (never an alias for unset).
   */
  originalOption?: boolean;
  /**
   * The label is read by screen readers only: the row around the field already shows it (a Run
   * node's override row, where the same label sits next to the Override switch).
   */
  labelHidden?: boolean;
}

/**
 * Extra parts a form can hang on each field by setting key: `head` after the label row's own
 * controls (the shared-value link), `foot` under the control. Null leaves the field as it is.
 */
export const FieldExtrasContext = createContext<
  ((key: string) => { head: ReactNode; foot: ReactNode } | null) | null
>(null);

/** Ids and ARIA wiring the frame hands to its control. */
export interface FieldIds {
  /** The control's id; a `<label for>` points at it for single controls. */
  id: string;
  labelId: string;
  /** `aria-describedby` for the control (the issue line), or undefined. */
  describedBy: string | undefined;
  invalid: boolean;
}

/**
 * Plain names for the core nodes' single-word option values (codec, container and mode ids as
 * ffmpeg and the schemas spell them), so the inspector never shows a raw id such as "hevc" or
 * "reencode". The stored value never changes.
 */
const OPTION_LABELS: Record<string, string> = {
  hevc: 'HEVC (H.265)',
  h264: 'H.264',
  av1: 'AV1',
  quality: 'Quality',
  bitrate: 'Bitrate',
  never: 'Never',
  copy: 'Copy',
  reencode: 'Re-encode',
  aac: 'AAC',
  ac3: 'AC-3',
  opus: 'Opus',
  none: 'None',
  stereo: 'Stereo',
  convert: 'Convert',
  fail: 'Fail',
  keep: 'Keep',
  recycle: 'Recycle',
  move: 'Move',
  mkv: 'MKV',
  mp4: 'MP4',
  audio: 'Audio',
  subtitle: 'Subtitle',
  'android-tv': 'Android TV',
  chrome: 'Chrome',
};

/**
 * Display text for an enum value: a plain name from `OPTION_LABELS`, else multi-word ids are
 * sentence-cased ("drop-incompatible" → "Drop incompatible"); other single tokens stay as stored
 * (a plugin's ids, whose casing cannot be guessed). The stored value never changes.
 */
export function humanise(value: string): string {
  const named = OPTION_LABELS[value];
  if (named !== undefined) return named;
  if (!/[-_]/.test(value)) return value;
  const words = value.replace(/[-_]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A default rendered as an input placeholder ("shown as placeholders when cleared"). */
export function placeholderFor(def: FieldDef): string | undefined {
  const d = def.default;
  return typeof d === 'string' || typeof d === 'number' ? String(d) : undefined;
}

/**
 * What an unset field falls back to, as the card shows it: "Default: 24", "Default: on". Null
 * without a plain default (none, a list, an object): the field says "not set" instead.
 */
export function defaultText(def: FieldDef): string | null {
  const d = def.default;
  if (typeof d === 'boolean') return `Default: ${d ? 'on' : 'off'}`;
  if (typeof d === 'number') return `Default: ${d}`;
  if (typeof d === 'string' && d !== '') {
    return `Default: ${def.spec.kind === 'enum' ? humanise(d) : d}`;
  }
  return null;
}

/** The value is the setting's plain default (stored or not, the node behaves the same). */
function isDefault(def: FieldDef, value: JsonValue | undefined): boolean {
  const d = def.default;
  return (
    value !== undefined &&
    (typeof d === 'boolean' || typeof d === 'number' || (typeof d === 'string' && d !== '')) &&
    value === d
  );
}

/**
 * The shared frame of every inspector field: the label (with its unit), "Default: 24" for an
 * optional setting left at its default (unset or stored with the default value, so a new node
 * with its defaults filled in reads like an older one without them), "not set" for one without a
 * value or default, a Clear button for an optional setting changed from it, and the message slot
 * (amber, icon + text). `data-field` lets the inspector focus a field by setting path.
 * `labelling: 'group'` is for controls made of several elements (chips, radio groups): the label
 * is a plain element the control's own group names itself by (`aria-labelledby={labelId}`)
 * instead of a `<label for>`. `notSet` replaces the
 * "not set" text (null hides it when the control itself says what unset means).
 */
export function Field({
  def,
  value,
  onChange,
  issue,
  readOnly,
  labelHidden = false,
  labelling = 'control',
  unitInLabel = true,
  notSet = 'not set',
  clearable = true,
  children,
}: Pick<FieldProps, 'def' | 'value' | 'onChange' | 'issue' | 'readOnly' | 'labelHidden'> & {
  labelling?: 'control' | 'group';
  /** False when the control shows the unit itself (NumberField's suffix); the label keeps it for screen readers. */
  unitInLabel?: boolean;
  notSet?: string | null;
  /** False hides Clear (a write-only value the server holds cannot be cleared from here). */
  clearable?: boolean;
  children(ids: FieldIds): ReactNode;
}) {
  const id = useId();
  const extras = useContext(FieldExtrasContext)?.(def.key) ?? null;
  const labelId = `${id}-label`;
  const issueId = `${id}-issue`;
  const hintId = `${id}-hint`;
  const describedBy = [def.hint ? hintId : null, issue ? issueId : null].filter(Boolean).join(' ');
  const optional = !def.required;
  const atDefault = value === undefined || isDefault(def, value);
  const unit = def.unit ? (
    <>
      {' '}
      <span className={unitInLabel ? 'tc-field-unit' : 'sr-only'}>({def.unit})</span>
    </>
  ) : null;
  const ids: FieldIds = {
    id,
    labelId,
    describedBy: describedBy || undefined,
    invalid: issue !== null,
  };

  return (
    <div className={issue ? 'tc-field has-issue' : 'tc-field'} data-field={def.key}>
      <div className="tc-field-head">
        {labelling === 'group' ? (
          <span id={labelId} className={labelHidden ? 'sr-only' : 'tc-field-label'}>
            {def.label}
            {unit}
          </span>
        ) : (
          <label id={labelId} htmlFor={id} className={labelHidden ? 'sr-only' : 'tc-field-label'}>
            {def.label}
            {unit}
          </label>
        )}
        {optional && atDefault && notSet !== null && (
          <span className="tc-field-notset">{defaultText(def) ?? notSet}</span>
        )}
        {optional && !atDefault && !readOnly && clearable && (
          <button
            type="button"
            className="tc-field-clear"
            aria-label={`Clear ${def.label}`}
            onClick={() => onChange(undefined)}
          >
            Clear
          </button>
        )}
        {extras?.head}
      </div>
      {children(ids)}
      {extras?.foot}
      {/* Under the control, like every settings row: label, control, short help. */}
      {def.hint && (
        <span id={hintId} className="tc-field-hint">
          {def.hint}
        </span>
      )}
      {issue && (
        <p id={issueId} className="tc-field-issue">
          <Icon name="alert" size={14} round />
          {issue}
        </p>
      )}
    </div>
  );
}
