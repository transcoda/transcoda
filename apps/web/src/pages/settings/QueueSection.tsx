import { TEST_ENCODE_KEEP_HOURS_MAX } from '@transcoda/contract';
import { useId, useState } from 'react';
import { api } from '../../api/client.ts';
import { Disclosure } from '../../components/Disclosure.tsx';
import { useToast } from '../../components/Toast.tsx';
import { QUEUE_PAUSED_TEXT } from '../../jobs/QueueBar.tsx';
import { useQueue } from '../../jobs/useQueue.ts';
import { fmtBytes } from '../../lib/bytes.ts';
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
import { ServerValues, SettingFieldset, SettingRow, SettingsGroup } from './SettingRow.tsx';
import { useSettings } from './useSettings.ts';

const hours = (n: number) => `${n} ${n === 1 ? 'hour' : 'hours'}`;

/** The pause switch: applies at once (no Save), the same call as the Jobs page's Pause queue. */
function PausedSwitch() {
  const id = useId();
  const toast = useToast();
  const queue = useQueue();
  const [busy, setBusy] = useState(false);
  const paused = queue.status?.paused ?? false;

  async function toggle() {
    setBusy(true);
    try {
      const next = paused ? await api.queue.resume() : await api.queue.pause();
      queue.set({ paused: next.paused, lanes: next.lanes, encodeSlots: next.encodeSlots });
    } catch {
      toast.error(paused ? "Couldn't resume the queue" : "Couldn't pause the queue");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setting-row">
      <div className="setting-switch-row">
        <span id={id} className="setting-label">
          Queue paused
        </span>
        <span className="setting-tag">Set here</span>
        <button
          type="button"
          role="switch"
          className="tc-switch"
          aria-checked={paused}
          aria-labelledby={id}
          aria-describedby={`${id}-hint`}
          disabled={queue.status === null || busy}
          onClick={() => void toggle()}
        >
          <span className="tc-switch-knob" />
        </button>
      </div>
      <p id={`${id}-hint`} className="setting-hint">
        {paused ? QUEUE_PAUSED_TEXT : 'Applies at once, like Pause queue on the Jobs page'}
      </p>
    </div>
  );
}

interface EngineDraft extends Draft {
  encodeDevice: string;
  testEncodeKeepHours: string | number;
}

const KEEP = { min: 0, max: TEST_ENCODE_KEEP_HOURS_MAX } as const;

function checkEngine(d: EngineDraft): Issues<EngineDraft> {
  const issue = wholeNumberIssue(d.testEncodeKeepHours, KEEP.min, KEEP.max);
  return issue ? { testEncodeKeepHours: issue } : {};
}

/**
 * The saved engine settings, one Save: "Encoding device" (applies to jobs prepared after saving)
 * and "Test encodes kept for" (applies to test encodes kept from then on).
 */
function EngineForm() {
  const id = useId();
  const form = useSettingsForm<EngineDraft>({
    draftOf: (s) => ({
      encodeDevice: s.queue.encodeDevice.value,
      testEncodeKeepHours: s.queue.testEncodeKeepHours.value,
    }),
    inputOf: (d) => ({
      encodeDevice: d.encodeDevice,
      testEncodeKeepHours: Number(d.testEncodeKeepHours),
    }),
    check: checkEngine,
    fieldOf: { encodeDevice: 'encodeDevice', testEncodeKeepHours: 'testEncodeKeepHours' },
  });
  const { settings, draft } = form;
  if (!settings || !draft) return null;
  const { queue } = settings;
  const missing = queue.encodeDevices.find((d) => d.missing && d.id === queue.encodeDevice.value);

  const keep = draft.testEncodeKeepHours;
  const keepChanged = String(keep).trim() !== String(queue.testEncodeKeepHours.default);

  return (
    <form
      className="settings-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.save();
      }}
    >
      <SettingFieldset
        label="Encoding device"
        hint="Where video is decoded and encoded. Auto uses a GPU when there is one. CPU only never uses a GPU."
        source={queue.encodeDevice.source}
        after={
          missing ? (
            <p role="alert" className="alert alert-warning">
              {`${missing.label.replace(/ \(.*$/, '')} was not found when the server started. Jobs encode on the CPU until you pick another device.`}
            </p>
          ) : null
        }
      >
        {queue.encodeDevices.map((d) => (
          <label key={d.id} className="setting-radio">
            <input
              className="setting-radio-input"
              type="radio"
              name={`${id}-device`}
              value={d.id}
              checked={draft.encodeDevice === d.id}
              onChange={() => form.setField('encodeDevice', d.id)}
            />
            {d.label}
          </label>
        ))}
      </SettingFieldset>
      {/* Rarely changed: closed unless it has a problem to show. */}
      <Disclosure
        title="Advanced"
        className="settings-advanced"
        meta={keepChanged ? '1 changed' : null}
        reveal={form.issues.testEncodeKeepHours !== undefined}
      >
        <SettingRow
          label="Test encodes kept for"
          hint="Outputs of test-encode dry runs, kept for playing and download. 0 deletes them after measuring."
          source={queue.testEncodeKeepHours.source}
          htmlFor={`${id}-keep`}
        >
          <NumberField
            id={`${id}-keep`}
            value={keep}
            {...KEEP}
            unit="hours"
            hinted
            issue={form.issues.testEncodeKeepHours}
            onChange={(v) => form.setField('testEncodeKeepHours', v)}
          />
        </SettingRow>
      </Disclosure>
      <FormError message={form.formError} />
      <SaveRow reason={form.dirty ? null : 'No changes to save'} busy={form.busy} />
    </form>
  );
}

/**
 * Queue and engine: the pause switch (applies at once); the encoding device with test-encode
 * keeping under Advanced (one Save); lanes and health thresholds read-only, last.
 */
export function QueueSection() {
  const { data, error } = useSettings();
  if (!data) return <SectionStatus loaded={false} error={error} />;
  const { queue } = data;
  const lanes = queue.lanes.map((l) => l.label).join(' and ');

  return (
    <>
      <SettingsGroup title="Queue">
        <PausedSwitch />
      </SettingsGroup>
      <SettingsGroup title="Encoding">
        <EngineForm />
      </SettingsGroup>
      <ServerValues>
        <SettingRow label="Lanes" source={{ kind: 'built-in' }}>
          {`${lanes}, one job each`}
        </SettingRow>
        <SettingRow
          label="Stall warning"
          hint="A running job without an update for this long fails the deep health check"
          source={{ kind: 'env', variable: queue.stallHours.variable, set: queue.stallHours.set }}
        >
          {hours(queue.stallHours.value)}
        </SettingRow>
        <SettingRow
          label="Minimum free space"
          hint="The deep health check needs this much free space in the transcode folder"
          source={{ kind: 'env', variable: queue.minFreeGib.variable, set: queue.minFreeGib.set }}
        >
          {/* SI like every other size; the variable itself is set in GiB. */}
          {`${fmtBytes(queue.minFreeGib.value * 2 ** 30)} (${queue.minFreeGib.value} GiB)`}
        </SettingRow>
      </ServerValues>
    </>
  );
}
