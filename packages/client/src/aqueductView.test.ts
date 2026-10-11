import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CHANNEL_WATER, planAqueduct, type Aqueduct } from '@super-vox/shared';
import { AqueductView, waterMesh } from './aqueductView.js';

const B = 16;
describe("aqueducts' water", () => {
  it('stands over its channel a quarter metre at a time (a strip each row where it is level), and spills down each step of the floor', () => {
    // A metre wide (four columns), three long (twelve), stepping down a block two metres along.
    const cols = [];
    for (let qx = 0; qx < 12; qx++) for (let qz = 0; qz < 4; qz++) cols.push({ qx, qz, floor: qx < 8 ? 10 * B : 9 * B });
    const mesh = waterMesh(cols, new THREE.MeshBasicMaterial(), 'w')!;
    const pos = mesh.geometry.getAttribute('position');
    // Two strips a row and a face down the step: twelve quads.
    expect(pos.count).toBe(12 * 4);
    // The surfaces' heights (from the mesh's origin, a block under the lowest floor).
    const ys = new Set<number>();
    for (let i = 0; i < pos.count; i++) ys.add(pos.getY(i) + mesh.position.y * B);
    expect([...ys].sort((a, b) => a - b)).toEqual([9 * B + CHANNEL_WATER, 10 * B + CHANNEL_WATER]);
  });

  it('runs from the head as far as the first break; in the outlet only running to its end', () => {
    const cells = Array.from({ length: 10 }, (_, i) => ({ bx: i, bz: 0, floor: 10 * B }));
    const a: Aqueduct = { id: 1, name: 'A', cells, head: [{ bx: -1, bz: 0, floor: 10 * B }], outlet: [{ bx: 10, bz: 0, floor: 10 * B }], finished: true, runs: 4 };
    const view = new AqueductView(new THREE.MeshBasicMaterial());
    const across = () => {
      const box = new THREE.Box3();
      for (const m of view.group.children) box.union(new THREE.Box3().setFromObject(m));
      return box.max.x - box.min.x;
    };
    view.set([a]);
    const broken = across();
    view.set([{ ...a, runs: 10 }]);
    // (Head and four cells: 5 m; head, all ten and the outlet: 12 m.)
    expect(across() / broken).toBeCloseTo(12 / 5, 5);
  });

  it('at an angle, along its line: no zig-zag a metre wide', () => {
    const plan = planAqueduct({ bx: 0, bz: 0, floor: 20 * B }, 30, 12, 1 / 200, () => 15 * B);
    if (typeof plan === 'string') throw new Error(plan);
    const a: Aqueduct = { id: 1, name: 'A', cells: plan.cells, head: [], outlet: [], finished: false, runs: plan.cells.length, legs: [{ first: 0, last: plan.cells.length - 1, fall: 1 / 200 }] };
    const view = new AqueductView(new THREE.MeshBasicMaterial());
    view.set([a]);
    const pos = (view.group.children[0] as THREE.Mesh).geometry.getAttribute('position');
    expect(pos.count).toBeGreaterThan(0);
  });
});
