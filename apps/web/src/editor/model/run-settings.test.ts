import { describe, expect, it } from 'vitest';
import { readRunSettings } from './run-settings.ts';

describe('readRunSettings', () => {
  it('reads the pinned sub-workflow, version and overrides', () => {
    expect(
      readRunSettings({ subworkflowId: 'w1', version: 3, overrides: { 'n1.crf': 20 } }),
    ).toEqual({ subworkflowId: 'w1', version: 3, overrides: { 'n1.crf': 20 } });
  });

  it('drops what is missing or malformed instead of failing', () => {
    expect(readRunSettings(null)).toEqual({ overrides: {} });
    expect(readRunSettings([])).toEqual({ overrides: {} });
    expect(readRunSettings({ subworkflowId: '', version: 0, overrides: [] })).toEqual({
      overrides: {},
    });
    expect(readRunSettings({ subworkflowId: 'w1', version: 1.5 })).toEqual({
      subworkflowId: 'w1',
      overrides: {},
    });
  });
});
