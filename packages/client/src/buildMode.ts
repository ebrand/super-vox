import { buildCells, type BuildOp, type Cell, type MaterialId, type RoundShape } from '@super-vox/shared';

/**
 * Build mode (creative): the object designer's shape tools, in the world. In the game the mouse
 * looks round, so a shape is clicked out rather than dragged: click where it starts (against the
 * face aimed at: or, clearing, in what's aimed at), aim, click again; a box's base first, then
 * its height (aim up or down the line out of the corner just clicked), then a third click. Right-click: never mind.
 * What's drawn so far is a BuildOp (see buildCells), sent to the server whole.
 */
export type BuildTool = 'line' | 'box' | RoundShape;
export const BUILD_TOOLS: readonly BuildTool[] = ['line', 'box', 'circle', 'dome', 'sphere'];

/** A ray (units): where from, and which way (any length). */
export interface Ray {
  origin: readonly number[];
  dir: readonly number[];
}

/** The face aimed at: a point on it, and its outward normal (one axis ±1) (units). */
export interface FaceAim {
  point: readonly number[];
  normal: readonly number[];
}

interface Drawing {
  tool: BuildTool;
  clear: boolean;
  /** The cell it started at (units), and the axis out of the face it started on. */
  start: Cell;
  axis: 0 | 1 | 2;
  sign: 1 | -1;
  /** Where it's been aimed to (a cell), and (a box, raised) how far up or down (units). */
  end: Cell;
  stage: 'drag' | 'raise';
  depth: number;
}

const KEYS = ['x', 'y', 'z'] as const;

export class BuildMode {
  tool: BuildTool = 'box';
  /** Round shapes: rings and shells, `thickness` cells thick. */
  hollow = false;
  thickness = 1;
  private drawing: Drawing | null = null;

  /** Whether a shape's being drawn (started, not yet finished). */
  get active(): boolean {
    return this.drawing !== null;
  }

  /** What the shape needs next, for people. */
  get stage(): string {
    const d = this.drawing;
    if (!d) return this.tool === 'line' || this.tool === 'box' ? 'click where it starts' : 'click where its middle goes';
    if (d.tool === 'box') return d.stage === 'drag' ? 'aim out its base, click' : 'aim up or down for its height, click';
    return d.tool === 'line' ? 'aim along a row, click' : 'aim out its radius, click';
  }

  /** The next tool round. */
  nextTool(): void {
    this.cancel();
    this.tool = BUILD_TOOLS[(BUILD_TOOLS.indexOf(this.tool) + 1) % BUILD_TOOLS.length]!;
  }

  cancel(): void {
    this.drawing = null;
  }

  /**
   * A click: starts a shape at the face aimed at (`clear`: in what's aimed at, else against it),
   * moves a box on to its height, or finishes the shape (then it's returned, made of cells of
   * `size` in `material`).
   */
  click(aim: FaceAim | null, ray: Ray, size: number, material: MaterialId, clear: boolean): BuildOp | null {
    const d = this.drawing;
    if (!d) {
      if (!aim) return null;
      const axis = Math.max(0, aim.normal.findIndex((c) => Math.abs(c) > 0.5)) as 0 | 1 | 2;
      const sign: 1 | -1 = aim.normal[axis]! < 0 ? -1 : 1;
      // A hair out from the face (filling: the cell beside it) or in (clearing: the cell in it).
      const p = aim.point.map((c, a) => c + aim.normal[a]! * (clear ? -0.01 : 0.01));
      const [x, y, z] = p.map((c) => Math.floor(c / size) * size) as [number, number, number];
      const start = { x, y, z };
      this.drawing = { tool: this.tool, clear, start, axis, sign, end: { ...start }, stage: 'drag', depth: 0 };
      return null;
    }
    this.move(ray, size);
    if (d.tool === 'box' && d.stage === 'drag') {
      d.stage = 'raise';
      return null;
    }
    const op = this.op(size, material);
    this.drawing = null;
    return op;
  }

