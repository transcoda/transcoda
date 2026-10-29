import type { Settings, Theme } from '@transcoda/contract';
import { useEffect, useId, useRef } from 'react';
import { useAuth } from '../../auth/useAuth.ts';
import { applyTheme } from '../../lib/theme.ts';
import {
  type Draft,
  FieldIssue,
  FormError,
  SaveRow,
  SectionStatus,
  useSettingsForm,
} from './SectionForm.tsx';
import {
  ServerValues,
  SettingFieldset,
  SettingHead,
  SettingRow,
  shownSource,
} from './SettingRow.tsx';
import { sourceText } from './sourceText.ts';

interface GeneralDraft extends Draft {
  serverName: string | null;
  theme: Theme;
}

const THEMES: readonly { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

const nameOf = (v: string | null) => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

const appearanceOf = (s: Settings) => ({
  theme: s.general.theme.value,
  serverName: s.general.serverName.value,
});

/**
 * General: server name and theme (one Save; a theme choice previews at once and is put back when
 * the section is left unsaved or the save fails), public URL and allowed hosts read-only.
 */
export function GeneralSection() {
  const id = useId();
  const { setAppearance } = useAuth();
  const form = useSettingsForm<GeneralDraft>({
    draftOf: (s) => ({ serverName: s.general.serverName.value, theme: s.general.theme.value }),
    inputOf: (d) => ({ serverName: nameOf(d.serverName), theme: d.theme }),
    check: () => ({}),
    fieldOf: { serverName: 'serverName', theme: 'theme' },
    onSaved: (s) => {
      savedTheme.current = s.general.theme.value;
      setAppearance(appearanceOf(s));
    },
    onFailed: () => {
      const theme = savedTheme.current;
      if (theme === null) return;
      applyTheme(theme, { cache: false });
      form.setField('theme', theme);
    },
  });
  const { settings, draft } = form;

  // The theme the server holds; leaving with a different one previewed puts this one back.
  const savedTheme = useRef<Theme | null>(null);
  const shownTheme = useRef<Theme | null>(null);
  const serverTheme = settings?.general.theme.value ?? null;
  if (serverTheme !== null) savedTheme.current = serverTheme;
  shownTheme.current = draft?.theme ?? null;
  useEffect(
    () => () => {
      const saved = savedTheme.current;
      if (saved !== null && shownTheme.current !== saved) applyTheme(saved, { cache: false });
    },
    [],
  );

  if (!settings || !draft) return <SectionStatus loaded={false} error={form.loadError} />;
  const { general } = settings;
  const nameIssue = form.issues.serverName;
  const builtIn = general.allowedHosts.filter((h) => h.source.kind === 'built-in').length;

  return (
    <>
      <form
        className="settings-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void form.save();
        }}
      >
        <SettingRow
          label="Server name"
          hint="Shown in the top bar and the browser tab. Leave empty for none."
          source={shownSource(general.serverName)}
          htmlFor={`${id}-name`}
        >
          <input
            id={`${id}-name`}
            className="input setting-text"
            maxLength={64}
            placeholder="Transcoda"
            autoComplete="off"
            value={draft.serverName ?? ''}
            aria-invalid={nameIssue ? true : undefined}
            aria-describedby={nameIssue ? `${id}-name-hint ${id}-name-issue` : `${id}-name-hint`}
            onChange={(e) => form.setField('serverName', e.target.value)}
          />
          {nameIssue ? <FieldIssue id={`${id}-name-issue`}>{nameIssue}</FieldIssue> : null}
        </SettingRow>
        <SettingFieldset
          label="Theme"
          hint="For everyone who uses this server"
          source={shownSource(general.theme)}
        >
          {THEMES.map((t) => (
            <label key={t.value} className="setting-radio">
              <input
                className="setting-radio-input"
                type="radio"
                name={`${id}-theme`}
                value={t.value}
                checked={draft.theme === t.value}
                onChange={() => {
                  applyTheme(t.value, { cache: false });
                  form.setField('theme', t.value);
                }}
              />
              {t.label}
            </label>
          ))}
        </SettingFieldset>
        <FormError message={form.formError} />
        <SaveRow reason={null} disabled={!form.dirty} busy={form.busy} />
      </form>
      {/* Below the form and its Save: what this page shows but the server's environment sets. */}
      <ServerValues>
        <SettingRow
          label="Public URL"
          hint="The address links in notifications point to"
          source={{ kind: 'env', variable: general.publicUrl.variable, set: general.publicUrl.set }}
        >
          {general.publicUrl.value ? (
            <span className="mono">{general.publicUrl.value}</span>
          ) : (
            'Not set: notifications carry no link'
          )}
        </SettingRow>
        <div className="setting-row">
          <SettingHead>
            <span className="setting-label" id={`${id}-hosts`}>
              Allowed hosts
            </span>
          </SettingHead>
          <ul className="setting-hosts" aria-labelledby={`${id}-hosts`}>
            {general.allowedHosts.map((h) => (
              <li key={h.host}>
                <span className="mono">{h.host}</span>
                {/* "Built in" is said once, under the list; another source is said per host. */}
                {h.source.kind === 'built-in' ? null : (
                  <span className="setting-source">{sourceText(h.source)}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="setting-hint">Names this server answers to in the browser</p>
          {builtIn === 0 ? null : (
            <p className="setting-source">
              {builtIn === general.allowedHosts.length ? 'Built in' : 'The others are built in'}
            </p>
          )}
        </div>
      </ServerValues>
    </>
  );
}
