import { describe, expect, it } from 'vitest';
import { branchPortLabel, branchWord, portShown } from './ports.ts';

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

describe('portShown', () => {
  it('portShown: no shownWhen → shown; equals true with qualityCheck true → shown; false or missing → hidden; non-object settings → hidden', () => {
    const plain = { id: 'file' };
    const damaged = { id: 'damaged', shownWhen: { setting: 'qualityCheck', equals: true } };
    expect(portShown(plain, {})).toBe(true);
    expect(portShown(plain, null)).toBe(true);
    expect(portShown(damaged, { qualityCheck: true })).toBe(true);
    expect(portShown(damaged, { qualityCheck: false })).toBe(false);
    expect(portShown(damaged, {})).toBe(false);
    expect(portShown(damaged, null)).toBe(false);
    expect(portShown(damaged, [true])).toBe(false);
    expect(portShown(damaged, 'qualityCheck')).toBe(false);
  });

  it('compares the setting by value, not identity', () => {
    const port = { id: 'x', shownWhen: { setting: 'mode', equals: { kind: ['a', 'b'] } } };
    expect(portShown(port, { mode: { kind: ['a', 'b'] } })).toBe(true);
    expect(portShown(port, { mode: { kind: ['b', 'a'] } })).toBe(false);
    expect(portShown(port, { mode: { kind: ['a', 'b'], extra: 1 } })).toBe(false);
  });
});
