import {
  BLOCK_SIZE,
  DESIGN_MAX_BLOCKS,
  DESIGN_MAX_STATES,
  DESIGN_MAX_VOXELS,
  VoxelOccupancy,
  designSlug,
  type BlockVoxel,
  type DesignPiece,
  type DesignRecipe,
  type DesignRole,
  type DesignState,
  type MaterialId,
  type ObjectDesign,
} from '@super-vox/shared';

/** A design being edited: as saved, but maybe not yet (no id, no item). */
export interface Draft {
  /** Its id once saved (it keeps it, renamed or not); null: new. */
  id: string | null;
  name: string;
  size: [number, number, number];
  states: DesignState[];
  recipe: DesignRecipe | null;
  /** What it stands in for (see ObjectDesign.role), if anything. */
  role?: DesignRole;
  /** The piece of a keep it is (see ObjectDesign.piece), if any. */
  piece?: DesignPiece;
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A new design: a 1 m box with one state, empty. */
export function newDraft(): Draft {
  return { id: null, name: 'New object', size: [1, 1, 1], states: [{ name: 'default', voxels: [] }], recipe: null };
}

/** A saved design, to edit. */
export function draftOf(d: ObjectDesign): Draft {
  return copy({ id: d.id, name: d.name, size: d.size, states: d.states, recipe: d.recipe, ...(d.role ? { role: d.role } : {}), ...(d.piece ? { piece: d.piece } : {}) });
}

/**
 * Edits a design (the designer page's model, apart from drawing it): voxels placed, painted and
 * taken away in one of its states, by the rules the server checks (see parseDesign): inside its
 * box, on their own grid, not overlapping; optionally mirrored across its middle (x); every change
 * undoable.
 */
export class DesignEditor {
  draft: Draft;
  /** The state being edited. */
  state = 0;
  /** Changes made mirrored across the box's middle (left to right, as it faces). */
  mirror = false;
  /** The selected region (units; see move), if any: undone and redone with the changes, so it stays with what it holds. */
  selection: Region | null = null;
  private readonly undos: string[] = [];
  private redos: string[] = [];
  /** Changed since it was saved (or opened). */
  dirty = false;

  constructor(draft: Draft = newDraft()) {
    this.draft = copy(draft);
  }

  get voxels(): readonly BlockVoxel[] {
    return this.draft.states[this.state]!.voxels;
  }

  /** The box in units (x, y, z). */
  get extent(): [number, number, number] {
    return this.draft.size.map((n) => n * BLOCK_SIZE) as [number, number, number];
  }

  /** Why a voxel can't go in (null: it can). */
  refuse(v: BlockVoxel): string | null {
    const [W, H, D] = this.extent;
    if (v.x < 0 || v.y < 0 || v.z < 0 || v.x + v.size > W || v.y + v.size > H || v.z + v.size > D) return 'outside the box';
    if (v.x % v.size || v.y % v.size || v.z % v.size) return 'off its grid';
    if (this.occupancy().overlaps(v)) return 'something is there';
    if (this.voxels.length >= DESIGN_MAX_VOXELS) return `a state can have ${DESIGN_MAX_VOXELS} voxels at most`;
    return null;
  }

  /** Which cells the state's voxels take (see VoxelOccupancy): made again when they've changed. */
  private occ: { voxels: readonly BlockVoxel[]; length: number; version: number; occ: VoxelOccupancy } | null = null;
  private version = 0;
  private occupancy(): VoxelOccupancy {
    const vs = this.voxels, o = this.occ;
    if (o && o.voxels === vs && o.length === vs.length && o.version === this.version) return o.occ;
    this.occ = { voxels: vs, length: vs.length, version: this.version, occ: new VoxelOccupancy(vs) };
    return this.occ.occ;
  }
  /** A voxel just pushed onto the state (inside a change): into the occupancy as it is. */
  private pushed(v: BlockVoxel): void {
    const o = this.occ;
    if (o && o.voxels === this.voxels && o.length === this.voxels.length - 1 && o.version === this.version) {
      o.occ.add(v);
      o.length++;
    }
  }

