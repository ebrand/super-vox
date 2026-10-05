import type { Claim } from './claims.js';
import type { DesignPiece, ObjectDesign } from './designs.js';

/**
 * A plan for a claimed plot (see Claim): what its owner means to build on it, laid out on the
 * ground before anything is built. For now walls (straight runs, carried on from one another),
 * towers and buildings (footprints with a pitched roof); positions in whole metres, inside the plot.
 */
export type PlanElement =
  | { kind: 'wall'; id: string; x0: number; z0: number; x1: number; z1: number; thickness: number; height: number; design?: string }
  | { kind: 'tower'; id: string; x: number; z: number; radius: number; height: number; design?: string }
  | { kind: 'building'; id: string; x0: number; z0: number; x1: number; z1: number; height: number; design?: string };

/** The piece of a keep (see DesignPiece) each kind of element is made of. */
export const PLAN_PIECE: Record<PlanElement['kind'], DesignPiece> = { wall: 'wall', tower: 'tower', building: 'building' };

export type PlanKind = PlanElement['kind'];

export interface Plan {
  elements: PlanElement[];
}

/** Sizes (m): [least, most, new ones'] per kind and measure. */
export const PLAN_LIMITS = {
  wall: { thickness: [1, 16, 2], height: [1, 30, 6] },
  tower: { radius: [1, 20, 4], height: [1, 50, 12] },
  building: { height: [1, 30, 6] },
} as const;
/** Most elements in a plan. */
export const MAX_PLAN_ELEMENTS = 500;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: unknown, [lo, hi]: readonly number[]) => isNum(v) && v >= lo! && v <= hi!;
const whole = (...vs: unknown[]) => vs.every((v) => isNum(v) && Number.isInteger(v));

/** Why `plan` can't be the plan of `plot` (metres); null if it can. */
export function refusePlan(plan: unknown, plot: Pick<Claim, 'x0' | 'z0' | 'x1' | 'z1'>): string | null {
  const p = plan as Plan;
  if (typeof p !== 'object' || p === null || !Array.isArray(p.elements)) return 'a plan is a list of elements';
  if (p.elements.length > MAX_PLAN_ELEMENTS) return `a plan has at most ${MAX_PLAN_ELEMENTS} elements`;
  const inside = (x: number, z: number) => x >= plot.x0 && x <= plot.x1 && z >= plot.z0 && z <= plot.z1;
  const ids = new Set<string>();
  for (const e of p.elements as unknown[]) {
    const el = e as PlanElement;
    if (typeof el !== 'object' || el === null || typeof el.id !== 'string' || !el.id || el.id.length > 40) return 'each element needs an id';
    if (ids.has(el.id)) return `two elements are "${el.id}"`;
    ids.add(el.id);
    if (el.design !== undefined && (typeof el.design !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(el.design))) return 'an element is made of a design with no good id';
    if (el.kind === 'wall') {
      const L = PLAN_LIMITS.wall;
      if (!whole(el.x0, el.z0, el.x1, el.z1)) return 'walls run between whole metres';
      if (el.x0 === el.x1 && el.z0 === el.z1) return 'a wall needs a length';
      if (!inRange(el.thickness, L.thickness) || !inRange(el.height, L.height)) return `walls are ${L.thickness[0]}-${L.thickness[1]} m thick and ${L.height[0]}-${L.height[1]} m high`;
      if (!inside(el.x0, el.z0) || !inside(el.x1, el.z1)) return 'every wall must be inside the plot';
    } else if (el.kind === 'tower') {
      const L = PLAN_LIMITS.tower;
      if (!whole(el.x, el.z)) return 'towers stand on whole metres';
      if (!inRange(el.radius, L.radius) || !inRange(el.height, L.height)) return `towers are ${L.radius[0]}-${L.radius[1]} m across (radius) and ${L.height[0]}-${L.height[1]} m high`;
      if (!inside(el.x - el.radius, el.z - el.radius) || !inside(el.x + el.radius, el.z + el.radius)) return 'every tower must be inside the plot';
    } else if (el.kind === 'building') {
      if (!whole(el.x0, el.z0, el.x1, el.z1)) return 'buildings stand on whole metres';
      if (el.x1 - el.x0 < 1 || el.z1 - el.z0 < 1) return 'a building is at least 1 m a side';
      if (!inRange(el.height, PLAN_LIMITS.building.height)) return `buildings are ${PLAN_LIMITS.building.height[0]}-${PLAN_LIMITS.building.height[1]} m high`;
      if (!inside(el.x0, el.z0) || !inside(el.x1, el.z1)) return 'every building must be inside the plot';
    } else return `unknown element "${String((el as { kind?: unknown }).kind)}"`;
  }
  return null;
}

/** A plan (checked with refusePlan) with just the fields each element has: nothing else kept. */
export function cleanPlan(plan: Plan): Plan {
  return {
    elements: plan.elements.map((e): PlanElement => {
      const design = e.design ? { design: e.design } : {};
      if (e.kind === 'wall') return { kind: 'wall', id: e.id, x0: e.x0, z0: e.z0, x1: e.x1, z1: e.z1, thickness: e.thickness, height: e.height, ...design };
      if (e.kind === 'tower') return { kind: 'tower', id: e.id, x: e.x, z: e.z, radius: e.radius, height: e.height, ...design };
      return { kind: 'building', id: e.id, x0: e.x0, z0: e.z0, x1: e.x1, z1: e.z1, height: e.height, ...design };
    }),
  };
}

/**
 * An element made of `design` (a piece of its kind): its size follows it. A wall: the design is its
 * top (see wallCap), so the wall is at least as high as the design (any higher, built solid below
 * it), and its depth (front to back) is the wall's thickness. A tower: as high, as wide across as
 * its footprint's longer side (round, for now). A building: its footprint (from the same corner)
 * and height. Null: none (`design` null takes the design away, sizes kept).
 */
export function madeOf(e: PlanElement, design: Pick<ObjectDesign, 'id' | 'size'> | null): PlanElement {
  if (!design) {
    const { design: _, ...rest } = e;
    return rest as PlanElement;
  }
  const [w, h, d] = design.size;
  if (e.kind === 'wall') return { ...e, design: design.id, height: Math.max(e.height, h), thickness: d };
  if (e.kind === 'tower') return { ...e, design: design.id, height: h, radius: Math.max(w, d) / 2 };
  return { ...e, design: design.id, height: h, x1: e.x0 + w, z1: e.z0 + d };
}

/** How much of the top of a wall made of `design` is the design itself (m): its height; the rest, below, is built solid. */
export function wallCap(design: Pick<ObjectDesign, 'size'>): number {
  return design.size[1];
}

/** What a plan comes to: its walls' length, towers, and buildings' floor area (m, m²). */
export function planTotals(plan: Plan): { wallLength: number; towers: number; buildings: number; floorArea: number } {
  let wallLength = 0, towers = 0, buildings = 0, floorArea = 0;
  for (const e of plan.elements) {
    if (e.kind === 'wall') wallLength += Math.hypot(e.x1 - e.x0, e.z1 - e.z0);
    else if (e.kind === 'tower') towers++;
    else {
      buildings++;
      floorArea += (e.x1 - e.x0) * (e.z1 - e.z0);
    }
  }
  return { wallLength, towers, buildings, floorArea };
}
