import * as THREE from 'three';
import type { FigureMesh } from '@super-vox/shared';
import { JOINTS, parentOf, type Joint } from './playerFigure.js';

/**
 * Editing a figure's mesh (the mesh editor's draft): its pieces (each joint's, and the hair, which
 * hangs on the head) as corners to move, or whole, to move, turn and scale about their joints, the
 * joints below following. Left and right kept alike if asked (see mirrorPairs). Kept on its feet
 * (see ground). Undo and redo. Pieces are flat triangles: a corner is every triangle's copy of the
 * same point.
 */
export type Piece = Joint | 'hair';
export const PIECES: readonly Piece[] = [...JOINTS, 'hair'];

/** A corner of a piece: where it is (m, from its joint), and which of the piece's numbers are its copies (x of each). */
export interface Corner {
  at: THREE.Vector3;
  copies: number[];
}

/** Corners this close (m) are the same one. */
const SAME = 1e-5;

const copy = (m: FigureMesh): FigureMesh => structuredClone(m);

/** The other side's piece (left for right), or itself (the middle's). */
export function mirrorOf(p: Piece): Piece {
  if (p.endsWith('L')) return p.slice(0, -1) + 'R' as Piece;
  if (p.endsWith('R')) return p.slice(0, -1) + 'L' as Piece;
  return p;
}

/** The joints hanging (at any remove) on `j`. */
export function below(j: Joint): Joint[] {
  const out: Joint[] = [];
  for (const k of JOINTS)
    for (let p = parentOf(k); p; p = parentOf(p))
      if (p === j) {
        out.push(k);
        break;
      }
  return out;
}

export class FigureEdit {
  mesh: FigureMesh;
  private readonly undos: FigureMesh[] = [];
  private readonly redos: FigureMesh[] = [];
  /** A drag going on: its changes one to undo (see beginDrag). */
  private dragging = false;
  private dragKept = false;

  constructor(mesh: FigureMesh) {
    this.mesh = copy(mesh);
  }

  /** Where a piece hangs (m, standing): its joint (the hair: the head's). */
  pivot(p: Piece): THREE.Vector3 {
    return new THREE.Vector3(...this.mesh.pivots[p === 'hair' ? 'head' : p]);
  }

  private numbers(p: Piece): number[] {
    return p === 'hair' ? this.mesh.hair : this.mesh.parts[p];
  }

  /** A piece's corners (each point once). */
  corners(p: Piece): Corner[] {
    const n = this.numbers(p), out: Corner[] = [], keyed = new Map<string, Corner>();
    for (let i = 0; i < n.length; i += 3) {
      const key = `${Math.round(n[i]! / SAME)},${Math.round(n[i + 1]! / SAME)},${Math.round(n[i + 2]! / SAME)}`;
      let c = keyed.get(key);
      if (!c) keyed.set(key, (c = { at: new THREE.Vector3(n[i], n[i + 1], n[i + 2]), copies: [] })), out.push(c);
      c.copies.push(i);
    }
    return out;
  }

  /**
   * Its other side's corner of each of piece `p`'s corners: each paired with the other side's piece's
   * nearest, mirrored about each piece's middle (the two sides of this figure aren't quite alike: its
   * legs stand differently), nearest pairs first, one each. A middle piece is its own other side.
   */
  mirrorPairs(p: Piece): Map<number, { piece: Piece; corner: number }> {
    const m = mirrorOf(p), mine = this.corners(p), theirs = this.corners(m);
    const centre = (cs: Corner[]) => cs.reduce((s, c) => s.add(c.at), new THREE.Vector3()).divideScalar(Math.max(1, cs.length));
    const a = centre(mine), b = centre(theirs);
    const pairs: { i: number; j: number; d: number }[] = [];
    mine.forEach((c, i) => {
      const x = -(c.at.x - a.x), y = c.at.y - a.y, z = c.at.z - a.z;
      theirs.forEach((t, j) => pairs.push({ i, j, d: Math.hypot(t.at.x - b.x - x, t.at.y - b.y - y, t.at.z - b.z - z) }));
    });
    pairs.sort((u, v) => u.d - v.d);
    const out = new Map<number, { piece: Piece; corner: number }>(), taken = new Set<number>();
    for (const { i, j } of pairs) {
      if (out.has(i) || taken.has(j)) continue;
      out.set(i, { piece: m, corner: j });
      taken.add(j);
    }
    return out;
  }

