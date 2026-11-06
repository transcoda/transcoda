import { describe, expect, it } from 'vitest';
import {
  activatedByText,
  activateLabel,
  SYSTEM_UPGRADE,
  versionAuthor,
  versionLine,
} from './version-text.ts';

const me = { id: 'u1', username: 'jan' };

describe('version-text', () => {
  it('versionAuthor: my id gives "you", system:upgrade "automatic update", another user is "another user", never the raw id', () => {
    expect(versionAuthor('u1', me)).toBe('you');
    expect(versionAuthor(SYSTEM_UPGRADE, me)).toBe('automatic update');
    expect(versionAuthor('u2', me)).toBe('another user');
    expect(versionAuthor('u1', null)).toBe('another user');
  });

  it('activatedByText follows versionAuthor and maps system:migration to "the upgrade"', () => {
    expect(activatedByText('u1', me)).toBe('you');
    expect(activatedByText('u2', me)).toBe('another user');
    expect(activatedByText('system:migration', me)).toBe('the upgrade');
  });

  it('versionLine: one wording for who saved a version and when', () => {
    const now = new Date('2026-11-07T12:00:00.000Z');
    const at = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
    expect(
      versionLine({ version: 2, note: null, createdBy: 'u1', createdAt: at(2) }, me, now),
    ).toBe('v2 · saved by you 2 min ago');
    expect(
      versionLine(
        { version: 8, note: 'Layout only', createdBy: 'u2', createdAt: at(180) },
        me,
        now,
      ),
    ).toBe('v8 · Layout only · saved by another user 3 h ago');
    expect(
      versionLine({ version: 6, note: null, createdBy: SYSTEM_UPGRADE, createdAt: at(0) }, me, now),
    ).toBe('v6 · automatic update just now');
    expect(
      versionLine({ version: 1, note: null, createdBy: 'u1', createdAt: at(60 * 24 * 3) }, me, now),
    ).toMatch(/^v1 · saved by you on /);
  });

  it('activateLabel: "Roll back" below the active version, "Activate" otherwise', () => {
    const active = { version: 3, runnable: true, activatedAt: '', activatedBy: 'u1' };
    expect(activateLabel(active, 1)).toBe('Roll back to v1');
    expect(activateLabel(active, 4)).toBe('Activate v4');
    expect(activateLabel(null, 1)).toBe('Activate v1');
  });
});
