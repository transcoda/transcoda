// Byte sizes and savings as every screen prints them: SI units (1 kB = 1000 B) with three
// significant digits ("2.41 GB", "12.3 GB", "790 MB", "1.25 MB"), whole bytes below 1 kB.

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'] as const;

export function fmtBytes(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  let i = abs < 1000 ? 0 : Math.min(Math.floor(Math.log10(abs) / 3), UNITS.length - 1);
  for (;;) {
    const value = abs / 1000 ** i;
    const decimals = i === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
    const text = value.toFixed(decimals);
    // Rounding can reach 1000 ("1000 kB", "1000.00 GB"): print the next unit instead.
    if (Number(text) >= 1000 && i < UNITS.length - 1) {
      i++;
      continue;
    }
    return `${sign}${text} ${UNITS[i]}`;
  }
}

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
