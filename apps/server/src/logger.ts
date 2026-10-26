export type LogFields = string | ({ msg: string } & Record<string, unknown>);

export interface Logger {
  info(entry: LogFields): void;
  warn(entry: LogFields): void;
  error(entry: LogFields): void;
}

const show = (v: unknown): string => {
  if (typeof v === 'string') return /[\s"]/.test(v) ? JSON.stringify(v) : v;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/** `msg key=value ...` for a terminal (values arrive already redacted, like the JSON form). */
function plain({ msg, ...fields }: { msg: string } & Record<string, unknown>): string {
  const rest = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${show(v)}`);
  return rest.length === 0 ? msg : `${msg} ${rest.join(' ')}`;
}

/** stdout/stderr logger: JSON lines in production, plain text otherwise. Callers must never pass secrets. */
export function createLogger(nodeEnv: string): Logger {
  const json = nodeEnv === 'production';
  const emit = (level: 'info' | 'warn' | 'error', entry: LogFields): void => {
    const sink = level === 'info' ? console.log : level === 'warn' ? console.warn : console.error;
    if (json) {
      const fields = typeof entry === 'string' ? { msg: entry } : entry;
      sink(JSON.stringify({ time: new Date().toISOString(), level, ...fields }));
    } else {
      sink(typeof entry === 'string' ? entry : plain(entry));
    }
  };
  return {
    info: (e) => emit('info', e),
    warn: (e) => emit('warn', e),
    error: (e) => emit('error', e),
  };
}
