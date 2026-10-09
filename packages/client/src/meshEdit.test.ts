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
