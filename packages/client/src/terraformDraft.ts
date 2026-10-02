import { validateStrokes, type TerrainStroke } from '@super-vox/shared';

/**
 * A world's draft terraforming: strokes made in the Terraformer and not yet applied to the world,
 * in groups (a click is one group, a drag one group), so undo takes back a whole drag. Redo
 * brings back what undo took, until something new is drawn. Clear is undoable too.
 */
export class TerraformDraft {
  private groups: TerrainStroke[][] = [];
  private undone: TerrainStroke[][][] = [];
  /** Snapshots before each change, for undo. */
  private history: TerrainStroke[][][] = [];

  constructor(groups: TerrainStroke[][] = []) {
    this.groups = groups.map((g) => [...g]);
  }

  /** All the strokes, in order. */
  get strokes(): TerrainStroke[] {
    return this.groups.flat();
  }

  get count(): number {
    return this.groups.reduce((n, g) => n + g.length, 0);
  }

  get canUndo(): boolean {
    return this.history.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** Starts a new group (a click or drag) with these strokes. */
  begin(strokes: TerrainStroke[]): void {
    this.remember();
    this.groups.push([...strokes]);
  }

  /** Adds strokes to the group last begun (a drag going on). */
  extend(strokes: TerrainStroke[]): void {
    if (this.groups.length === 0) return this.begin(strokes);
    this.groups[this.groups.length - 1]!.push(...strokes);
  }

  undo(): boolean {
    const prev = this.history.pop();
    if (!prev) return false;
    this.undone.push(this.groups);
    this.groups = prev;
    return true;
  }

  redo(): boolean {
    const next = this.undone.pop();
    if (!next) return false;
    this.history.push(this.groups);
    this.groups = next;
    return true;
  }

  clear(): void {
    if (this.groups.length === 0) return;
    this.remember();
    this.groups = [];
  }

  /** For storing: the groups. */
  toJSON(): TerrainStroke[][] {
    return this.groups;
  }

  /** A stored draft (anything malformed: an empty one). */
  static parse(raw: unknown): TerraformDraft {
    try {
      if (!Array.isArray(raw)) return new TerraformDraft();
      const groups = raw.filter(Array.isArray) as unknown[][];
      validateStrokes(groups.flat());
      return new TerraformDraft(groups as TerrainStroke[][]);
    } catch {
      return new TerraformDraft();
    }
  }

  private remember(): void {
    this.history.push(this.groups.map((g) => [...g]));
    this.undone = [];
  }
}

/**
 * Where to put dabs painting from `from` to `to` (metres), `spacing` apart, after the last dab
 * at `from`: the points along the way (not `from` itself), and how far past the last one the
 * stroke has gone (carried into the next segment so dabs stay evenly spaced).
 */
export function dabsAlong(from: { x: number; z: number }, to: { x: number; z: number }, spacing: number, carried = 0): { points: { x: number; z: number }[]; carried: number } {
  const dx = to.x - from.x, dz = to.z - from.z, len = Math.hypot(dx, dz);
  const points: { x: number; z: number }[] = [];
  let d = spacing - carried;
  for (; d <= len; d += spacing) points.push({ x: from.x + (dx * d) / len, z: from.z + (dz * d) / len });
  return { points, carried: len - (d - spacing) };
}
