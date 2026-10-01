/**
 * A world's time of day, kept by the server. Either a game day of `dayMinutes` real minutes, or
 * real time (the server's clock and time zone). Time is in hours, 0 (midnight) .. 24.
 */
export interface DayClock {
  /** Real minutes per game day, or 'real' to follow the server's clock. */
  dayMinutes: number | 'real';
  /** The time of day (hours) at server time `at` (epoch ms); unused for real time unless frozen. */
  hours: number;
  at: number;
  /** Stopped at `hours`. */
  frozen: boolean;
  /** Real time: the server's offset from UTC (minutes, east positive). */
  utcOffsetMinutes: number;
}

export const DEFAULT_DAY_MINUTES = 24;
export const DAY_MINUTES_LIMITS = [1, 1440] as const;

/** A new world's clock: a 24-minute day starting at 8 in the morning, now. */
export function defaultClock(now: number, dayMinutes: number | 'real' = DEFAULT_DAY_MINUTES, utcOffsetMinutes = 0): DayClock {
  return { dayMinutes, hours: 8, at: now, frozen: false, utcOffsetMinutes };
}

/** Time of day (hours, 0..24) at server time `now` (epoch ms). */
export function clockHours(c: DayClock, now: number): number {
  if (c.frozen) return mod(c.hours, 24);
  if (c.dayMinutes === 'real') return mod((now + c.utcOffsetMinutes * 60_000) / 3_600_000, 24);
  return mod(c.hours + ((now - c.at) / (c.dayMinutes * 60_000)) * 24, 24);
}

/** "08:30". */
export function formatHours(hours: number): string {
  const m = Math.floor(mod(hours, 24) * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Changes to a clock (see applyClockChange). */
export interface ClockChange {
  dayMinutes?: number | 'real';
  /** Set the time of day now (hours). */
  hours?: number;
  frozen?: boolean;
}

/** Validates a change from untrusted input; throws RangeError. */
export function parseClockChange(raw: unknown): ClockChange {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: ClockChange = {};
  if (r.dayMinutes !== undefined) {
    const d = r.dayMinutes;
    if (d !== 'real' && !(typeof d === 'number' && d >= DAY_MINUTES_LIMITS[0] && d <= DAY_MINUTES_LIMITS[1])) {
      throw new RangeError(`dayMinutes must be ${DAY_MINUTES_LIMITS[0]}..${DAY_MINUTES_LIMITS[1]} or "real"`);
    }
    out.dayMinutes = d;
  }
  if (r.hours !== undefined) {
    if (typeof r.hours !== 'number' || !(r.hours >= 0 && r.hours < 24)) throw new RangeError('hours must be 0..24');
    out.hours = r.hours;
  }
  if (r.frozen !== undefined) {
    if (typeof r.frozen !== 'boolean') throw new RangeError('frozen must be true or false');
    out.frozen = r.frozen;
  }
  return out;
}

/**
 * The clock after a change made at `now`: the time of day carries on from where it was unless set.
 * Setting the time of a real-time clock freezes it there (the real clock can't be moved).
 */
export function applyClockChange(c: DayClock, change: ClockChange, now: number): DayClock {
  const hours = change.hours ?? clockHours(c, now);
  const dayMinutes = change.dayMinutes ?? c.dayMinutes;
  const frozen = change.frozen ?? (dayMinutes === 'real' && change.hours !== undefined ? true : c.frozen);
  return { ...c, dayMinutes, hours, at: now, frozen };
}

/** A saved clock from untrusted data (e.g. a world file), or null if it isn't one. */
export function parseClock(raw: unknown): DayClock | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  try {
    const change = parseClockChange({ dayMinutes: r.dayMinutes, hours: r.hours, frozen: r.frozen });
    if (change.dayMinutes === undefined || change.hours === undefined || change.frozen === undefined) return null;
    if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
    const off = typeof r.utcOffsetMinutes === 'number' && Number.isFinite(r.utcOffsetMinutes) ? r.utcOffsetMinutes : 0;
    return { dayMinutes: change.dayMinutes, hours: change.hours, at: r.at, frozen: change.frozen, utcOffsetMinutes: off };
  } catch {
    return null;
  }
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