  /** The voxel mirrored across the box's middle (x). */
  mirrored(v: BlockVoxel): BlockVoxel {
    return { ...v, x: this.extent[0] - v.x - v.size };
  }

  /** Places a voxel (and its mirror image, mirroring, if there's room for it); why not, if it can't. */
  place(v: BlockVoxel): string | null {
    const why = this.refuse(v);
    if (why) return why;
    this.change(() => {
      this.voxels_.push({ ...v });
      this.pushed(v);
      const m = this.mirrored(v);
      if (this.mirror && !this.refuse(m)) {
        this.voxels_.push(m);
        this.pushed(m);
      }
    });
    return null;
  }

  /**
   * Fills a region (cells of one size: see cellsBetween) with `material`, as one change: each cell
   * that's free (and, mirroring, its mirror image), the rest skipped. How many went in, and were skipped.
   */
  fill(cells: readonly { x: number; y: number; z: number }[], size: number, material: MaterialId): { placed: number; skipped: number } {
    let placed = 0, skipped = 0;
    const todo = cells.map((c) => ({ ...c, size, material }));
    if (!todo.some((v) => !this.refuse(v))) return { placed, skipped: todo.length };
    this.change(() => {
      for (const v of todo) {
        if (this.refuse(v)) {
          skipped++;
          continue;
        }
        this.voxels_.push(v);
        this.pushed(v);
        placed++;
        const m = this.mirrored(v);
        if (this.mirror && !this.refuse(m)) {
          this.voxels_.push(m);
          this.pushed(m);
          placed++;
        }
      }
    });
    return { placed, skipped };
  }

  /** Takes away every voxel touching the region (units, [x0, x1) etc.; mirroring, its mirror image's too), as one change. How many went. */
  clearRegion(r: Region): number {
    const [W] = this.extent;
    const mirror: Region = { ...r, x0: W - r.x1, x1: W - r.x0 };
    const hits = (v: BlockVoxel, q: Region) => v.x < q.x1 && q.x0 < v.x + v.size && v.y < q.y1 && q.y0 < v.y + v.size && v.z < q.z1 && q.z0 < v.z + v.size;
    const kept = this.voxels.filter((v) => !hits(v, r) && !(this.mirror && hits(v, mirror)));
    const gone = this.voxels.length - kept.length;
    if (gone) this.change(() => (this.draft.states[this.state]!.voxels = kept));
    return gone;
  }

  /**
   * Takes away every voxel touching any of `cells` (of `size`; mirroring, their mirror images' too),
   * as one change. How many went.
   */
  clearCells(cells: readonly Cell[], size: number): number {
    const [W] = this.extent;
    const touches = (v: BlockVoxel, c: Cell) => v.x < c.x + size && c.x < v.x + v.size && v.y < c.y + size && c.y < v.y + v.size && v.z < c.z + size && c.z < v.z + v.size;
    const all = this.mirror ? [...cells, ...cells.map((c) => ({ ...c, x: W - c.x - size }))] : cells;
    const kept = this.voxels.filter((v) => !all.some((c) => touches(v, c)));
    const gone = this.voxels.length - kept.length;
    if (gone) this.change(() => (this.draft.states[this.state]!.voxels = kept));
    return gone;
  }

