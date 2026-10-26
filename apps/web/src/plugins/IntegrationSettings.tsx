import type { PluginDetail, PluginSettingsGetOutput, PluginTestOutput } from '@transcoda/contract';
import type { JsonValue } from '@transcoda/shared';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { api, safe } from '../api/client.ts';
import { describeError } from '../api/errors.ts';
import { Disclosure } from '../components/Disclosure.tsx';
import { DisabledReason } from '../components/Form.tsx';
import { Icon } from '../components/Icon.tsx';
import { Loading } from '../components/Loading.tsx';
import { useToast } from '../components/Toast.tsx';
import {
  clientIssue,
  differsFromDefault,
  type FieldDef,
  fieldsFor,
  isAdvancedPluginSetting,
} from '../editor/model/schema-fields.ts';
import { Field } from '../editor/ui/fields/Field.tsx';
import { SettingField } from '../editor/ui/fields/SettingField.tsx';
import { isNotRunning, pluginFailure, settingsIssuesOf } from './errors.ts';
import { PathMappingsField } from './PathMappingsField.tsx';
import { testSentence } from './pluginText.ts';

type Values = Record<string, JsonValue | undefined>;

const isObject = (v: JsonValue | undefined): v is { [key: string]: JsonValue } =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** A secret the server holds: it reads back as `{ set: true }` and is never a string. */
const isSetMarker = (v: JsonValue | undefined) => isObject(v) && v.set === true;

function valuesOf(settings: JsonValue): Values {
  return isObject(settings) ? { ...settings } : {};
}

/**
 * What goes to the server: every value that is set, except a stored secret nobody typed over
 * (left out, which keeps it).
 */
export function payloadOf(values: Values): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || isSetMarker(value)) continue;
    out[key] = value;
  }
  return out;
}

/** Deep equality of JSON values; object key order does not matter. */
function sameJson(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => sameJson(x, b[i] as JsonValue))
    );
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && sameJson(a[k] as JsonValue, b[k] as JsonValue))
    );
  }
  return false;
}

/**
 * True when the payload differs from what the server holds (deep, key-order independent). A
 * stored secret counts only when typed over: its `{ set: true }` marker is dropped from both sides.
 */
export function settingsDirty(values: Values, saved: JsonValue): boolean {
  return !sameJson(payloadOf(values), payloadOf(valuesOf(saved)));
}

/** The test line: the plugin's message, plus the version only when the message doesn't contain it. */
export function testResultText(result: PluginTestOutput): {
  message: string;
  version: string | null;
} {
  const version = result.ok && result.version ? result.version : null;
  return {
    message: result.message,
    version: version && !result.message.includes(version) ? version : null,
  };
}

