import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PlayerAct, defaultAvatar, parseMeshLibrary } from '@super-vox/shared';
import { FigureEdit, below, mirrorOf } from './meshEdit.js';
import { PlayerFigure, fromMesh, madeModel, setMeshes, strides, toMesh } from './playerFigure.js';
import { FigureMotion } from './entities.js';

void PlayerAct;
void FigureMotion;

const man = () => new FigureEdit(toMesh(madeModel('man')));
const v3 = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);

describe('editing a figure', () => {
  it('knows its pieces corners (each point once), the other side of each, and what hangs below what', () => {
    const e = man();
    expect(e.corners('chest').length).toBe(26);
    expect(mirrorOf('kneeL')).toBe('kneeR');
    expect(mirrorOf('head')).toBe('head');
    expect(below('shoulderL').sort()).toEqual(['elbowL', 'wristL']);
    expect(below('hips').length).toBe(16);
    // A left elbow's corner: the right elbow's, mirrored (about the elbow: these are alike, mirrored).
    const m = e.mirrorCorner('elbowL', 0)!;
    expect(m.piece).toBe('elbowR');
    const a = e.corners('elbowL')[0]!.at, b = e.corners('elbowR')[m.corner]!.at;
    expect(a.x).toBeCloseTo(-b.x, 4);
    expect(a.y).toBeCloseTo(b.y, 4);
    // Every corner has one, each its own, even where the sides differ (his ankles do, by centimetres).
    for (const p of ['ankleL', 'kneeL', 'shoulderL', 'chest', 'head'] as const) {
      const pairs = e.mirrorPairs(p);
      expect(pairs.size, p).toBe(e.corners(p).length);
      expect(new Set([...pairs.values()].map((x) => x.corner)).size, p).toBe(pairs.size);
    }
  });

  it('moves corners (every copy of each), the other side the other way across; one on the middle only up, down and along', () => {
    const e = man(), by = new THREE.Vector3(0.02, 0.01, -0.005);
    const m = e.mirrorCorner('elbowL', 3)!;
    const before = e.corners('elbowL')[3]!.at.clone(), theirs = e.corners('elbowR')[m.corner]!.at.clone();
    e.moveCorners('elbowL', [3], by, true);
    expect(e.corners('elbowL')[3]!.at.clone().sub(before).toArray().map((v) => Number(v.toFixed(6)))).toEqual([0.02, 0.01, -0.005]);
    expect(e.corners('elbowR')[m.corner]!.at.clone().sub(theirs).toArray().map((v) => Number(v.toFixed(6)))).toEqual([-0.02, 0.01, -0.005]);
    // The chest's front middle corner (x 0): its own other side.
    const e2 = man(), mid = e2.corners('chest').findIndex((c) => Math.abs(c.at.x + e2.pivot('chest').x - e2.mesh.pivots.hips[0]) < 0.002 && c.at.z < -0.1);
    expect(mid).toBeGreaterThanOrEqual(0);
    const was = e2.corners('chest')[mid]!.at.clone();
    e2.moveCorners('chest', [mid], by, true);
    expect(e2.corners('chest')[mid]!.at.clone().sub(was).toArray().map((v) => Number(v.toFixed(6)))).toEqual([0, 0.01, -0.005]);
    // A middle piece, all of it picked, dragged across: wider, both sides alike (the middle stays).
    const e4 = man(), cs = e4.corners('head'), mid4 = cs.reduce((t, c) => t + c.at.x, 0) / cs.length;
    const width = (ed: FigureEdit) => Math.max(...ed.corners('head').map((c) => c.at.x)) - Math.min(...ed.corners('head').map((c) => c.at.x));
    const w0 = width(e4);
    e4.moveCorners('head', cs.map((_, i) => i), new THREE.Vector3(0.01, 0, 0), true);
    expect(width(e4)).toBeCloseTo(w0 + 0.02, 5);
    const after = e4.corners('head');
    expect(after.reduce((t, c) => t + c.at.x, 0) / after.length).toBeCloseTo(mid4, 5);
    // Not mirrored: the other side as it was.
    const e3 = man(), r = e3.corners('elbowR')[m.corner]!.at.clone();
    e3.moveCorners('elbowL', [3], by, false);
    expect(e3.corners('elbowR')[m.corner]!.at.equals(r)).toBe(true);
  });

  it('scales a piece about its joint, the joints below following (a longer thigh: the knee and ankle lower), both sides', () => {
    const e = man(), knee = v3(e.mesh.pivots.kneeL), ankle = v3(e.mesh.pivots.ankleL), hip = v3(e.mesh.pivots.legL);
    const kneeR = v3(e.mesh.pivots.kneeR), hipR = v3(e.mesh.pivots.legR);
    e.transformPiece('legL', new THREE.Matrix4().makeScale(1, 1.2, 1), true);
    // (Measured from the hip: the whole figure stands up again on its longer legs, see ground.)
    const dropped = (knee.y - hip.y) * 0.2; // (negative: the knee's below the hip)
    const hipNow = e.mesh.pivots.legL[1];
    expect(e.mesh.pivots.kneeL[1] - hipNow).toBeCloseTo(knee.y - hip.y + dropped, 5);
    expect(e.mesh.pivots.ankleL[1] - hipNow).toBeCloseTo(ankle.y - hip.y + dropped, 5);
    // The right too (its own knee: his legs aren't quite alike).
    expect(e.mesh.pivots.kneeR[1] - e.mesh.pivots.legR[1]).toBeCloseTo((kneeR.y - hipR.y) * 1.2, 5);
    // Standing on them: taller by as much.
    expect(hipNow).toBeGreaterThan(hip.y + 0.05);
    // Undone, redone.
    const after = e.mesh.pivots.kneeL[1];
    expect(e.undo()).toBe(true);
    expect(e.mesh.pivots.kneeL[1]).toBeCloseTo(knee.y, 6);
    expect(e.redo()).toBe(true);
    expect(e.mesh.pivots.kneeL[1]).toBeCloseTo(after, 6);
  });

  it('moves a piece with everything below it (a shoulder: the whole arm), the other side the other way', () => {
    const e = man(), wristL = v3(e.mesh.pivots.wristL), wristR = v3(e.mesh.pivots.wristR), chest = v3(e.mesh.pivots.chest);
    e.transformPiece('shoulderL', new THREE.Matrix4().makeTranslation(0.03, 0, 0), true);
    expect(e.mesh.pivots.wristL[0]).toBeCloseTo(wristL.x + 0.03, 6);
    expect(e.mesh.pivots.wristR[0]).toBeCloseTo(wristR.x - 0.03, 6);
    expect(v3(e.mesh.pivots.chest).distanceTo(chest)).toBeLessThan(1e-4); // (kept to a hundredth of a millimetre)
  });

  it('as the figures in play (saved, sent, taken): drawn so, its strides its own; the woman made from the man as edited', () => {
    const e = man();
    e.transformPiece('legL', new THREE.Matrix4().makeScale(1, 1.15, 1), true);
    e.transformPiece('kneeL', new THREE.Matrix4().makeScale(1, 1.15, 1), true);
    const lib = parseMeshLibrary(JSON.parse(JSON.stringify({ figures: { man: e.snapshot() } })));
    expect(typeof lib).not.toBe('string');
    const before = strides().walk, f = new PlayerFigure(defaultAvatar('x')), tall = f.height, herTall = new PlayerFigure({ ...defaultAvatar('x'), figure: 'woman' }).height;
    try {
      setMeshes(lib as Exclude<typeof lib, string>);
      // (Taken at its next pose.)
      f.pose({ joints: {}, lean: 0, lift: 0 } as never);
      expect(f.height).toBeGreaterThan(tall + 0.05);
      expect(new PlayerFigure({ ...defaultAvatar('x'), figure: 'woman' }).height).toBeGreaterThan(herTall + 0.04);
      expect(strides().walk).toBeGreaterThan(before * 1.05);
      // Back to as made.
      setMeshes({ figures: {} });
      expect(strides().walk).toBeCloseTo(before, 6);
    } finally {
      setMeshes({ figures: {} });
    }
    // A model and its mesh: the same, there and back.
    const m = madeModel('woman'), again = fromMesh(toMesh(m));
    expect(again.pivots.get('kneeR')!.distanceTo(m.pivots.get('kneeR')!)).toBeLessThan(1e-4);
    expect(again.parts.get('chest')!.getAttribute('position').count).toBe(m.parts.get('chest')!.getAttribute('position').count);
    expect(again.hair!.getAttribute('position').count).toBe(m.hair!.getAttribute('position').count);
  });
});