  /**
   * The flat face aimed at (Extrude): voxel `start`'s face on side `axis`, `sign` (0 x, 1 y, 2 z;
   * which way out), and every voxel whose face that way lies in the same plane, is open (nothing
   * right against it) and is joined to it edge to edge, through others like it. Their indices
   * (none: that face of it isn't open).
   */
  flatFace(start: number, axis: 0 | 1 | 2, sign: 1 | -1): number[] {
    const vs = this.voxels, occ = this.occupancy();
    const at = (v: BlockVoxel, a: number) => (a === 0 ? v.x : a === 1 ? v.y : v.z);
    const plane = (v: BlockVoxel) => at(v, axis) + (sign > 0 ? v.size : 0);
    const open = (v: BlockVoxel) => {
      const out = { x: v.x, y: v.y, z: v.z, size: v.size };
      out[(['x', 'y', 'z'] as const)[axis]] += sign * v.size;
      return !occ.overlaps(out);
    };
    const first = vs[start];
    if (!first || !open(first)) return [];
    const p = plane(first);
    // The faces in that plane, by size and place across it (u, v: the other two axes).
    const [ua, va] = [0, 1, 2].filter((a) => a !== axis) as [number, number];
    const bySize = new Map<number, Map<string, number>>();
    vs.forEach((v, i) => {
      if (plane(v) !== p) return;
      let m = bySize.get(v.size);
      if (!m) bySize.set(v.size, (m = new Map()));
      m.set(`${at(v, ua)},${at(v, va)}`, i);
    });
    const seen = new Set<number>([start]), out: number[] = [], todo = [start];
    while (todo.length) {
      const i = todo.pop()!, v = vs[i]!;
      if (!open(v)) continue;
      out.push(i);
      const u0 = at(v, ua), v0 = at(v, va), s = v.size;
      // Faces of any size along each of its four edges (sharing some of the edge, not just a corner).
      for (const [size, m] of bySize) {
        const near = (u: number, w: number) => {
          const j = m.get(`${u},${w}`);
          if (j !== undefined && !seen.has(j)) {
            seen.add(j);
            todo.push(j);
          }
        };
        const lo = (c: number) => Math.floor(c / size) * size;
        for (let w = lo(v0); w < v0 + s; w += size) {
          near(u0 - size, w);
          near(u0 + s, w);
        }
        for (let u = lo(u0); u < u0 + s; u += size) {
          near(u, v0 - size);
          near(u, v0 + s);
        }
      }
    }
    return out;
  }

  /**
   * Extrudes the voxels `faces` (see flatFace) out of their face (`axis`, `sign`) by `depth` units:
   * each grows a column of copies of itself (its size and material) as long as that (whole copies:
   * as many as fit), those with no room skipped; or, `depth` negative, cuts in that deep behind
   * each (taking away whatever's there). As one change; mirroring, mirrored too. How many voxels
   * went in or went, and were skipped.
   */
  extrude(faces: readonly number[], axis: 0 | 1 | 2, sign: 1 | -1, depth: number): { placed: number; removed: number; skipped: number } {
    const k = (['x', 'y', 'z'] as const)[axis];
    const vs = faces.map((i) => this.voxels[i]!).filter(Boolean);
    if (depth < 0) {
      const regions: Region[] = vs.map((v) => {
        const r: Region = { x0: v.x, y0: v.y, z0: v.z, x1: v.x + v.size, y1: v.y + v.size, z1: v.z + v.size };
        const face = v[k] + (sign > 0 ? v.size : 0), d = -depth;
        r[`${k}0`] = sign > 0 ? face - d : face;
        r[`${k}1`] = sign > 0 ? face : face + d;
        return r;
      });
      const [W] = this.extent;
      const all = this.mirror ? [...regions, ...regions.map((r) => ({ ...r, x0: W - r.x1, x1: W - r.x0 }))] : regions;
      const hits = (v: BlockVoxel, q: Region) => v.x < q.x1 && q.x0 < v.x + v.size && v.y < q.y1 && q.y0 < v.y + v.size && v.z < q.z1 && q.z0 < v.z + v.size;
      const kept = this.voxels.filter((v) => !all.some((r) => hits(v, r)));
      const removed = this.voxels.length - kept.length;
      if (removed) this.change(() => (this.draft.states[this.state]!.voxels = kept));
      return { placed: 0, removed, skipped: 0 };
    }
    const todo: BlockVoxel[] = [];
    for (const v of vs) for (let n = 1; n * v.size <= depth; n++) todo.push({ ...v, [k]: v[k] + sign * n * v.size });
    let placed = 0, skipped = 0;
    if (!todo.some((v) => !this.refuse(v))) return { placed, removed: 0, skipped: todo.length };
    this.change(() => {
      for (const v of todo) {
        if (this.refuse(v)) {
          skipped++;
          continue;
        }
        this.voxels_.push(v);
        this.pushed(v);
        placed++;
        const m = this.mirrored(v);
        if (this.mirror && !this.refuse(m)) {
          this.voxels_.push(m);
          this.pushed(m);
          placed++;
        }
      }
    });
    return { placed, removed: 0, skipped };
  }