/** The answer of the test just run (announced); a failure says what it costs. */
function TestResult({ result, effect }: { result: PluginTestOutput; effect: string | null }) {
  const text = testResultText(result);
  return (
    <div
      role="status"
      className={result.ok ? 'plugin-test-result is-ok' : 'plugin-test-result is-fail'}
    >
      <Icon name={result.ok ? 'check' : 'cross'} size={16} strokeWidth={2.4} round />
      <div>
        <span className="plugin-test-line">
          <span>{text.message}</span>
          {text.version ? <span className="mono">{text.version}</span> : null}
        </span>
        {!result.ok && effect ? <span className="plugin-test-effect">{effect}</span> : null}
        {result.ok && result.warnings && result.warnings.length > 0 ? (
          <ul className="plugin-test-warnings" aria-label="Warnings">
            {result.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/** What a stored secret shows instead of an input: never the value, at most its last four. */
export function storedSecretText(marker: JsonValue | undefined): string {
  const end = isObject(marker) && typeof marker.endsWith === 'string' ? marker.endsWith : null;
  return end ? `Stored, ends in ${end}` : 'Stored';
}

/** A secret the server holds: "Stored, ends in 4f2a" and Replace, which swaps in an empty input. */
function StoredSecret({
  def,
  value,
  onReplace,
}: {
  def: FieldDef;
  value: JsonValue | undefined;
  onReplace(): void;
}) {
  return (
    <Field
      def={def}
      value={value}
      onChange={() => {}}
      issue={null}
      readOnly
      clearable={false}
      notSet={null}
    >
      {(ids) => (
        <div className="plugin-secret">
          <input
            id={ids.id}
            className="input tc-input plugin-secret-stored"
            readOnly
            value={storedSecretText(value)}
            aria-describedby={ids.describedBy}
          />
          <button
            type="button"
            className="btn btn-secondary"
            aria-label={`Replace ${def.label}`}
            onClick={onReplace}
          >
            Replace
          </button>
        </div>
      )}
    </Field>
  );
}

/**
 * The generated settings form of a plugin's integration (its settings schema → fields). Secrets
 * never come back from the server: a stored one shows "Stored, ends in 4f2a" with Replace, and is
 * left out of the payload unless typed over. "Save and test" saves, then tests what was saved;
 * `actions` (the plugin's own buttons) close the button row.
 */
export function IntegrationSettings({
  name,
  title = name,
  effect = null,
  actions,
  onTested,
}: {
  name: string;
  /** The plugin's display name, for the button labels. */
  title?: string;
  /** What a failed connection costs ("Files are still replaced; …"); null: say nothing. */
  effect?: string | null;
  actions?: ReactNode;
  /** A test ran (its result is stored): the list's status badge may change. */
  onTested?(): void;
}) {
  const toast = useToast();
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [saved, setSaved] = useState<PluginSettingsGetOutput | null>(null);
  const [values, setValues] = useState<Values>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<PluginTestOutput | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  /** Stored secrets whose Replace was pressed: they show an input instead of "Stored". */
  const [replacing, setReplacing] = useState<ReadonlySet<string>>(new Set());
  const reasonId = useId();

  useEffect(() => {
    let live = true;
    setLoadError(null);
    void Promise.all([
      safe(api.plugins.get({ name })),
      safe(api.plugins.settingsGet({ name })),
    ]).then(([[detailErr, d], [settingsErr, s]]) => {
      if (!live) return;
      if (detailErr || settingsErr || !d || !s) {
        setLoadError(describeError(detailErr ?? settingsErr).message);
        return;
      }
      setDetail(d);
      setSaved(s);
      setValues(valuesOf(s.settings));
    });
    return () => {
      live = false;
    };
  }, [name]);

  const fields = useMemo(
    () => (detail?.integration ? fieldsFor(detail.integration.settingsSchema) : []),
    [detail],
  );

  function change(key: string, value: JsonValue | undefined) {
    // Emptying a secret the server holds goes back to "saved": the stored value is kept.
    const held = saved?.settings;
    const marker = isObject(held) ? held[key] : undefined;
    const next = value === undefined && isSetMarker(marker) ? marker : value;
    setValues((v) => ({ ...v, [key]: next }));
    setIssues(({ [key]: _, ...rest }) => rest);
    setTestResult(null);
  }

  /** The client's own check (required, bounds) before asking the server. */
  function check(): boolean {
    const found: Record<string, string> = {};
    for (const def of fields) {
      const message = clientIssue(def, values[def.key]);
      if (message) found[def.key] = message;
    }
    setIssues(found);
    return Object.keys(found).length === 0;
  }

  function serverFailure(err: unknown) {
    const invalid = settingsIssuesOf(err);
    if (invalid) {
      setIssues(invalid);
      setFormError(null);
    } else if (isNotRunning(err)) {
      setFormError(`${name} is not running: ${pluginFailure(err)}`);
    } else setFormError(pluginFailure(err));
  }

  /** Saves, then tests what was saved (stored secrets travel as left out: the server's own). */
  async function saveAndTest() {
    if (busy || !dirty || !check()) return;
    setBusy('save');
    setFormError(null);
    setTestResult(null);
    const [err, out] = await safe(api.plugins.settingsSave({ name, settings: payloadOf(values) }));
    if (err || !out) {
      setBusy(null);
      return serverFailure(err);
    }
    setSaved(out);
    setValues(valuesOf(out.settings));
    setIssues({});
    setReplacing(new Set());
    toast.success('Settings saved');
    await runTest(payloadOf(valuesOf(out.settings)));
  }

  async function test() {
    if (busy || !check()) return;
    setTestResult(null);
    setFormError(null);
    await runTest(payloadOf(values));
  }

  async function runTest(settings: { [key: string]: JsonValue }) {
    setBusy('test');
    const [err, out] = await safe(api.plugins.settingsTest({ name, settings }));
    setBusy(null);
    if (err || !out) return serverFailure(err);
    setTestResult(out);
    onTested?.();
  }

  // Save only when the payload differs from what the server holds.
  const dirty = saved !== null && settingsDirty(values, saved.settings);

  // Without a form the plugin's own buttons still show: Remove must never depend on the settings.
  const withActions = (body: ReactNode) => (
    <div className="plugin-settings">
      {body}
      {actions ? <div className="plugin-settings-actions">{actions}</div> : null}
    </div>
  );
  if (loadError) {
    return withActions(
      <div className="alert alert-danger" role="alert">
        <Icon name="cross" strokeWidth={2.4} round />
        <span>{`Could not load the settings: ${loadError}`}</span>
      </div>,
    );
  }
  if (!detail || !saved) return withActions(<Loading inline label="Loading settings…" />);
  if (!detail.integration)
    return withActions(<p className="muted">This plugin has no settings.</p>);

  const lastTest = saved.lastTest;
  // Path mappings and insecure TLS sit under a closed "Advanced" (it opens for a problem there).
  const main = fields.filter((def) => !isAdvancedPluginSetting(def));
  const advanced = fields.filter(isAdvancedPluginSetting);
  const changed = advanced.filter((def) => differsFromDefault(def, values[def.key])).length;
  const control = (def: FieldDef) =>
    def.spec.kind === 'password' && isSetMarker(values[def.key]) && !replacing.has(def.key) ? (
      <StoredSecret
        key={def.key}
        def={def}
        value={values[def.key]}
        onReplace={() => setReplacing((r) => new Set(r).add(def.key))}
      />
    ) : def.spec.kind === 'path-mappings' ? (
      <PathMappingsField
        key={def.key}
        plugin={name}
        def={def}
        value={values[def.key]}
        onChange={(v) => change(def.key, v)}
        issue={issues[def.key] ?? null}
      />
    ) : (
      <SettingField
        key={def.key}
        def={def}
        value={values[def.key]}
        onChange={(v) => change(def.key, v)}
        issue={issues[def.key] ?? null}
        readOnly={false}
        autoFocus={replacing.has(def.key)}
      />
    );
  return (
    <form
      className="plugin-settings"
      aria-label={`Settings for ${name}`}
      onSubmit={(e) => {
        e.preventDefault();
        void saveAndTest();
      }}
    >
      {detail.integration.requires ? (
        <p className="field-hint">
          {`Works with ${detail.integration.requires.product} ${detail.integration.requires.minVersion} or newer.`}
        </p>
      ) : null}
      {saved.needsReview ? (
        <div className="alert alert-warning" role="status">
          <Icon name="alert" size={16} round />
          <span>{`Settings need review: ${saved.needsReview}`}</span>
        </div>
      ) : null}
      <div className="plugin-settings-fields">{main.map(control)}</div>
      {advanced.length > 0 ? (
        <Disclosure
          title="Advanced"
          className="plugin-advanced"
          meta={changed > 0 ? `${changed} changed` : null}
          reveal={advanced.some((def) => issues[def.key] !== undefined)}
        >
          <div className="plugin-settings-fields">{advanced.map(control)}</div>
        </Disclosure>
      ) : null}
      {issues[''] ? (
        <p className="tc-field-issue">
          <Icon name="alert" size={14} round />
          {issues['']}
        </p>
      ) : null}
      {formError ? (
        <div className="alert alert-danger" role="alert">
          <Icon name="cross" strokeWidth={2.4} round />
          <span>{formError}</span>
        </div>
      ) : null}
      {testResult ? (
        <TestResult result={testResult} effect={effect} />
      ) : lastTest ? (
        <div
          className={lastTest.result.ok ? 'plugin-test-result is-ok' : 'plugin-test-result is-fail'}
        >
          <Icon name={lastTest.result.ok ? 'check' : 'cross'} size={16} strokeWidth={2.4} round />
          <div>
            <span>{testSentence(lastTest, new Date())}</span>
            {!lastTest.result.ok && effect ? (
              <span className="plugin-test-effect">{effect}</span>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="plugin-settings-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy !== null || !dirty}
          {...(dirty ? {} : { 'aria-describedby': reasonId })}
        >
          Save and test
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          aria-label={`Test connection for ${title}`}
          disabled={busy !== null}
          onClick={() => void test()}
        >
          Test connection
        </button>
        {actions}
      </div>
      {dirty ? null : <DisabledReason id={reasonId}>No changes to save</DisabledReason>}
    </form>
  );
}
