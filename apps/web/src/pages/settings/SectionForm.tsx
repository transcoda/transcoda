import { ORPCError } from '@orpc/client';
import type { Settings, SettingsUpdateInput } from '@transcoda/contract';
import { type ReactNode, useId, useState } from 'react';
import { api } from '../../api/client.ts';
import { describeError } from '../../api/errors.ts';
import { DisabledReason } from '../../components/Form.tsx';
import { Icon } from '../../components/Icon.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useToast } from '../../components/Toast.tsx';
import { changedFields, sectionDirty } from './dirty.ts';
import { useSettings } from './useSettings.ts';

/** A section's form values: text while typed, numbers and null as loaded. */
export type Draft = Record<string, string | number | string[] | null>;
export type Issues<D extends Draft> = Partial<Record<keyof D, string>>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * The per-field messages of a rejected update (`data.issues`, a zod-style `path` of the update
 * field), or null when the failure names no field.
 */
export function updateIssuesOf(err: unknown): Record<string, string> | null {
  if (!(err instanceof ORPCError) || !isRecord(err.data) || !Array.isArray(err.data.issues)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const issue of err.data.issues) {
    if (!isRecord(issue) || typeof issue.message !== 'string') continue;
    const path = Array.isArray(issue.path) ? issue.path[0] : issue.path;
    if (typeof path === 'string') out[path] = issue.message;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** A whole number in [min, max] typed as text (or as loaded), else the message for its field. */
export function wholeNumberIssue(v: string | number | null, min: number, max: number) {
  const text = typeof v === 'number' ? String(v) : (v ?? '').trim();
  const n = Number(text);
  return /^\d+$/.test(text) && n >= min && n <= max
    ? null
    : `Enter a whole number from ${min} to ${max}`;
}

export interface SettingsForm<D extends Draft> {
  settings: Settings | null;
  loadError: unknown;
  draft: D | null;
  setField(key: keyof D, value: D[keyof D]): void;
  issues: Issues<D>;
  formError: string | null;
  busy: boolean;
  dirty: boolean;
  save(): Promise<void>;
  /** Puts the saved values back in the form (a failed save of a previewed value). */
  reset(): void;
}

/**
 * One Settings section's form over `settings.get`: the draft starts from the loaded values, Save
 * is enabled only while it differs, a save sends only the changed fields and the answer replaces
 * the form. A field the server rejects carries the server's message.
 */
export function useSettingsForm<D extends Draft>(opts: {
  draftOf(s: Settings): D;
  /** Called only on a draft without issues. */
  inputOf(d: D): SettingsUpdateInput;
  check(d: D): Issues<D>;
  /** Update field → draft key, for the server's per-field messages. */
  fieldOf: Partial<Record<keyof SettingsUpdateInput, keyof D>>;
  onSaved?(s: Settings): void;
  onFailed?(): void;
}): SettingsForm<D> {
  const toast = useToast();
  const loaded = useSettings();
  const data = loaded.data;
  // The edited draft, tied to the values it was edited from: a new load or a save's answer resets it.
  const [edit, setEdit] = useState<{ over: Settings; value: D } | null>(null);
  const [issues, setIssues] = useState<Issues<D>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const saved = data ? opts.draftOf(data) : null;
  const draft = edit && edit.over === data ? edit.value : saved;
  const dirty = draft !== null && saved !== null && sectionDirty(draft, saved);

  function setField(key: keyof D, value: D[keyof D]) {
    if (!data || !draft) return;
    setEdit({ over: data, value: { ...draft, [key]: value } });
    setIssues((was) => {
      const { [key]: _gone, ...rest } = was;
      return rest as Issues<D>;
    });
  }

  async function save() {
    if (busy || !dirty || !draft || !saved) return;
    const found = opts.check(draft);
    setIssues(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const out = await api.settings.update(
        changedFields(opts.inputOf(draft), opts.inputOf(saved)),
      );
      loaded.set(out);
      setEdit(null);
      opts.onSaved?.(out);
      toast.success('Settings saved');
    } catch (err) {
      const byField = updateIssuesOf(err);
      const mapped: Issues<D> = {};
      for (const [field, message] of Object.entries(byField ?? {})) {
        const key = opts.fieldOf[field as keyof SettingsUpdateInput];
        if (key !== undefined) mapped[key] = message;
      }
      if (Object.keys(mapped).length > 0) setIssues(mapped);
      else setFormError(describeError(err).message);
      opts.onFailed?.();
    } finally {
      setBusy(false);
    }
  }

  return {
    settings: data,
    loadError: loaded.error,
    draft,
    setField,
    issues,
    formError,
    busy,
    dirty,
    save,
    reset: () => setEdit(null),
  };
}

/** Loading, or why the settings could not be loaded; null once they are there. */
export function SectionStatus({ loaded, error }: { loaded: boolean; error: unknown }) {
  if (loaded) return null;
  if (error) {
    return (
      <div className="alert alert-danger" role="alert">
        <Icon name="cross" strokeWidth={2.4} round />
        <span>{`Could not load the settings: ${describeError(error).message}`}</span>
      </div>
    );
  }
  return <Loading inline label="Loading settings…" />;
}

/** A field's problem, under its control; point the control's `aria-describedby` at `id`. */
export function FieldIssue({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="tc-field-issue">
      <Icon name="alert" size={14} round />
      {children}
    </p>
  );
}

/** The form's failure (not tied to one field). */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="alert alert-danger" role="alert">
      <Icon name="cross" strokeWidth={2.4} round />
      <span>{message}</span>
    </div>
  );
}

/**
 * The section's one Save. `reason`: why it is disabled, shown under it; only a reason that names
 * something to fix is worth showing (convention 12), so `disabled` alone keeps it off without one
 * (nothing changed yet, fields still empty).
 */
export function SaveRow({
  reason,
  disabled = false,
  busy,
  label = 'Save',
}: {
  reason: string | null;
  disabled?: boolean;
  busy: boolean;
  label?: string | undefined;
}) {
  const id = useId();
  return (
    <>
      <div className="form-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || disabled || reason !== null}
          {...(reason === null ? {} : { 'aria-describedby': id })}
        >
          {label}
        </button>
      </div>
      {reason === null ? null : <DisabledReason id={id}>{reason}</DisabledReason>}
    </>
  );
}

/**
 * A whole-number field with its unit after it and its problem under it. `hinted`: its row shows a
 * hint (`${id}-hint`, see SettingRow), which describes the input too.
 */
export function NumberField({
  id,
  value,
  min,
  max,
  unit,
  issue,
  hinted = false,
  onChange,
}: {
  id: string;
  value: string | number | null;
  min: number;
  max: number;
  unit: string;
  issue: string | undefined;
  hinted?: boolean;
  onChange(v: string): void;
}) {
  const issueId = `${id}-issue`;
  const describedBy = [hinted ? `${id}-hint` : null, issue ? issueId : null].filter(Boolean);
  return (
    <>
      <span className="setting-number">
        <input
          id={id}
          className="input"
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={value ?? ''}
          aria-invalid={issue ? true : undefined}
          aria-describedby={describedBy.length > 0 ? describedBy.join(' ') : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="setting-unit">{unit}</span>
      </span>
      {issue ? <FieldIssue id={issueId}>{issue}</FieldIssue> : null}
    </>
  );
}
