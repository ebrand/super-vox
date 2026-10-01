import { describe, expect, it } from 'vitest';
import { applyClockChange, clockHours, defaultClock, formatHours, parseClock, parseClockChange } from './clock.js';

const MIN = 60_000;

describe('day clock', () => {
  it('runs a game day in dayMinutes, wrapping at midnight', () => {
    const c = defaultClock(0, 24); // 8:00 at t = 0
    expect(clockHours(c, 0)).toBe(8);
    expect(clockHours(c, 6 * MIN)).toBe(14); // 6 real minutes = 6 game hours
    expect(clockHours(c, 18 * MIN)).toBeCloseTo(2, 9); // past midnight
    expect(clockHours(defaultClock(0, 48), 48 * MIN)).toBeCloseTo(8, 9); // a whole day later
  });

  it('follows the server clock in real time, in its time zone', () => {
    const c = defaultClock(0, 'real', 120); // UTC+2
    expect(clockHours(c, Date.UTC(2026, 0, 1, 10, 30))).toBeCloseTo(12.5, 9);
    expect(clockHours(c, Date.UTC(2026, 0, 1, 23, 0))).toBeCloseTo(1, 9);
  });

  it('stops when frozen, and carries on from where it was when changed', () => {
    const c = defaultClock(0, 24);
    const stopped = applyClockChange(c, { frozen: true }, 3 * MIN); // at 11:00
    expect(clockHours(stopped, 100 * MIN)).toBeCloseTo(11, 9);
    const going = applyClockChange(stopped, { frozen: false }, 100 * MIN);
    expect(clockHours(going, 101 * MIN)).toBeCloseTo(12, 9);
    // A new day length keeps the time of day.
    const slow = applyClockChange(going, { dayMinutes: 48 }, 101 * MIN);
    expect(clockHours(slow, 103 * MIN)).toBeCloseTo(13, 9);
    // Setting the time of a real-time clock stops it there.
    const real = applyClockChange(defaultClock(0, 'real'), { hours: 21 }, 5);
    expect(real.frozen).toBe(true);
    expect(clockHours(real, 99 * MIN)).toBe(21);
  });

  it('formats hours and validates changes and saved clocks', () => {
    expect(formatHours(8.5)).toBe('08:30');
    expect(formatHours(23.999)).toBe('23:59');
    expect(formatHours(-1)).toBe('23:00');
    expect(parseClockChange({ dayMinutes: 'real', hours: 6, frozen: true })).toEqual({ dayMinutes: 'real', hours: 6, frozen: true });
    for (const bad of [{ dayMinutes: 0 }, { dayMinutes: 'slow' }, { hours: 24 }, { hours: -1 }, { frozen: 'yes' }]) expect(() => parseClockChange(bad)).toThrow(RangeError);
    const c = defaultClock(1234, 24, 60);
    expect(parseClock(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(parseClock({ ...c, at: 'now' })).toBeNull();
    expect(parseClock({ ...c, hours: 30 })).toBeNull();
    expect(parseClock(null)).toBeNull();
  });
});