  /** Follows the aim (each frame): the line's end, the base's corner, the radius, or the height. */
  move(ray: Ray, size: number): void {
    const d = this.drawing;
    if (!d) return;
    // (How far from cell `c`, along `axis`, to the cell the point `t` from its middle is in.)
    const cellsOn = (c: Cell, axis: number, t: number) => Math.floor((c[KEYS[axis]!] + size / 2 + t) / size) * size - c[KEYS[axis]!];
    if (d.stage === 'raise') {
      // Up (or down) the line through the corner just clicked, where the aim is.
      const a = this.along(d.end, d.axis, ray, size);
      if (a) d.depth = cellsOn(d.end, d.axis, a.t);
      return;
    }
    if (d.tool === 'line') {
      // Along whichever axis the aim passes nearest.
      let best: { axis: number; t: number; off: number } | null = null;
      for (let axis = 0; axis < 3; axis++) {
        const a = this.along(d.start, axis, ray, size);
        if (a && (!best || a.off < best.off)) best = { axis, ...a };
      }
      if (best) {
        d.end = { ...d.start };
        d.end[KEYS[best.axis]!] += cellsOn(d.start, best.axis, best.t);
      }
      return;
    }
    // On the plane through the start cell's middle, across the axis out of its face.
    const c = this.centre(d.start, size), k = KEYS[d.axis]!;
    const dn = ray.dir[d.axis]!;
    if (Math.abs(dn) < 1e-9) return;
    const t = (c[k] - ray.origin[d.axis]!) / dn;
    if (t <= 0) return;
    const p = [0, 1, 2].map((a) => ray.origin[a]! + ray.dir[a]! * t);
    d.end = { x: Math.floor(p[0]! / size) * size, y: Math.floor(p[1]! / size) * size, z: Math.floor(p[2]! / size) * size };
    d.end[k] = d.start[k];
  }

  /** The shape drawn so far, as a build of cells of `size` in `material`; null: none. */
  op(size: number, material: MaterialId): BuildOp | null {
    const d = this.drawing;
    if (!d) return null;
    if (d.tool === 'line' || d.tool === 'box') {
      const b = { ...d.end };
      if (d.tool === 'box') b[KEYS[d.axis]!] = d.start[KEYS[d.axis]!] + d.depth;
      return { shape: { kind: 'box', a: d.start, b }, size, material, clear: d.clear };
    }
    // Round: centred on the start cell, out to the aimed cell (in half cells, as the designer).
    const mid = this.centre(d.start, size), end = this.centre(d.end, size);
    let dist2 = 0;
    for (const k of [0, 1, 2] as const) if (k !== d.axis) dist2 += (end[KEYS[k]] - mid[KEYS[k]]) ** 2;
    const half = size / 2;
    const outer = Math.max(half, Math.round((Math.sqrt(dist2) + half) / half) * half);
    return {
      shape: { kind: 'round', spec: { kind: d.tool, centre: mid, axis: d.axis, sign: d.sign, outer, thickness: this.hollow ? this.thickness * size : null } },
      size,
      material,
      clear: d.clear,
    };
  }

  /** The cells of the shape drawn so far (or why it can't be built), for the preview. */
  cells(size: number, material: MaterialId): Cell[] | string | null {
    const op = this.op(size, material);
    return op && buildCells(op);
  }

  private centre(c: Cell, size: number): { x: number; y: number; z: number } {
    return { x: c.x + size / 2, y: c.y + size / 2, z: c.z + size / 2 };
  }

  /**
   * Along axis `axis` through cell `c`'s middle: the point nearest the aim's ray (`t`, units from
   * the middle), and how far the ray passes from it (units); null if the axis points along the ray.
   */
  private along(c: Cell, axis: number, ray: Ray, size: number): { t: number; off: number } | null {
    const o = this.centre(c, size), origin = [o.x, o.y, o.z];
    const len = Math.hypot(ray.dir[0]!, ray.dir[1]!, ray.dir[2]!);
    const dir = ray.dir.map((v) => v / len);
    const w0 = origin.map((v, i) => v - ray.origin[i]!);
    const b = dir[axis]!, denom = 1 - b * b;
    if (denom < 1e-6) return null;
    const dw = dir.reduce((s, v, i) => s + v * w0[i]!, 0);
    const t = (b * dw - w0[axis]!) / denom;
    // (The ray's nearest point: at s along it.)
    const sRay = dw + b * t;
    const p = origin.map((v, i) => v + (i === axis ? t : 0)), q = ray.origin.map((v, i) => v + dir[i]! * sRay);
    return { t, off: Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!) };
  }
}
