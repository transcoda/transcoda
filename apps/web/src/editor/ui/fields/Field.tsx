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
 * Display text for an enum value: multi-word ids are sentence-cased ("drop-incompatible" →
 * "Drop incompatible"); single tokens stay as stored (codec and container ids such as hevc, mkv,
 * aac, whose casing cannot be guessed). The stored value never changes.
 */
export function humanise(value: string): string {
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
  if (typeof d === 'string' && d !== '') return `Default: ${d}`;
  return null;
}

/**
 * The shared frame of every inspector field: the label (with its unit), "not set" for an optional
 * setting without a value, a Clear button for an optional setting with one, and the message slot
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
        {optional && value === undefined && notSet !== null && (
          <span className="tc-field-notset">{defaultText(def) ?? notSet}</span>
        )}
        {optional && value !== undefined && !readOnly && clearable && (
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