  /** The other side's corner of corner `i` of piece `p` (see mirrorPairs), if there's one. */
  mirrorCorner(p: Piece, i: number): { piece: Piece; corner: number } | null {
    return this.mirrorPairs(p).get(i) ?? null;
  }

  /** Something done (undoable: what was before kept). */
  private change(f: () => void): void {
    if (!this.dragging || !this.dragKept) {
      this.undos.push(copy(this.mesh));
      if (this.undos.length > 100) this.undos.shift();
      this.redos.length = 0;
      this.dragKept = this.dragging;
    }
    f();
    this.ground();
  }

  /** A drag begins (its changes, step by step, one change to undo) or ends. */
  beginDrag(): void {
    this.dragging = true;
    this.dragKept = false;
  }
  endDrag(): void {
    this.dragging = false;
  }

  /** On its feet: everything up or down so its lowest corner (standing) is on the ground, y 0. */
  private ground(): void {
    let low = Infinity;
    for (const p of PIECES) {
      const at = this.pivot(p).y, n = this.numbers(p);
      for (let i = 1; i < n.length; i += 3) low = Math.min(low, at + n[i]!);
    }
    if (!Number.isFinite(low) || Math.abs(low) < 1e-7) return;
    for (const j of JOINTS) this.mesh.pivots[j] = [this.mesh.pivots[j][0], this.mesh.pivots[j][1] - low, this.mesh.pivots[j][2]];
  }

  undo(): boolean {
    const was = this.undos.pop();
    if (!was) return false;
    this.redos.push(this.mesh);
    this.mesh = was;
    return true;
  }

  redo(): boolean {
    const next = this.redos.pop();
    if (!next) return false;
    this.undos.push(this.mesh);
    this.mesh = next;
    return true;
  }

  get canUndo(): boolean {
    return this.undos.length > 0;
  }
  get canRedo(): boolean {
    return this.redos.length > 0;
  }

  /**
   * Moves corners `which` of piece `p` by `by` (m); `mirror`: left and right kept alike. A left or
   * right piece's corners: their other side's the other way across. A middle piece's (its own other
   * side): across, the way the handle's moved on its side (the middle of those picked) and the
   * other way on the other side (dragged out: wider, both sides); on the middle, not across at all.
   * The corners as they were when `from` was taken (a drag: each step from where it began).
   */
  moveCorners(p: Piece, which: number[], by: THREE.Vector3, mirror: boolean, from: FigureMesh = this.mesh): void {
    this.change(() => {
      this.mesh = copy(from);
      const moves = new Map<string, { piece: Piece; corner: number; by: THREE.Vector3 }>();
      const add = (piece: Piece, corner: number, d: THREE.Vector3) => moves.set(`${piece}:${corner}`, { piece, corner, by: d });
      const pairs = mirror ? this.mirrorPairs(p) : null;
      if (pairs && mirrorOf(p) === p) {
        // A middle piece: which side each is on (of the piece's middle), and which the handle's.
        const cs = this.corners(p), mid = cs.reduce((t, c) => t + c.at.x, 0) / cs.length;
        const handle = which.reduce((t, i) => t + cs[i]!.at.x, 0) / Math.max(1, which.length) - mid;
        const side = handle < -1e-4 ? -1 : 1;
        for (const i of which) {
          const rel = cs[i]!.at.x - mid;
          add(p, i, new THREE.Vector3(Math.abs(rel) < 1e-3 ? 0 : Math.sign(rel) === side ? by.x : -by.x, by.y, by.z));
        }
      } else for (const i of which) add(p, i, by.clone());
      if (pairs)
        for (const i of which) {
          const m = pairs.get(i), mine = moves.get(`${p}:${i}`)!.by;
          if (!m || moves.has(`${m.piece}:${m.corner}`)) continue;
          add(m.piece, m.corner, new THREE.Vector3(-mine.x, mine.y, mine.z));
        }
      const cornersOf = new Map<Piece, Corner[]>();
      for (const { piece, corner, by: d } of moves.values()) {
        const cs = cornersOf.get(piece) ?? cornersOf.set(piece, this.corners(piece)).get(piece)!;
        const n = this.numbers(piece);
        for (const at of cs[corner]!.copies) (n[at] = n[at]! + d.x), (n[at + 1] = n[at + 1]! + d.y), (n[at + 2] = n[at + 2]! + d.z);
      }
    });
  }

