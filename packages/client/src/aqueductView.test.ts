import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CHANNEL_WATER, type Aqueduct } from '@super-vox/shared';
import { AqueductView, waterMesh } from './aqueductView.js';

const B = 16;
describe("aqueducts' water", () => {
  it('stands over each cell, and spills down each step of the floor', () => {
    const cells = [{ bx: 0, bz: 0, floor: 10 * B }, { bx: 1, bz: 0, floor: 10 * B }, { bx: 2, bz: 0, floor: 9 * B }];
    const mesh = waterMesh(cells, new THREE.MeshBasicMaterial(), 'w')!;
    const pos = mesh.geometry.getAttribute('position');
    // Three surfaces and one step's face: four quads.
    expect(pos.count).toBe(16);
    // The surfaces' heights (from the mesh's origin, a block under the lowest floor).
    const ys = new Set<number>();
    for (let i = 0; i < pos.count; i++) ys.add(pos.getY(i) + mesh.position.y * B);
    expect([...ys].sort((a, b) => a - b)).toEqual([9 * B + CHANNEL_WATER, 10 * B + CHANNEL_WATER]);
  });

  it('runs from the head as far as the first break; in the outlet only running to its end', () => {
    const cells = Array.from({ length: 10 }, (_, i) => ({ bx: i, bz: 0, floor: 10 * B }));
    const a: Aqueduct = { id: 1, name: 'A', cells, head: [{ bx: -1, bz: 0, floor: 10 * B }], outlet: [{ bx: 10, bz: 0, floor: 10 * B }], finished: true, runs: 4 };
    const view = new AqueductView(new THREE.MeshBasicMaterial());
    const quads = () => view.group.children.reduce((n, m) => n + (m as THREE.Mesh).geometry.getAttribute('position').count / 4, 0);
    view.set([a]);
    expect(quads()).toBe(1 + 4);
    view.set([{ ...a, runs: 10 }]);
    expect(quads()).toBe(1 + 10 + 1);
  });
});
