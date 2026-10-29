import { useId } from 'react';
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
import { SettingRow, shownSource } from './SettingRow.tsx';

interface RecycleDraft extends Draft {
  retentionDays: string | number;
  maxFreePercent: string | number;
}

const RETENTION = { min: 0, max: 3650 } as const;
const SHARE = { min: 0, max: 100 } as const;

function check(d: RecycleDraft): Issues<RecycleDraft> {
  const out: Issues<RecycleDraft> = {};
  const days = wholeNumberIssue(d.retentionDays, RETENTION.min, RETENTION.max);
  const share = wholeNumberIssue(d.maxFreePercent, SHARE.min, SHARE.max);
  if (days) out.retentionDays = days;
  if (share) out.maxFreePercent = share;
  return out;
}

const files = (n: number) => (n === 1 ? '1 file' : `${n} files`);

/** Recycle: how long recycled originals are kept and how much free space they may take. */
export function RecycleSection() {
  const id = useId();
  const form = useSettingsForm<RecycleDraft>({
    draftOf: (s) => ({
      retentionDays: s.recycle.retentionDays.value,
      maxFreePercent: s.recycle.maxFreePercent.value,
    }),
    inputOf: (d) => ({
      recycleRetentionDays: Number(d.retentionDays),
      recycleMaxFreePercent: Number(d.maxFreePercent),
    }),
    check,
    fieldOf: { recycleRetentionDays: 'retentionDays', recycleMaxFreePercent: 'maxFreePercent' },
  });
  const { settings, draft } = form;
  if (!settings || !draft) return <SectionStatus loaded={false} error={form.loadError} />;
  const { recycle } = settings;

  return (
    <form
      className="settings-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.save();
      }}
    >
      <SettingRow label="Recycled originals now" hint="Checked at start and every 10 minutes">
        <span className="recycle-usage-value">
          {`${fmtBytes(recycle.usage.bytes)} in ${files(recycle.usage.files)}`}
        </span>
      </SettingRow>
      <SettingRow
        label="Retention"
        hint="0 removes recycled originals at the next check"
        source={shownSource(recycle.retentionDays)}
        htmlFor={`${id}-days`}
      >
        <NumberField
          id={`${id}-days`}
          value={draft.retentionDays}
          {...RETENTION}
          unit="days"
          hinted
          issue={form.issues.retentionDays}
          onChange={(v) => form.setField('retentionDays', v)}
        />
      </SettingRow>
      <SettingRow
        label="Maximum share of free space"
        hint="Older recycled originals are removed first when they take more"
        source={shownSource(recycle.maxFreePercent)}
        htmlFor={`${id}-share`}
      >
        <NumberField
          id={`${id}-share`}
          value={draft.maxFreePercent}
          {...SHARE}
          unit="%"
          hinted
          issue={form.issues.maxFreePercent}
          onChange={(v) => form.setField('maxFreePercent', v)}
        />
      </SettingRow>
      <FormError message={form.formError} />
      <SaveRow reason={null} disabled={!form.dirty} busy={form.busy} />
    </form>
  );
}
