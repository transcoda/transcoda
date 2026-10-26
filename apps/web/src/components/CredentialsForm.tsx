import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icon.tsx';

export interface CredentialsFormProps {
  title: string;
  /** Small caps label above the title (e.g. "First run"; the class sets the capitals). */
  eyebrow?: string;
  intro?: ReactNode;
  submitLabel: string;
  onSubmit(creds: { username: string; password: string }): Promise<void>;
  error?: string | null;
  /** 'danger' (default) for failures, 'warning' for "wait and retry" (rate limited). */
  errorTone?: 'danger' | 'warning';
  /** Mark the password field as wrong (after invalid credentials). */
  passwordInvalid?: boolean;
  /** Disable the fields and the button (rate limited). */
  locked?: boolean;
  minPasswordLength: number;
}

export function CredentialsForm(props: CredentialsFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [shortError, setShortError] = useState<string | null>(null);
  const id = useId();
  const userId = `${id}-user`;
  const passId = `${id}-pass`;
  const hintId = `${id}-pass-hint`;
  const passRef = useRef<HTMLInputElement>(null);
  const wasLocked = useRef(false);

  // When a rate-limit lock ends, put the cursor back in the password field.
  useEffect(() => {
    if (wasLocked.current && !props.locked) passRef.current?.focus();
    wasLocked.current = Boolean(props.locked);
  }, [props.locked]);

  // The live length hint is only shown where a minimum applies (setup).
  const showHint = props.minPasswordLength > 1;
  const tooShort = showHint && password.length > 0 && password.length < props.minPasswordLength;
  const lengthOk = showHint && password.length >= props.minPasswordLength;
  const passwordInvalid = Boolean(props.passwordInvalid) || tooShort;
  const tone = props.errorTone ?? 'danger';

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // A password under the minimum would only come back as a generic failure: say why here.
    if (showHint && password.length < props.minPasswordLength) {
      setShortError(`Use at least ${props.minPasswordLength} characters for the password.`);
      passRef.current?.focus();
      return;
    }
    setShortError(null);
    setPending(true);
    try {
      await props.onSubmit({ username: username.trim(), password });
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="credentials" onSubmit={handleSubmit}>
      <div className="credentials-head">
        {props.eyebrow ? <div className="eyebrow">{props.eyebrow}</div> : null}
        <h1>{props.title}</h1>
        {props.intro ? <p className="lead">{props.intro}</p> : null}
      </div>
      <div className="field">
        <label htmlFor={userId}>Username</label>
        <input
          id={userId}
          className="input"
          name="username"
          autoComplete="username"
          required
          maxLength={64}
          disabled={props.locked}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={passId}>Password</label>
        <input
          id={passId}
          ref={passRef}
          className="input"
          name="password"
          type="password"
          autoComplete={props.minPasswordLength > 1 ? 'new-password' : 'current-password'}
          required
          minLength={props.minPasswordLength}
          disabled={props.locked}
          aria-invalid={passwordInvalid || undefined}
          aria-describedby={showHint ? hintId : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {showHint ? (
          <div
            id={hintId}
            className={`length-hint${tooShort ? ' is-short' : ''}${lengthOk ? ' is-ok' : ''}`}
          >
            <div className="meter" aria-hidden="true">
              <div
                className="meter-fill"
                style={{
                  width: `${Math.min(100, (password.length / props.minPasswordLength) * 100)}%`,
                }}
              />
            </div>
            {lengthOk ? <Icon name="check" size={14} strokeWidth={2.6} /> : null}
            <span>
              {lengthOk
                ? `${props.minPasswordLength} characters minimum, met`
                : `${password.length} of ${props.minPasswordLength} characters minimum`}
            </span>
          </div>
        ) : null}
      </div>
      {shortError ? (
        <div className="alert alert-danger" role="alert">
          <Icon name="cross" strokeWidth={2.4} round />
          <span>{shortError}</span>
        </div>
      ) : props.error ? (
        <div className={`alert alert-${tone}`} role="alert">
          <Icon
            name={tone === 'warning' ? 'clock' : 'cross'}
            strokeWidth={tone === 'warning' ? 2.2 : 2.4}
            round
          />
          <span>{props.error}</span>
        </div>
      ) : null}
      <button type="submit" className="btn btn-primary btn-lg" disabled={pending || props.locked}>
        {props.submitLabel}
      </button>
    </form>
  );
}
