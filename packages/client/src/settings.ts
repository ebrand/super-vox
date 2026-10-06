import { isValidTolerance } from '@super-vox/shared';

/**
 * Player settings kept in this browser (there are no accounts yet). URL
 * parameters on the game page override them for one visit.
 */
export interface Settings {
  /** Full-detail radius around the player, in 16 m chunks. */
  detail: number;
  /** View distance in metres: low-detail terrain reaches this far. */
  view: number;
  /** Terrain tolerance to ask the server for (1/16 m units), or null for the world's own. Development servers only. */
  tolerance: number | null;
  /** The world picked last on the entry page. */
  world: string | null;
  /** Performance: how many mesh workers (background threads) build terrain meshes (see workersFor). */
  performance: Performance;
  /** The game full-screen: entered when the mouse is captured (a click: browsers allow it then). */
  fullscreen: boolean;
}

export type Performance = 'normal' | 'medium' | 'max';
const PERFORMANCES: readonly Performance[] = ['normal', 'medium', 'max'];
const isPerformance = (v: unknown): v is Performance => PERFORMANCES.includes(v as Performance);

/**
 * Mesh workers for a Performance setting on a computer with `cores` processor cores (as the
 * browser reports them; 0 if it doesn't): normal, 2; medium, half the cores; max, all of them.
 */
/**
 * How fine distant terrain is for a Performance setting (see selectLod's farRadius): normal a
 * little coarser, medium as the default full-detail radius draws it, max finer.
 */
export function farDetailFor(p: Performance): number {
  return p === 'normal' ? 3 : p === 'medium' ? 4 : 6;
}

export function workersFor(p: Performance, cores: number): number {
  const n = cores > 0 ? cores : 4;
  return Math.max(1, p === 'normal' ? Math.min(2, n) : p === 'medium' ? Math.floor(n / 2) : n);
}

export const SETTINGS_LIMITS = { detail: [1, 32], view: [64, 16_000] } as const;

export function defaultSettings(): Settings {
  return { detail: 4, view: 2048, tolerance: null, world: null, performance: 'medium', fullscreen: false };
}

const KEY = 'super-vox.settings';

/** Settings from untrusted data: anything missing or out of range takes its default. */
export function parseSettings(raw: unknown): Settings {
  const d = defaultSettings();
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const int = (v: unknown, [lo, hi]: readonly [number, number], fallback: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback;
  return {
    detail: int(r.detail, SETTINGS_LIMITS.detail, d.detail),
    view: int(r.view, SETTINGS_LIMITS.view, d.view),
    tolerance: isValidTolerance(r.tolerance) ? r.tolerance : null,
    world: typeof r.world === 'string' && r.world !== '' ? r.world : null,
    performance: isPerformance(r.performance) ? r.performance : d.performance,
    fullscreen: r.fullscreen === true,
  };
}

/** Saved settings, or the defaults if there are none or storage is unavailable. */
export function loadSettings(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Settings {
  try {
    const raw = storage?.getItem(KEY);
    return parseSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultSettings();
  }
}

/** Saves settings; returns false if the browser won't store them (e.g. private mode). */
export function saveSettings(s: Settings, storage: Pick<Storage, 'setItem'> | null = safeStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(KEY, JSON.stringify(parseSettings(s)));
    return true;
  } catch {
    return false;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Where the settings page goes after (its ?return=): a page of this site; null for anything else. */
export function returnTo(search: string): string | null {
  const r = new URLSearchParams(search).get('return');
  return r && r.startsWith('/') && !r.startsWith('//') && !r.startsWith('/\\') ? r : null;
}