  /** Which corner each of a piece's triangles' corners is (three a triangle; see corners). */
  private triangleCorners(p: Piece): number[][] {
    const cs = this.corners(p), at = new Map<number, number>();
    cs.forEach((c, i) => c.copies.forEach((n) => at.set(n, i)));
    const out: number[][] = [];
    for (let t = 0; t < this.numbers(p).length; t += 9) out.push([at.get(t)!, at.get(t + 3)!, at.get(t + 6)!]);
    return out;
  }

  /** The corners of the whole shapes corners `which` of piece `p` are in (everything joined to them by triangles). */
  shapeOf(p: Piece, which: number[]): number[] {
    const tris = this.triangleCorners(p), next = new Map<number, number[]>();
    for (const t of tris) for (const c of t) next.set(c, [...(next.get(c) ?? []), ...t]);
    const seen = new Set(which), todo = [...which];
    while (todo.length) for (const c of next.get(todo.pop()!) ?? []) if (!seen.has(c)) (seen.add(c), todo.push(c));
    return [...seen].sort((a, b) => a - b);
  }

  /**
   * Takes away the triangles of piece `p` whose corners are all among `which` (a whole shape picked:
   * it's gone); `mirror`: the other side's likewise (its corners' twins, see mirrorPairs). How many
   * triangles went.
   */
  deleteCorners(p: Piece, which: number[], mirror: boolean): number {
    let gone = 0;
    this.change(() => {
      const cut = (piece: Piece, corners: Set<number>) => {
        const tris = this.triangleCorners(piece), n = this.numbers(piece), keep: number[] = [];
        tris.forEach((t, k) => {
          if (t.every((c) => corners.has(c))) gone++;
          else keep.push(...n.slice(k * 9, k * 9 + 9));
        });
        if (piece === 'hair') this.mesh.hair = keep;
        else this.mesh.parts[piece] = keep;
      };
      const mine = new Set(which);
      // (The other side's first: its pairs are this piece's as it is.)
      const other = mirrorOf(p);
      if (mirror) {
        const pairs = this.mirrorPairs(p), theirs = new Set<number>();
        for (const i of which) {
          const m = pairs.get(i);
          if (m) theirs.add(m.corner);
        }
        if (other === p) for (const c of theirs) mine.add(c);
        else cut(other, theirs);
      }
      cut(p, mine);
    });
    return gone;
  }

  // --- Adding corners: splitting an edge, a face, or many (see split).

  /** Corner `i` of piece `p`'s twin across (its piece's), or null (see mirrorPairs). */
  private twin(p: Piece, i: number): number | null {
    return this.mirrorPairs(p).get(i)?.corner ?? null;
  }

  /** The corner of piece `p` at `at` (m, from its joint), if there's one (as near as the same: see corners). */
  cornerAt(p: Piece, at: THREE.Vector3): number {
    return this.corners(p).findIndex((c) => c.at.distanceTo(at) < 1e-4);
  }

  /**
   * Rebuilds piece `p`, each of its triangles as `f` makes it (from its corners, by index, and
   * where they are; it adds corners with `add`, giving their index): its triangles, each three
   * corner indices, in order (the way round kept).
   */
  private rebuild(p: Piece, f: (tri: [number, number, number], add: (at: THREE.Vector3) => number, at: THREE.Vector3[]) => [number, number, number][]): void {
    const at = this.corners(p).map((c) => c.at.clone()), tris = this.triangleCorners(p) as [number, number, number][];
    const keyed = new Map<string, number>();
    const add = (v: THREE.Vector3) => {
      const key = v.toArray().map((x) => Math.round(x * 1e6)).join(',');
      let i = keyed.get(key);
      if (i === undefined) keyed.set(key, (i = at.push(v.clone()) - 1));
      return i;
    };
    const out: number[] = [];
    for (const t of tris) for (const n of f(t, add, at)) for (const c of n) out.push(at[c]!.x, at[c]!.y, at[c]!.z);
    if (p === 'hair') this.mesh.hair = out;
    else this.mesh.parts[p] = out;
  }

