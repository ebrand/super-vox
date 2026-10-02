import { UNITS_PER_METER } from '@super-vox/shared';

export interface StartAt {
  /** Where to start (units): x within the world (wrapped on round worlds), z inside it. */
  x: number;
  z: number;
  /** Ground height to stand on (units), or null to look it up. */
  y: number | null;
}

/**
 * A starting place from the page's URL: ?x=…&z=… in metres (as the Info panel shows them), and
 * optionally &y=… for the ground height in metres; null without both x and z (or if either isn't
 * a number). x wraps on round worlds and is clamped otherwise; z is clamped into the world.
 */
export function startFromParams(params: URLSearchParams, world: { widthUnits: number; depthUnits: number; wrapX: boolean }): StartAt | null {
  const num = (k: string) => {
    const raw = params.get(k);
    const v = raw === null || raw.trim() === '' ? NaN : Number(raw);
    return Number.isFinite(v) ? v : null;
  };
  const xm = num('x'), zm = num('z'), ym = num('y');
  if (xm === null || zm === null) return null;
  const W = world.widthUnits, D = world.depthUnits;
  let x = Math.round(xm * UNITS_PER_METER);
  x = world.wrapX ? ((x % W) + W) % W : Math.max(0, Math.min(W - 1, x));
  const z = Math.max(0, Math.min(D - 1, Math.round(zm * UNITS_PER_METER)));
  return { x, z, y: ym === null ? null : Math.round(ym * UNITS_PER_METER) };
}

const RETURN_KEY = 'super-vox.return';

/**
 * Before a reload the server asked for (the land reshaped, the mode changed): where we are in
 * `world` (metres), to come back to (see takeReturn).
 */
export function rememberReturn(storage: Pick<Storage, 'setItem'> | null, world: string | undefined, x: number, z: number, now = Date.now()): void {
  try {
    storage?.setItem(RETURN_KEY, JSON.stringify({ world: world ?? null, x, z, at: now }));
  } catch {
    // Can't remember: back at the spawn.
  }
}

/** Where to come back to in `world` (metres): once, and only within a minute of leaving; else null. */
export function takeReturn(storage: Pick<Storage, 'getItem' | 'removeItem'> | null, world: string | undefined, now = Date.now()): { x: number; z: number } | null {
  try {
    const raw = storage?.getItem(RETURN_KEY);
    storage?.removeItem(RETURN_KEY);
    const r = raw ? (JSON.parse(raw) as { world: string | null; x: number; z: number; at: number }) : null;
    if (!r || r.world !== (world ?? null) || now - r.at > 60_000 || !Number.isFinite(r.x) || !Number.isFinite(r.z)) return null;
    return { x: r.x, z: r.z };
  } catch {
    return null;
  }
}
