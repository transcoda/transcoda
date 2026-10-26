import type { Settings } from '@transcoda/contract';
import { useId } from 'react';
import { GuardedLink } from '../../lib/navigation.tsx';
import {
  type Draft,
  FormError,
  type Issues,
  NumberField,
  SaveRow,
  SectionStatus,
  useSettingsForm,
  wholeNumberIssue,
} from './SectionForm.tsx';
import { ServerValues, SettingRow } from './SettingRow.tsx';

interface PluginsDraft extends Draft {
  /** Seconds in the form; stored as milliseconds. */
  callTimeout: string | number;
}

const TIMEOUT_S = { min: 1, max: 3600 } as const;

const seconds = (ms: number) => {
  const s = ms / 1000;
  return `${s} ${s === 1 ? 'second' : 'seconds'}`;
};

type Isolation = Settings['plugins']['isolation'];
const ISOLATION_TEXT: Record<Isolation['mode'], string> = {
  'separate-user': 'Separate user',
  'same-user': 'Same user',
  'not-required': 'Not required here',
};

const ISOLATION_HINT: Record<Isolation['mode'], string> = {
  'separate-user': "Plugins run as their own system user and cannot read the server's files",
  'same-user': "Plugins run as the server's user",
  'not-required': "Plugins run as the server's user; isolation is required in production on Linux",
};

function check(d: PluginsDraft): Issues<PluginsDraft> {
  const issue = wholeNumberIssue(d.callTimeout, TIMEOUT_S.min, TIMEOUT_S.max);
  return issue ? { callTimeout: issue } : {};
}

/** Plugins: the call timeout (applied to the next call); finish-step timeout, isolation read-only. */
export function PluginsSection() {
  const id = useId();
  const form = useSettingsForm<PluginsDraft>({
    draftOf: (s) => ({ callTimeout: s.plugins.callTimeoutMs.value / 1000 }),
    inputOf: (d) => ({ pluginCallTimeoutMs: Number(d.callTimeout) * 1000 }),
    check,
    fieldOf: { pluginCallTimeoutMs: 'callTimeout' },
  });
  const { settings, draft } = form;
  if (!settings || !draft) return <SectionStatus loaded={false} error={form.loadError} />;
  const { plugins } = settings;
  const isolation = plugins.isolation;

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
          label="Call timeout"
          hint="Applies to the next plugin call"
          source={plugins.callTimeoutMs.source}
          htmlFor={`${id}-timeout`}
        >
          <NumberField
            id={`${id}-timeout`}
            value={draft.callTimeout}
            {...TIMEOUT_S}
            unit="seconds"
            hinted
            issue={form.issues.callTimeout}
            onChange={(v) => form.setField('callTimeout', v)}
          />
        </SettingRow>
        <FormError message={form.formError} />
        <SaveRow reason={form.dirty ? null : 'No changes to save'} busy={form.busy} />
      </form>
      <p>
        <GuardedLink href="/plugins" className="setting-link">
          Catalogs are managed on the Plugins page
        </GuardedLink>
      </p>
      <ServerValues>
        <SettingRow label="Finish-step timeout" source={plugins.finishRunTimeoutMs.source}>
          {seconds(plugins.finishRunTimeoutMs.value)}
        </SettingRow>
        <SettingRow
          label="Isolation"
          hint={ISOLATION_HINT[isolation.mode]}
          source={{
            kind: 'env',
            variable: isolation.variable,
            set: isolation.mode === 'same-user',
          }}
        >
          {ISOLATION_TEXT[isolation.mode]}
        </SettingRow>
      </ServerValues>
    </>
  );
}