describe('shapes', () => {
  it("picks a whole shape from a corner of it, and takes it away (the other side's too, mirrored)", () => {
    // A piece of two shapes: the man's chest, and a little pyramid stuck on its front (each side).
    const e = man(), pyramid = (x: number) => {
      const a = [x, 0.15, -0.14], b = [x + 0.02, 0.13, -0.12], c = [x - 0.02, 0.13, -0.12], d = [x, 0.17, -0.12];
      return [a, b, c, a, c, d, a, d, b, b, d, c].flat();
    };
    const chest = e.mesh.parts.chest.length;
    e.mesh.parts.chest = [...e.mesh.parts.chest, ...pyramid(0.07), ...pyramid(-0.07)];
    const corners = e.corners('chest');
    const tip = corners.findIndex((c) => Math.abs(c.at.x - 0.07) < 1e-6 && Math.abs(c.at.z + 0.14) < 1e-6);
    const shape = e.shapeOf('chest', [tip]);
    expect(shape.length).toBe(4);
    expect(e.deleteCorners('chest', shape, true)).toBe(8); // (both pyramids: four triangles each)
    expect(e.mesh.parts.chest.length).toBe(chest);
    // Not all of a triangle's corners picked: it stays.
    expect(e.deleteCorners('chest', [0], false)).toBe(0);
    expect(e.undo()).toBe(true);
    expect(e.undo()).toBe(true);
    expect(e.mesh.parts.chest.length).toBe(chest + 2 * 36);
  });

  it("the woman's chest: her own corners (no shapes stuck on it)", () => {
    const e = new FigureEdit(toMesh(madeModel('woman'))), all = e.corners('chest').map((_, i) => i);
    expect(e.shapeOf('chest', [0]).length).toBe(all.length);
    expect(all.length).toBe(new FigureEdit(toMesh(madeModel('man'))).corners('chest').length);
  });
});

