import { describe, expect, it } from 'vitest';
import type { FieldSpec } from './schema-fields.ts';
import { humanise, numberText } from './value-text.ts';

describe('humanise', () => {
  it('core option ids read as plain names', () => {
    expect(humanise('hevc')).toBe('HEVC (H.265)');
    expect(humanise('reencode')).toBe('Re-encode');
    expect(humanise('stereo')).toBe('Stereo');
    expect(humanise('already-target-codec')).toBe('Already target codec');
    // A plugin's own single-word ids stay as stored.
    expect(humanise('POST')).toBe('POST');
  });
});

describe('numberText', () => {
  const percent: FieldSpec = { kind: 'number', integer: false, slider: true, step: 1 };

  it('shows a fraction on its step and leaves integers and other kinds as stored', () => {
    expect(numberText(percent, 11.58)).toBe('12');
    expect(numberText({ kind: 'number', integer: true, slider: false }, 24)).toBe('24');
    expect(numberText({ kind: 'number', integer: false, slider: false }, 0.125)).toBe('0.125');
  });

  it('is empty for a value that is not a number', () => {
    expect(numberText(percent, undefined)).toBe('');
    expect(numberText(percent, '12')).toBe('');
  });
});