  /** Takes away the voxel at index `i` (and, mirroring, its mirror image, if there is one just like it). */
  remove(i: number): void {
    const v = this.voxels[i];
    if (!v) return;
    this.change(() => {
      const m = this.mirrored(v);
      this.draft.states[this.state]!.voxels = this.voxels.filter((o, k) => k !== i && !(this.mirror && same(o, m)));
    });
  }

  /** Paints the voxel at index `i` (and, mirroring, its mirror image) `material`. */
  paint(i: number, material: MaterialId): void {
    const v = this.voxels[i];
    if (!v || v.material === material) return;
    this.change(() => {
      const m = this.mirrored(v);
      this.draft.states[this.state]!.voxels = this.voxels.map((o, k) => (k === i || (this.mirror && same(o, m)) ? { ...o, material } : o));
    });
  }

  /** The voxels wholly inside the selection (by index), and how many more are only partly inside it. */
  selected(): { inside: number[]; partly: number } {
    const r = this.selection;
    const inside: number[] = [];
    let partly = 0;
    if (!r) return { inside, partly };
    this.voxels.forEach((v, i) => {
      if (v.x >= r.x0 && v.x + v.size <= r.x1 && v.y >= r.y0 && v.y + v.size <= r.y1 && v.z >= r.z0 && v.z + v.size <= r.z1) inside.push(i);
      else if (v.x < r.x1 && r.x0 < v.x + v.size && v.y < r.y1 && r.y0 < v.y + v.size && v.z < r.z1 && r.z0 < v.z + v.size) partly++;
    });
    return { inside, partly };
  }

  /**
   * How far a move of the selection goes with `size` chosen: that, or the biggest voxel in it if
   * that's bigger (so every voxel stays on its own grid).
   */
  moveStep(size: number): number {
    return Math.max(size, ...this.selected().inside.map((i) => this.voxels[i]!.size));
  }

  /**
   * Moves what's wholly inside the selection, and the selection with it, one step (see moveStep)
   * along axis `axis` (0 x, 1 y, 2 z) in direction `dir` (1 or -1), as one change. Why not, if it
   * can't: nothing selected, it would leave the box, or something not selected is in the way.
   * (Not mirrored.)
   */
  move(axis: 0 | 1 | 2, dir: 1 | -1, size: number): string | null {
    const r = this.selection;
    if (!r) return 'nothing selected';
    const { inside } = this.selected();
    if (!inside.length) return 'nothing wholly inside the selection to move';
    const step = this.moveStep(size) * dir;
    const key = (['x', 'y', 'z'] as const)[axis];
    const moved = inside.map((i) => ({ ...this.voxels[i]!, [key]: this.voxels[i]![key] + step }));
    const ext = this.extent;
    if (moved.some((v) => v[key] < 0 || v[key] + v.size > ext[axis])) return "it would leave the object's box";
    const picked = new Set(inside);
    const others = this.voxels.filter((_, i) => !picked.has(i));
    const rest = new VoxelOccupancy(others);
    if (moved.some((v) => rest.overlaps(v))) return 'something is in the way';
    const lo = (['x0', 'y0', 'z0'] as const)[axis], hi = (['x1', 'y1', 'z1'] as const)[axis];
    this.change(() => {
      this.draft.states[this.state]!.voxels = [...others, ...moved];
      // (The selection with it, kept inside the box.)
      this.selection = { ...r, [lo]: Math.max(0, r[lo] + step), [hi]: Math.min(ext[axis], r[hi] + step) };
    });
    return null;
  }

