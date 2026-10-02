/**
 * Where the world map looks and how closely: the world point at the middle of the frame and the
 * scale in screen (CSS) pixels per world unit. Pure arithmetic for WorldMapOverlay.
 */
export interface MapView {
  cx: number;
  cz: number;
  scale: number;
}

export interface MapWorld {
  width: number;
  depth: number;
  wrapX: boolean;
}

/** The closest zoom: 4 screen pixels per metre (16 units). */
export const MAX_SCALE = 4 / 16;
/** The finest map samples the server makes: 1 m. */
export const MIN_STEP = 16;

/** The whole world in a `w` x `h` frame. */
export function fitView(world: MapWorld, w: number, h: number): MapView {
  return { cx: world.width / 2, cz: world.depth / 2, scale: Math.min(w / world.width, h / world.depth) };
}

export function screenToWorld(v: MapView, w: number, h: number, sx: number, sy: number): [number, number] {
  return [v.cx + (sx - w / 2) / v.scale, v.cz + (sy - h / 2) / v.scale];
}

/**
 * Keeps the view on the world: never smaller than the whole world, the frame never past its north
 * and south edges (or east and west, unless it wraps), the middle of a wrapping world kept within it.
 */
export function clampView(v: MapView, world: MapWorld, w: number, h: number): MapView {
  const scale = Math.min(MAX_SCALE, Math.max(fitView(world, w, h).scale, v.scale));
  const keep = (c: number, size: number, frame: number) => {
    const half = frame / 2 / scale;
    return half * 2 >= size ? size / 2 : Math.max(half, Math.min(size - half, c));
  };
  const cx = world.wrapX ? ((v.cx % world.width) + world.width) % world.width : keep(v.cx, world.width, w);
  return { cx, cz: keep(v.cz, world.depth, h), scale };
}

/** Zooms by `factor` keeping the world point under screen (sx, sy) where it is. */
export function zoomAt(v: MapView, world: MapWorld, w: number, h: number, sx: number, sy: number, factor: number): MapView {
  const [x, z] = screenToWorld(v, w, h, sx, sy);
  const scale = Math.min(MAX_SCALE, Math.max(fitView(world, w, h).scale, v.scale * factor));
  return clampView({ cx: x - (sx - w / 2) / scale, cz: z - (sy - h / 2) / scale, scale }, world, w, h);
}

/** Moves the view by a drag of (dx, dy) screen pixels. */
export function pan(v: MapView, world: MapWorld, w: number, h: number, dx: number, dy: number): MapView {
  return clampView({ ...v, cx: v.cx - dx / v.scale, cz: v.cz - dy / v.scale }, world, w, h);
}

/** Samples per side of a map tile (a closer look, see the server's /api/world/map/area). */
export const TILE = 256;

/**
 * The map tiles worth showing: covering the visible area at about one sample per screen pixel,
 * in steps of a power of two times MIN_STEP; each TILE x TILE samples, at multiples of its size
 * (so they're shared as the view moves). Nearest the middle first. None when the whole map
 * (samples `baseStep` apart) is already as sharp as the screen. Tiles may lie past a wrapping
 * world's seam (x0 outside it): draw them there, fetch them at x0 modulo the width.
 */
export function detailTiles(v: MapView, world: MapWorld, w: number, h: number, baseStep: number): { step: number; tiles: { x0: number; z0: number }[] } | null {
  const perPixel = 1 / v.scale;
  let step = MIN_STEP;
  while (step < perPixel) step *= 2;
  if (step * 1.5 >= baseStep) return null;
  const size = TILE * step;
  let x0 = v.cx - w / 2 / v.scale, x1 = v.cx + w / 2 / v.scale;
  if (!world.wrapX) [x0, x1] = [Math.max(0, x0), Math.min(world.width, x1)];
  const z0 = Math.max(0, v.cz - h / 2 / v.scale), z1 = Math.min(world.depth, v.cz + h / 2 / v.scale);
  const tiles: { x0: number; z0: number; d: number }[] = [];
  for (let tz = Math.floor(z0 / size); tz * size < z1; tz++) {
    for (let tx = Math.floor(x0 / size); tx * size < x1; tx++) {
      const cx = (tx + 0.5) * size, cz = (tz + 0.5) * size;
      tiles.push({ x0: tx * size, z0: tz * size, d: Math.hypot(cx - v.cx, cz - v.cz) });
    }
  }
  return { step, tiles: tiles.sort((a, b) => a.d - b.d).map(({ x0, z0 }) => ({ x0, z0 })) };
}

/** A round length (1, 2 or 5 times a power of ten metres, in units) about `units` long or less. */
export function niceLength(units: number): number {
  const m = units / 16;
  const p = 10 ** Math.floor(Math.log10(m));
  const n = [5, 2, 1].map((k) => k * p).find((k) => k <= m) ?? p;
  return n * 16;
}