  /** Halfway between two corners (the same whichever's first: the same new corner either side of the edge). */
  private static half(at: THREE.Vector3[], a: number, b: number): THREE.Vector3 {
    const [x, y] = a < b ? [at[a]!, at[b]!] : [at[b]!, at[a]!];
    return x.clone().add(y).multiplyScalar(0.5);
  }

  /**
   * Splits piece `p`'s triangles, each along those of its edges in `edges` (corner pairs): one: in
   * two; two: in three; all three: in four (a corner halfway along each). Every triangle on such
   * an edge is split there, so no gap opens.
   */
  private splitEdges(p: Piece, edges: [number, number][]): void {
    const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`), on = new Set(edges.map(([a, b]) => key(a, b)));
    this.rebuild(p, (t, add, at) => {
      // Which of its edges (t[i] to t[i + 1]) are split, and their halfway corners.
      const mid = [0, 1, 2].map((i) => (on.has(key(t[i]!, t[(i + 1) % 3]!)) ? add(FigureEdit.half(at, t[i]!, t[(i + 1) % 3]!)) : -1));
      const k = mid.filter((m) => m >= 0).length;
      if (k === 0) return [t];
      if (k === 3) {
        const [ab, bc, ca] = mid as [number, number, number], [A, B, C] = t;
        return [[A, ab, ca], [ab, B, bc], [ca, bc, C], [ab, bc, ca]];
      }
      // Turned so the first split edge starts the triangle (A to B; then B to C, if two).
      const r = k === 1 ? mid.findIndex((m) => m >= 0) : mid.findIndex((m, i) => m >= 0 && mid[(i + 1) % 3]! >= 0);
      const A = t[r]!, B = t[(r + 1) % 3]!, C = t[(r + 2) % 3]!, ab = mid[r]!, bc = mid[(r + 1) % 3]!;
      if (k === 1) return [[A, ab, C], [ab, B, C]];
      return [[ab, B, bc], [A, ab, bc], [A, bc, C]];
    });
  }

  /**
   * Splits the edge between corners `a` and `b` of piece `p` (they must share a triangle) with a
   * corner halfway; `mirror`: the other side's too. The new corner (its index), or -1 if they don't.
   */
  splitEdge(p: Piece, a: number, b: number, mirror: boolean): number {
    const tris = this.triangleCorners(p);
    if (a === b || !tris.some((t) => t.includes(a) && t.includes(b))) return -1;
    const mid = FigureEdit.half(this.corners(p).map((c) => c.at), a, b);
    const ta = mirror ? this.twin(p, a) : null, tb = mirror ? this.twin(p, b) : null, other = mirrorOf(p);
    this.change(() => {
      if (ta !== null && tb !== null && other !== p) this.splitEdges(other, [[ta, tb]]);
      this.splitEdges(p, other === p && ta !== null && tb !== null && !(new Set([ta, tb]).has(a) && new Set([ta, tb]).has(b)) ? [[a, b], [ta, tb]] : [[a, b]]);
    });
    return this.cornerAt(p, mid);
  }

  /**
   * Adds a corner to triangle `tri` of piece `p` (its index among them) at `at` (m, from its joint;
   * on it), in three triangles; `mirror`: the other side's twin triangle too, as far across it
   * (each corner's weight on its twin). The new corner (its index), or -1 if there's no such triangle.
   */
  addPoint(p: Piece, tri: number, at: THREE.Vector3, mirror: boolean): number {
    const t = this.triangleCorners(p)[tri];
    if (!t) return -1;
    const cs = this.corners(p).map((c) => c.at);
    // Where on it (how much of each corner), for its twin's to be as far across.
    const w = new THREE.Vector3();
    new THREE.Triangle(cs[t[0]!]!, cs[t[1]!]!, cs[t[2]!]!).getBarycoord(at, w);
    const weights = [w.x, w.y, w.z];
    const other = mirrorOf(p), twins = mirror ? t.map((c) => this.twin(p, c)) : null;
    const same = (a: number[], b: number[]) => a.every((c) => b.includes(c)) && b.every((c) => a.includes(c));
    /** Splits, in `piece`, each triangle with these corners (each corner its weight) at the point they make. */
    const splitAt = (piece: Piece, points: number[][]) =>
      this.rebuild(piece, (u, add, pos) => {
        const corners = points.find((c) => same(c, u));
        if (!corners) return [u];
        const m = add(corners.reduce((v, c, k) => v.add(pos[c]!.clone().multiplyScalar(weights[k]!)), new THREE.Vector3()));
        return [[u[0], u[1], m], [u[1], u[2], m], [u[2], u[0], m]];
      });
    const made = cs[t[0]!]!.clone().multiplyScalar(w.x).add(cs[t[1]!]!.clone().multiplyScalar(w.y)).add(cs[t[2]!]!.clone().multiplyScalar(w.z));
    const twin = twins && twins.every((c) => c !== null) ? (twins as number[]) : null;
    this.change(() => {
      // (A middle piece: both in one go, its corners numbered as they are; another: each its own.)
      if (twin && other !== p) splitAt(other, [twin]);
      splitAt(p, twin && other === p && !same(twin, t) ? [t, twin] : [t]);
    });
    return this.cornerAt(p, made);
  }

  /**
   * Splits each of piece `p`'s triangles whose corners are all among `which` in four (a corner
   * halfway along each edge; those beside them split along the edges they share, so no gap
   * opens); `mirror`: the other side's likewise. How many were split.
   */
  subdivide(p: Piece, which: number[], mirror: boolean): number {
    const tris = this.triangleCorners(p), picked = new Set(which);
    const chosen = tris.filter((t) => t.every((c) => picked.has(c)));
    if (!chosen.length) return 0;
    const edges = (ts: number[][]) => ts.flatMap((t) => [0, 1, 2].map((i) => [t[i]!, t[(i + 1) % 3]!] as [number, number]));
    const other = mirrorOf(p);
    const twinTris = mirror ? chosen.map((t) => t.map((c) => this.twin(p, c))).filter((t): t is number[] => t.every((c) => c !== null)) : [];
    this.change(() => {
      if (twinTris.length && other !== p) this.splitEdges(other, edges(twinTris));
      this.splitEdges(p, edges(other === p ? [...chosen, ...twinTris] : chosen));
    });
    return chosen.length;
  }

  /**
   * Moves, turns or scales piece `p` (its corners, about its joint) by `m`, the joints below it
   * following (their pieces with them): where each that hangs right on it goes as `m` takes it,
   * and the rest below as that one does. Its joint itself moves by `m`'s moving part (a piece moved:
   * everything below with it). `mirror`: its other side's piece likewise, the other way across.
   */
  transformPiece(p: Piece, m: THREE.Matrix4, mirror: boolean, from: FigureMesh = this.mesh): void {
    this.change(() => {
      this.mesh = copy(from);
      this.applyTo(p, m);
      const other = mirrorOf(p);
      if (mirror && other !== p) {
        const flip = new THREE.Matrix4().makeScale(-1, 1, 1);
        this.applyTo(other, flip.clone().multiply(m).multiply(flip));
      }
    });
  }

  private applyTo(p: Piece, m: THREE.Matrix4): void {
    const move = new THREE.Vector3().setFromMatrixPosition(m), turn = m.clone().setPosition(0, 0, 0);
    // (The hair hangs on the head: moved, it's its corners that move.)
    const n = this.numbers(p), v = new THREE.Vector3(), corners = p === 'hair' ? m : turn;
    for (let i = 0; i < n.length; i += 3) {
      v.set(n[i]!, n[i + 1]!, n[i + 2]!).applyMatrix4(corners);
      (n[i] = v.x), (n[i + 1] = v.y), (n[i + 2] = v.z);
    }
    if (p === 'hair') return;
    const at = this.pivot(p), shift = (j: Joint, d: THREE.Vector3) => {
      const q = this.mesh.pivots[j];
      this.mesh.pivots[j] = [q[0] + d.x, q[1] + d.y, q[2] + d.z];
    };
    // Itself (and all below) moved; those right on it, as its turning and scaling take them (and theirs with them).
    for (const j of [p, ...below(p)]) shift(j, move);
    for (const c of JOINTS.filter((k) => parentOf(k) === p)) {
      const rel = this.pivot(c).sub(at).sub(move), next = rel.clone().applyMatrix4(turn), d = next.sub(rel);
      for (const j of [c, ...below(c)]) shift(j, d);
    }
  }

  /** The mesh as it is (to save, or to drag from: see moveCorners, transformPiece). */
  snapshot(): FigureMesh {
    return copy(this.mesh);
  }
}
