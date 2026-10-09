import { FIGURE_JOINTS, type FigureJoint } from './animations.js';
import { FIGURE_KINDS, type FigureKind } from './avatar.js';

/**
 * The mesh library (see the client's mesh editor): figures as edited by admins, one for every
 * world on the server; a figure not in it is as the game makes it (the man from his model file,
 * the woman reshaped from him: see playerFigure.ts). An edited figure is kept whole: each joint's
 * piece (flat triangles: x, y, z of each corner, m, from the joint), where each joint is (m,
 * standing, from between the feet), and its hair (m, from the head joint).
 */
export interface FigureMesh {
  parts: Record<FigureJoint, number[]>;
  pivots: Record<FigureJoint, [number, number, number]>;
  hair: number[];
}

export interface MeshLibrary {
  figures: Partial<Record<FigureKind, FigureMesh>>;
}

export const emptyMeshLibrary = (): MeshLibrary => ({ figures: {} });

/** Corners a piece may have at most (a few times the man's biggest). */
export const MAX_PIECE_CORNERS = 6000;

const isNum = (v: unknown, lim = 10): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;
const triangles = (v: unknown, what: string): number[] | string => {
  if (!Array.isArray(v) || v.length % 9 !== 0) return `${what}: whole triangles (nine numbers each)`;
  if (v.length / 3 > MAX_PIECE_CORNERS) return `${what}: at most ${MAX_PIECE_CORNERS} corners`;
  if (!v.every((n) => isNum(n, 3))) return `${what}: numbers (m, within 3 of its joint)`;
  return v as number[];
};

/** A mesh library from what was sent (every edited figure whole, every number sensible), or why it won't do. */
export function parseMeshLibrary(raw: unknown): MeshLibrary | string {
  if (typeof raw !== 'object' || raw === null) return 'not a mesh library';
  const figs = (raw as { figures?: unknown }).figures;
  if (typeof figs !== 'object' || figs === null) return 'figures: missing';
  const out: MeshLibrary = { figures: {} };
  for (const [kind, f] of Object.entries(figs)) {
    if (!(FIGURE_KINDS as readonly string[]).includes(kind)) return `figures: no figure "${kind}"`;
    if (typeof f !== 'object' || f === null) return `${kind}: not a figure`;
    const { parts, pivots, hair } = f as { parts?: Record<string, unknown>; pivots?: Record<string, unknown>; hair?: unknown };
    if (typeof parts !== 'object' || parts === null || typeof pivots !== 'object' || pivots === null) return `${kind}: parts and pivots, each joint's`;
    const fig = { parts: {}, pivots: {}, hair: [] } as unknown as FigureMesh;
    for (const j of FIGURE_JOINTS) {
      const t = triangles(parts[j], `${kind} ${j}`);
      if (typeof t === 'string') return t;
      fig.parts[j] = t;
      const p = pivots[j];
      if (!Array.isArray(p) || p.length !== 3 || !p.every((n) => isNum(n, 5))) return `${kind} ${j}: where it is (x, y, z, m)`;
      fig.pivots[j] = [p[0] as number, p[1] as number, p[2] as number];
    }
    const extra = [...Object.keys(parts), ...Object.keys(pivots)].find((k) => !(FIGURE_JOINTS as readonly string[]).includes(k));
    if (extra) return `${kind}: no joint "${extra}"`;
    const h = triangles(hair ?? [], `${kind} hair`);
    if (typeof h === 'string') return h;
    fig.hair = h;
    out.figures[kind as FigureKind] = fig;
  }
  return out;
}


