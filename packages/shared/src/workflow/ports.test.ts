import { describe, expect, it } from 'vitest';
import { branchPortLabel, branchWord } from './ports.ts';

describe('branch port words', () => {
  it('words the stored ids pass and else as Yes and No, nothing else', () => {
    expect(branchWord('pass')).toBe('Yes');
    expect(branchWord('else')).toBe('No');
    expect(branchWord('file')).toBeNull();
    expect(branchWord('constructor')).toBeNull();
  });

  it('shows Yes/No for generic labels and keeps a plugin’s own words', () => {
    expect(branchPortLabel({ id: 'pass', label: 'Pass' })).toBe('Yes');
    expect(branchPortLabel({ id: 'else', label: 'Else' })).toBe('No');
    expect(branchPortLabel({ id: 'pass', label: 'Yes' })).toBe('Yes');
    expect(branchPortLabel({ id: 'else', label: 'else' })).toBe('No');
    expect(branchPortLabel({ id: 'pass', label: 'Matches' })).toBe('Matches');
    expect(branchPortLabel({ id: 'file', label: 'File' })).toBe('File');
    expect(branchPortLabel({ id: 'file', label: 'Pass' })).toBe('Pass');
  });
});
