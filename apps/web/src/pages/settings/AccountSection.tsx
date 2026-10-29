import { ORPCError } from '@orpc/client';
import { useId, useState } from 'react';
import { api } from '../../api/client.ts';
import { describeError } from '../../api/errors.ts';
import { useToast } from '../../components/Toast.tsx';
import { FieldIssue, FormError, SaveRow } from './SectionForm.tsx';
import { SettingRow } from './SettingRow.tsx';

/** The setup rule (`CredentialsSchema.password`): 12 to 1024 characters. */
const MIN_PASSWORD = 12;

/** All three fields have something in them (until then the button is off without a reason). */
export function passwordFilled(current: string, next: string, repeat: string): boolean {
  return current !== '' && next !== '' && repeat !== '';
}

/**
 * Why the filled-in form cannot be sent yet, or null when it is ready. Empty fields need no
 * reason (convention 12): the button stays off until they are filled.
 */
export function passwordReason(current: string, next: string, repeat: string): string | null {
  if (!passwordFilled(current, next, repeat)) return null;
  if (next.length < MIN_PASSWORD) {
    return `The new password needs at least ${MIN_PASSWORD} characters`;
  }
  if (next !== repeat) return "The new passwords don't match";
  return null;
}

/** The server's message; a rate limit also says when to try again. */
function failureText(err: unknown): string {
  const message = describeError(err).message;
  if (!(err instanceof ORPCError) || err.code !== 'RATE_LIMITED') return message;
  const data: unknown = err.data;
  const wait =
    typeof data === 'object' && data !== null && 'retryAfterSeconds' in data
      ? Number(data.retryAfterSeconds)
      : Number.NaN;
  return Number.isFinite(wait) && wait > 0
    ? `${message}. Try again in ${Math.ceil(wait)} seconds.`
    : message;
}

function PasswordField({
  id,
  label,
  value,
  autoComplete,
  issue,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  autoComplete: 'current-password' | 'new-password';
  issue?: string | null | undefined;
  hint?: string | undefined;
  onChange(v: string): void;
}) {
  const described = [issue ? `${id}-issue` : null, hint ? `${id}-hint` : null].filter(Boolean);
  return (
    // The settings row: label, input (its problem under it), then the hint (`${id}-hint`).
    <SettingRow label={label} hint={hint} htmlFor={id}>
      <input
        id={id}
        className="input setting-text"
        type="password"
        autoComplete={autoComplete}
        maxLength={1024}
        value={value}
        aria-invalid={issue ? true : undefined}
        aria-describedby={described.length > 0 ? described.join(' ') : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {issue ? <FieldIssue id={`${id}-issue`}>{issue}</FieldIssue> : null}
    </SettingRow>
  );
}

/** Account: change the signed-in person's password; their other browser sessions are signed out. */
export function AccountSection() {
  const id = useId();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [currentIssue, setCurrentIssue] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const filled = passwordFilled(current, next, repeat);
  const reason = passwordReason(current, next, repeat);

  async function save() {
    if (busy || !filled || reason !== null) return;
    setBusy(true);
    setCurrentIssue(null);
    setFormError(null);
    try {
      await api.auth.changePassword({ currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setRepeat('');
      toast.success('Password changed. Other sessions were signed out.');
    } catch (err) {
      if (err instanceof ORPCError && err.code === 'INVALID_CREDENTIALS') {
        setCurrentIssue(err.message);
      } else setFormError(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="settings-form account-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <PasswordField
        id={`${id}-current`}
        label="Current password"
        value={current}
        autoComplete="current-password"
        issue={currentIssue}
        onChange={(v) => {
          setCurrent(v);
          setCurrentIssue(null);
        }}
      />
      <PasswordField
        id={`${id}-new`}
        label="New password"
        value={next}
        autoComplete="new-password"
        hint={`At least ${MIN_PASSWORD} characters`}
        onChange={setNext}
      />
      <PasswordField
        id={`${id}-repeat`}
        label="Repeat new password"
        value={repeat}
        autoComplete="new-password"
        onChange={setRepeat}
      />
      <FormError message={formError} />
      <SaveRow reason={reason} disabled={!filled} busy={busy} label="Change password" />
    </form>
  );
}