  /**
   * Resizes the box (blocks: 1 to DESIGN_MAX_BLOCKS each way); voxels left outside it go (in every
   * state). Returns how many went.
   */
  resize(size: [number, number, number]): number {
    if (!size.every((n) => Number.isInteger(n) && n >= 1 && n <= DESIGN_MAX_BLOCKS)) return 0;
    let dropped = 0;
    this.change(() => {
      this.draft.size = [...size];
      const [W, H, D] = this.extent;
      for (const s of this.draft.states) {
        const kept = s.voxels.filter((v) => v.x + v.size <= W && v.y + v.size <= H && v.z + v.size <= D);
        dropped += s.voxels.length - kept.length;
        s.voxels = kept;
      }
      this.selection = this.selection && clipRegion(this.selection, this.extent);
    });
    return dropped;
  }

  /** Adds a state (a copy of the one being edited), and edits it. False if there are as many as there can be. */
  addState(name: string): boolean {
    if (this.draft.states.length >= DESIGN_MAX_STATES) return false;
    this.change(() => {
      this.draft.states.push({ name, voxels: copy(this.voxels) as BlockVoxel[] });
      this.state = this.draft.states.length - 1;
    });
    return true;
  }

  /** Takes a state away (not the last one). */
  removeState(i: number): void {
    if (this.draft.states.length < 2 || !this.draft.states[i]) return;
    this.change(() => {
      this.draft.states.splice(i, 1);
      this.state = Math.min(this.state, this.draft.states.length - 1);
    });
  }

  renameState(i: number, name: string): void {
    if (!this.draft.states[i] || this.draft.states[i]!.name === name) return;
    this.change(() => (this.draft.states[i]!.name = name));
  }

  /** Clears the state being edited. */
  clear(): void {
    if (!this.voxels.length) return;
    this.change(() => (this.draft.states[this.state]!.voxels = []));
  }

  /** Sets anything else about it (name, recipe), undoably. */
  set(f: (d: Draft) => void): void {
    this.change(() => f(this.draft));
  }

  get canUndo(): boolean {
    return this.undos.length > 0;
  }

  get canRedo(): boolean {
    return this.redos.length > 0;
  }

  undo(): void {
    const prev = this.undos.pop();
    if (prev === undefined) return;
    this.redos.push(this.snapshot());
    this.restore(prev);
  }

  redo(): void {
    const next = this.redos.pop();
    if (next === undefined) return;
    this.undos.push(this.snapshot());
    this.restore(next);
  }

