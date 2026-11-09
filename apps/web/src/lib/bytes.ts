// Byte sizes and savings as every screen prints them: SI units (1 kB = 1000 B) with three
// significant digits ("2.41 GB", "12.3 GB", "790 MB", "1.25 MB"), whole bytes below 1 kB. The
// formatter itself lives in @transcoda/shared, so the server's reasons and messages print sizes the
// same way.

import { fmtBytes } from '@transcoda/shared';

export { fmtBytes };

/** "saved 790 MB" | "grew by 12 MB" */
export function fmtSaving(before: number, after: number): string {
  const saved = before - after;
  return saved >= 0 ? `saved ${fmtBytes(saved)}` : `grew by ${fmtBytes(-saved)}`;
}

/** The size change as a whole percentage: "−33%" (U+2212 minus), "+4%", "0%"; "—" without a size. */
export function fmtPercent(before: number, after: number): string {
  if (!(before > 0)) return '—';
  const pct = Math.round(((after - before) / before) * 100);
  if (pct === 0) return '0%';
  return pct < 0 ? `−${-pct}%` : `+${pct}%`;
}
