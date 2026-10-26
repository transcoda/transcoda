/** A bitrate as every screen writes it: "640 kb/s", "13.7 Mb/s" (SI, like sizes). */
export function fmtKbps(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mb/s` : `${Math.round(kbps)} kb/s`;
}
