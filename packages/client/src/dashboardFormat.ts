/** Formatting for the world dashboard. */

/** "0 B", "12.3 KB", "4.56 MB", "1.2 GB" (powers of 1024). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return u === 0 ? `${Math.round(n)} B` : `${n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : n.toFixed(0)} ${units[u]}`;
}

/** "45 s", "12 min", "3 h 05 min", "2 d 4 h". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, '0')} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** A rate with a sensible number of digits: "0", "0.4", "12", "1.2k". */
export function formatRate(n: number): string {
  if (!Number.isFinite(n)) return '–';
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 10) return n.toFixed(0);
  if (n >= 0.05) return n.toFixed(1);
  return '0';
}

/** Compass heading for a yaw (radians, 0 = -Z = north, counter-clockwise): "N", "NE", ... */
export function compass(yaw: number): string {
  // Yaw turns left (counter-clockwise seen from above); compass bearings turn right.
  const bearing = ((((-yaw * 180) / Math.PI) % 360) + 360) % 360;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(bearing / 45) % 8]!;
}

/**
 * A chart's vertical range: from 0 up to a round number at or above the largest value (at least
 * `floor`, so a quiet series doesn't fill the chart with noise).
 */
export function chartMax(values: readonly number[], floor: number): number {
  const max = Math.max(floor, ...values.filter(Number.isFinite));
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}
