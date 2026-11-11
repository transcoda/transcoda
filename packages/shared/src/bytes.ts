// Byte sizes as every screen, reason and message prints them: SI units (1 kB = 1000 B) with three
// significant digits ("2.41 GB", "12.3 GB", "790 MB", "1.25 MB"), whole bytes below 1 kB.

/** One SI gigabyte (10^9 bytes): the unit sizes are typed in (Settings, environment variables). */
export const GB = 1_000_000_000;
/** One SI megabyte (10^6 bytes). */
export const MB = 1_000_000;

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
