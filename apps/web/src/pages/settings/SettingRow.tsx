import type { SettingSource } from '@transcoda/contract';
import { type ReactNode, useId } from 'react';
import { Disclosure } from '../../components/Disclosure.tsx';
import { GroupLabel } from '../../components/Headings.tsx';
import { envDocsUrl, envSourceText, sourceText } from './sourceText.ts';

/** An environment value's source: the variable, and whether it is set (else the default is used). */
export type EnvSource = { kind: 'env'; variable: string; set: boolean };

/** "From TRANSCODA_X" with the name as <code>, the rest as text. */
function withCode(text: string, variable: string): ReactNode {
  const at = text.indexOf(variable);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <code>{variable}</code>
      {text.slice(at + variable.length)}
    </>
  );
}

/** An environment source, under the value: the variable as <code> and a link to its docs. */
function EnvLine({ variable, set }: { variable: string; set: boolean }) {
  return (
    <p className="setting-source">
      {withCode(envSourceText(variable, set), variable)}
      {' · '}
      <a href={envDocsUrl(variable)} target="_blank" rel="noreferrer">
        Docs <span className="sr-only">for {variable}</span>
      </a>
    </p>
  );
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * An editable value's source, for its row's tag, only while the value differs from the default
 * (convention 11: a default is not printed as content); undefined otherwise.
 */
export function shownSource(setting: {
  value: unknown;
  default: unknown;
  source: SettingSource;
}): SettingSource | undefined {
  return sameValue(setting.value, setting.default) ? undefined : setting.source;
}

/**
 * Where a value comes from: a quiet tag beside the label, or the env line under the value. A
 * default needs no tag.
 */
function sourceParts(source: SettingSource | EnvSource | undefined) {
  if (!source || source.kind === 'default') return { tag: null, line: null };
  if (source.kind !== 'env') return { tag: sourceText(source), line: null };
  const set = 'set' in source ? source.set : true;
  return { tag: null, line: <EnvLine variable={source.variable} set={set} /> };
}

/** The row's label line: the label (or legend text) and the source tag on the right. */
export function SettingHead({ children, tag }: { children: ReactNode; tag?: string | null }) {
  return (
    <div className="setting-head">
      {children}
      {tag ? <span className="setting-tag">{tag}</span> : null}
    </div>
  );
}

/**
 * One labelled value, the one row layout of every Settings screen: the label (with where the
 * value comes from as a quiet tag), the control (editable) or the value text (read-only), then a
 * short hint and, for an environment value, the variable with a docs link. With `htmlFor` the
 * hint is `${htmlFor}-hint`: the control lists it in its `aria-describedby`.
 */
export function SettingRow({
  label,
  hint,
  source,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string | undefined;
  source?: SettingSource | EnvSource | undefined;
  children: ReactNode;
  htmlFor?: string | undefined;
}) {
  const own = useId();
  const { tag, line } = sourceParts(source);
  const hintId = htmlFor ? `${htmlFor}-hint` : `${own}-hint`;
  return (
    <div className="setting-row">
      <SettingHead tag={tag}>
        {htmlFor ? (
          <label className="setting-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="setting-label">{label}</span>
        )}
      </SettingHead>
      <div className="setting-control">{children}</div>
      {hint ? (
        <p id={hintId} className="setting-hint">
          {hint}
        </p>
      ) : null}
      {line}
    </div>
  );
}

/**
 * A row whose control is a group (radio buttons): the same layout as SettingRow, with the label
 * as the fieldset's legend and the hint as the group's description. `after` follows the hint (a
 * warning about the current choice).
 */
export function SettingFieldset({
  label,
  hint,
  source,
  after,
  stackOnPhone = false,
  children,
}: {
  label: string;
  hint?: string | undefined;
  source?: SettingSource | EnvSource | undefined;
  after?: ReactNode;
  /** One choice per line on a phone (long labels such as a GPU's name). */
  stackOnPhone?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const { tag, line } = sourceParts(source);
  return (
    <fieldset
      className="setting-row setting-fieldset"
      aria-describedby={hint ? `${id}-hint` : undefined}
    >
      <legend className="setting-label">{label}</legend>
      {tag ? <span className="setting-tag">{tag}</span> : null}
      <div
        className={
          stackOnPhone
            ? 'setting-control setting-radios setting-radios-stack'
            : 'setting-control setting-radios'
        }
      >
        {children}
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="setting-hint">
          {hint}
        </p>
      ) : null}
      {after}
      {line}
    </fieldset>
  );
}

/** A titled group of rows inside a section ("Queue", "Encoding"), under a group label. */
export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="settings-group" aria-labelledby={id}>
      <GroupLabel id={id}>{title}</GroupLabel>
      {children}
    </section>
  );
}

/**
 * The read-only values a section shows (environment variables, built-in values): always last,
 * closed until asked for, so they never read as something to edit here.
 */
export function ServerValues({ children }: { children: ReactNode }) {
  return (
    <Disclosure
      title="Set on the server"
      meta="Read-only"
      className="settings-advanced settings-server"
    >
      {children}
    </Disclosure>
  );
}
