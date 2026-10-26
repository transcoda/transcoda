export type PluginServiceErrorCode =
  | 'not-found'
  | 'no-integration'
  | 'not-running'
  | 'settings-invalid'
  | 'invalid';

/** What the API layer maps to its error codes (PLUGIN_NOT_RUNNING, PLUGIN_SETTINGS_INVALID, ...). */
export class PluginServiceError extends Error {
  constructor(
    readonly code: PluginServiceErrorCode,
    message: string,
    readonly issues: Array<{ path: string; message: string; missing: boolean }> = [],
  ) {
    super(message);
    this.name = 'PluginServiceError';
  }
}
