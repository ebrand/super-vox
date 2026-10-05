import { describe, expect, it } from 'vitest';
import { clockHours, defaultClock } from '@super-vox/shared';
import { REAL_TIME_ZONE, zoneUtcOffsetMinutes } from './worlds.js';

describe('real-time clocks', () => {
  it("keep Chicago's time, standard and daylight saving, wherever the server is", () => {
    expect(REAL_TIME_ZONE).toBe('America/Chicago');
    expect(zoneUtcOffsetMinutes(new Date('2026-01-15T12:00:00Z'))).toBe(-360); // CST
    expect(zoneUtcOffsetMinutes(new Date('2026-07-15T12:00:00Z'))).toBe(-300); // CDT
    // Daylight saving starts at 2 am local on 8 March 2026 (08:00 UTC): just before and after.
    expect(zoneUtcOffsetMinutes(new Date('2026-03-08T07:59:00Z'))).toBe(-360);
    expect(zoneUtcOffsetMinutes(new Date('2026-03-08T08:01:00Z'))).toBe(-300);
    // And ends at 2 am local on 1 November 2026 (07:00 UTC).
    expect(zoneUtcOffsetMinutes(new Date('2026-11-01T06:59:00Z'))).toBe(-300);
    expect(zoneUtcOffsetMinutes(new Date('2026-11-01T07:01:00Z'))).toBe(-360);
    // Other zones still work (the offset is the zone's, not the server's).
    expect(zoneUtcOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'UTC')).toBe(0);
    expect(zoneUtcOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'Asia/Kolkata')).toBe(330);
  });

  it("show Chicago's hour of the day", () => {
    // 18:30 UTC on 15 July is 13:30 in Chicago (CDT).
    const now = Date.parse('2026-07-15T18:30:00Z');
    const clock = defaultClock(now, 'real', zoneUtcOffsetMinutes(new Date(now)));
    expect(clockHours(clock, now)).toBeCloseTo(13.5, 6);
    // 18:30 UTC on 15 January is 12:30 (CST).
    const winter = Date.parse('2026-01-15T18:30:00Z');
    expect(clockHours(defaultClock(winter, 'real', zoneUtcOffsetMinutes(new Date(winter))), winter)).toBeCloseTo(12.5, 6);
  });
});
