import { describe, expect, it } from 'vitest';
import { fmtDate } from '../lib/time.ts';
import { deletesText } from './deletes-text.ts';

const NOW = new Date('2026-11-10T12:00:00.000Z');

describe('deletesText', () => {
  it('says "Deletes on" for a date still to come, never "Deleted on"', () => {
    const at = '2026-11-15T09:00:00.000Z';
    expect(deletesText(at, NOW)).toBe(`Deletes on ${fmtDate(at)}`);
  });

  it('says "Deletes soon" once the date has passed and the file is still there', () => {
    expect(deletesText('2026-11-10T11:59:00.000Z', NOW)).toBe('Deletes soon');
    expect(deletesText(NOW.toISOString(), NOW)).toBe('Deletes soon');
  });
});
