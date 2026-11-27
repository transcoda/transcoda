import type { SettingSource } from '@transcoda/contract';

/** docs/env.md on GitHub; each variable links to the section of its table. */
const ENV_DOCS = 'https://github.com/transcoda/transcoda/blob/main/docs/env.md';

/** Where a value comes from, in words. */
export function sourceText(source: SettingSource): string {
  switch (source.kind) {
    case 'database':
      return 'Set here';
    case 'default':
      return 'Default';
    case 'env':
      return `From ${source.variable}`;
    case 'setup':
      return 'Recorded at setup';
    case 'built-in':
      return 'Built in';
  }
}

/** An environment value: "From X" when the variable is set, else the default and how to change it. */
export function envSourceText(variable: string, set: boolean): string {
  return set ? `From ${variable}` : `Default · set ${variable} to change`;
}

/** The docs/env.md section that describes `variable` (plugin variables have their own table). */
export function envDocsUrl(variable: string): string {
  return `${ENV_DOCS}#${variable.startsWith('TRANSCODA_PLUGIN') ? 'plugins' : 'server'}`;
}