describe('adding corners', () => {
  /** A piece's triangles, by corner, and its edges used by one triangle only (open: a gap, or its edge). */
  const shape = (e: FigureEdit, p: 'chest' | 'head' | 'elbowL' | 'elbowR') => {
    const cs = e.corners(p), at = new Map<number, number>();
    cs.forEach((c, i) => c.copies.forEach((n) => at.set(n, i)));
    const n = p === 'chest' || p === 'head' ? e.mesh.parts[p] : e.mesh.parts[p];
    const tris: number[][] = [];
    for (let t = 0; t < n.length; t += 9) tris.push([at.get(t)!, at.get(t + 3)!, at.get(t + 6)!]);
    const count = new Map<string, number>();
    for (const t of tris) for (let i = 0; i < 3; i++) {
      const [a, b] = [t[i]!, t[(i + 1) % 3]!], k = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
    return { corners: cs.length, triangles: tris.length, open: [...count.values()].filter((v) => v === 1).length, tris };
  };

  it('splits an edge halfway (both triangles on it), the other side too; not two corners with no edge between', () => {
    const e = man(), before = shape(e, 'elbowL'), theirs = shape(e, 'elbowR');
    const [a, b] = before.tris[0]!;
    const mid = e.corners('elbowL')[a!]!.at.clone().add(e.corners('elbowL')[b!]!.at).multiplyScalar(0.5);
    const made = e.splitEdge('elbowL', a!, b!, true);
    expect(e.corners('elbowL')[made]!.at.distanceTo(mid)).toBeLessThan(1e-6);
    const after = shape(e, 'elbowL');
    expect(after.corners).toBe(before.corners + 1);
    expect(after.open).toBe(before.open);
    // (Every triangle on that edge split in two: one or two of them.)
    expect(after.triangles - before.triangles).toBeGreaterThanOrEqual(1);
    expect(shape(e, 'elbowR').corners).toBe(theirs.corners + 1);
    expect(shape(e, 'elbowR').open).toBe(theirs.open);
    // Two corners with no edge between: nothing.
    const e2 = man(), pair = (() => {
      const st = shape(e2, 'chest');
      for (let x = 0; x < st.corners; x++) for (let y = x + 1; y < st.corners; y++) if (!st.tris.some((t) => t.includes(x) && t.includes(y))) return [x, y];
      return [0, 0];
    })();
    expect(e2.splitEdge('chest', pair[0]!, pair[1]!, true)).toBe(-1);
    expect(e2.canUndo).toBe(false);
  });

  it('adds a corner in a face where it was clicked (three triangles), its twin as far across the other side', () => {
    const e = man(), before = shape(e, 'head');
    // A triangle off the middle (its twin another triangle).
    const cs = e.corners('head'), tri = before.tris.findIndex((t) => t.every((c) => cs[c]!.at.x > 0.01));
    expect(tri).toBeGreaterThanOrEqual(0);
    const t = before.tris[tri]!, at = cs[t[0]!]!.at.clone().multiplyScalar(0.5).add(cs[t[1]!]!.at.clone().multiplyScalar(0.3)).add(cs[t[2]!]!.at.clone().multiplyScalar(0.2));
    const made = e.addPoint('head', tri, at, true);
    expect(e.corners('head')[made]!.at.distanceTo(at)).toBeLessThan(1e-6);
    const after = shape(e, 'head');
    expect(after.corners).toBe(before.corners + 2);
    expect(after.triangles).toBe(before.triangles + 4);
    expect(after.open).toBe(before.open);
    // Its twin: mirrored about the head's middle, near enough (the head's alike both sides).
    const mid = cs.reduce((v, c) => v + c.at.x, 0) / cs.length;
    expect(e.corners('head').some((c) => Math.abs(c.at.x - (2 * mid - at.x)) < 1e-4 && Math.abs(c.at.y - at.y) < 1e-4 && Math.abs(c.at.z - at.z) < 1e-4)).toBe(true);
    expect(e.undo()).toBe(true);
    expect(shape(e, 'head')).toMatchObject({ corners: before.corners, triangles: before.triangles });
  });

  it('subdivides picked triangles in four (their neighbours split along the edges they share: no gap)', () => {
    const e = man(), before = shape(e, 'chest');
    const t = before.tris[3]!;
    expect(e.subdivide('chest', t, false)).toBe(1);
    const after = shape(e, 'chest');
    expect(after.corners).toBe(before.corners + 3);
    expect(after.open).toBe(before.open);
    expect(after.triangles).toBeGreaterThanOrEqual(before.triangles + 3);
    // Nothing picked whole: nothing done.
    expect(e.subdivide('chest', [t[0]!], false)).toBe(0);
  });
});

describe('the mesh library', () => {
  it('takes whole figures only, of sensible numbers', () => {
    const mesh = toMesh(madeModel('man'));
    expect(parseMeshLibrary({ figures: { man: mesh } })).toMatchObject({ figures: { man: { hair: mesh.hair } } });
    expect(parseMeshLibrary({ figures: { dragon: mesh } })).toMatch(/dragon/);
    const { kneeL: _gone, ...noKnee } = mesh.parts;
    void _gone;
    expect(parseMeshLibrary({ figures: { man: { ...mesh, parts: noKnee } } })).toMatch(/kneeL/);
    expect(parseMeshLibrary({ figures: { man: { ...mesh, hair: [1, 2] } } })).toMatch(/hair/);
    expect(parseMeshLibrary({ figures: { man: { ...mesh, pivots: { ...mesh.pivots, head: [0, Number.NaN, 0] } } } })).toMatch(/head/);
  });
});