  /** What to save (PUT /api/designs/:id): its id (new: made from its name, not one of `taken`). */
  body(taken: ReadonlySet<string> = new Set()): Omit<ObjectDesign, 'item'> {
    let id = this.draft.id;
    if (!id) {
      const base = designSlug(this.draft.name);
      id = base;
      for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 36)}-${n}`;
    }
    return { id, name: this.draft.name, size: [...this.draft.size], states: copy(this.draft.states), recipe: copy(this.draft.recipe), ...(this.draft.role ? { role: this.draft.role } : {}), ...(this.draft.piece ? { piece: this.draft.piece } : {}) };
  }

  /** It was saved as `id`. */
  saved(id: string): void {
    this.draft.id = id;
    this.dirty = false;
  }

  private get voxels_(): BlockVoxel[] {
    return this.draft.states[this.state]!.voxels;
  }

  private snapshot(): string {
    return JSON.stringify({ draft: this.draft, state: this.state, selection: this.selection });
  }

  /** Bumped by every change (undone and redone too): what's worked out from the voxels is good while it's the same. */
  get revision(): number {
    return this.version;
  }

  private restore(s: string): void {
    this.version++;
    const { draft, state, selection } = JSON.parse(s) as { draft: Draft; state: number; selection: Region | null };
    this.draft = draft;
    this.state = state;
    this.selection = selection;
    this.dirty = true;
  }

  private change(f: () => void): void {
    this.version++;
    this.undos.push(this.snapshot());
    if (this.undos.length > 200) this.undos.shift();
    this.redos = [];
    f();
    this.dirty = true;
  }
}

export { cellsIn, regionBetween, roundCells, shapeCells, type Region, type RoundShape, type RoundSpec } from '@super-vox/shared';
import type { Region } from '@super-vox/shared';

type Cell = { x: number; y: number; z: number };

/** The region clipped to a box `extent` (units) across (null: nothing left). */
export function clipRegion(r: Region, extent: readonly number[]): Region | null {
  const c = { x0: Math.max(0, r.x0), y0: Math.max(0, r.y0), z0: Math.max(0, r.z0), x1: Math.min(extent[0]!, r.x1), y1: Math.min(extent[1]!, r.y1), z1: Math.min(extent[2]!, r.z1) };
  return c.x0 < c.x1 && c.y0 < c.y1 && c.z0 < c.z1 ? c : null;
}

const same = (a: BlockVoxel, b: BlockVoxel) => a.x === b.x && a.y === b.y && a.z === b.z && a.size === b.size;

/**
 * Where a voxel of `size` goes when a face is clicked: against it, outward (`normal`), at `point`
 * (units, on the face), snapped to its own grid. For the floor: `normal` up, `point` on it.
 */
export function placeAgainst(point: readonly number[], normal: readonly number[], size: number): { x: number; y: number; z: number } {
  // A hair out from the face, then the grid cell of `size` there.
  const p = point.map((c, a) => c + normal[a]! * 0.01);
  const [x, y, z] = p.map((c) => Math.floor(c / size) * size) as [number, number, number];
  return { x, y, z };
}

/** The working plane: across axis `axis` (0 x, 1 y: flat, 2 z), `at` units along it (see aimSurface). */
export interface WorkPlane {
  axis: 0 | 1 | 2;
  at: number;
}

/**
 * What a ray (units; from outside or inside the box) aims at when it misses every voxel: the nearer
 * of the working plane (where it crosses inside the box) and the box's far side (where the ray
 * leaves it: the floor looking down, the back wall looking across). The normal points back toward
 * the ray's origin (so a build lands on the near side). Null if the ray misses the box.
 */
export function aimSurface(
  origin: readonly number[],
  dir: readonly number[],
  extent: readonly number[],
  plane: WorkPlane,
): { point: [number, number, number]; normal: [number, number, number]; on: 'plane' | 'wall' } | null {
  // The box: where the ray is inside it, [t0, t1] (slabs).
  let t0 = 0, t1 = Infinity, exitAxis = -1;
  for (let a = 0; a < 3; a++) {
    const o = origin[a]!, d = dir[a]!, hi = extent[a]!;
    if (Math.abs(d) < 1e-12) {
      if (o < 0 || o > hi) return null;
      continue;
    }
    let near = (0 - o) / d, far = (hi - o) / d;
    if (near > far) [near, far] = [far, near];
    if (near > t0) t0 = near;
    if (far < t1) {
      t1 = far;
      exitAxis = a;
    }
  }
  if (t0 > t1 || exitAxis < 0) return null;
  const at = (t: number) => [0, 1, 2].map((a) => origin[a]! + dir[a]! * t) as [number, number, number];
  const back = (axis: number) => [0, 1, 2].map((a) => (a === axis ? -Math.sign(dir[a]!) : 0)) as [number, number, number];
  // The plane, if the ray crosses it while inside the box.
  const d = dir[plane.axis]!;
  if (Math.abs(d) > 1e-12) {
    const t = (plane.at - origin[plane.axis]!) / d;
    if (t >= t0 - 1e-9 && t <= t1 + 1e-9 && t > 0) {
      const p = at(t);
      p[plane.axis] = plane.at;
      return { point: p, normal: back(plane.axis), on: 'plane' };
    }
  }
  const p = at(t1);
  p[exitAxis] = dir[exitAxis]! > 0 ? extent[exitAxis]! : 0;
  return { point: p, normal: back(exitAxis), on: 'wall' };
}

