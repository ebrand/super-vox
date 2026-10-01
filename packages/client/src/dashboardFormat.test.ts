import { describe, expect, it } from 'vitest';
import { chartMax, compass, formatBytes, formatDuration, formatRate } from './dashboardFormat.js';

describe('dashboard formatting', () => {
  it('formats bytes, durations and rates', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1500)).toBe('1.46 KB');
    expect(formatBytes(50 * 2 ** 20)).toBe('50.0 MB');
    expect(formatBytes(-1)).toBe('–');
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(12 * 60_000)).toBe('12 min');
    expect(formatDuration(3 * 3_600_000 + 5 * 60_000)).toBe('3 h 05 min');
    expect(formatDuration(52 * 3_600_000)).toBe('2 d 4 h');
    expect([0.01, 0.4, 12.4, 1234, 25_000].map(formatRate)).toEqual(['0', '0.4', '12', '1.2k', '25k']);
  });

  it('turns a yaw into a compass heading', () => {
    // Yaw 0 faces -Z (north); it turns counter-clockwise, so +pi/2 faces west.
    expect(compass(0)).toBe('N');
    expect(compass(Math.PI / 2)).toBe('W');
    expect(compass(-Math.PI / 2)).toBe('E');
    expect(compass(Math.PI)).toBe('S');
    expect(compass(-Math.PI / 4)).toBe('NE');
  });

  it('rounds chart tops up to a round number, never below the floor', () => {
    expect(chartMax([3, 7.2], 1)).toBe(10);
    expect(chartMax([130], 1)).toBe(200);
    expect(chartMax([0.1], 5)).toBe(5);
    expect(chartMax([], 20)).toBe(20);
    expect(chartMax([NaN, 2.2], 1)).toBe(2.5);
  });
});
