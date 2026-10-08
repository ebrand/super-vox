import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Material, blockFromVoxels, blockIndex, chunkWithoutWater, emptyChunk, setBlockWater } from '@super-vox/shared';
import { visibleFaces } from './mesher.js';
import { GRASS_TOP_FIELDS, grassTops } from './grassTops.js';
import { GRASS_RANGE, GrassField, bladeGeometry } from './grassField.js';
import { createAtmosphere } from './atmosphere.js';
import { createVoxelMaterial } from './voxelMaterial.js';

const NONE = [null, null, null, null, null, null];
/** The tops grass blades grow on in `chunk`, as the mesh worker finds them. */
const topsOf = (chunk: ReturnType<typeof emptyChunk>) => grassTops(visibleFaces(chunkWithoutWater(chunk), NONE), chunk);
const entries = (d: Uint16Array | null) => (d ? Array.from({ length: d.length / GRASS_TOP_FIELDS }, (_, i) => Array.from(d.slice(i * GRASS_TOP_FIELDS, (i + 1) * GRASS_TOP_FIELDS))) : []);

describe('grassTops', () => {
  it('finds the open tops of grass and dry grass only, with their light, and none under water', () => {
    const c = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    c.blocks[blockIndex(1, 1, 1)] = { kind: 'uniform', size: 16, material: Material.Grass };
    c.blocks[blockIndex(2, 1, 1)] = { kind: 'uniform', size: 16, material: Material.DryGrass };
    c.blocks[blockIndex(3, 1, 1)] = { kind: 'uniform', size: 16, material: Material.Stone };
    // Grass under a stone (no top open), and grass under water.
    c.blocks[blockIndex(5, 1, 1)] = { kind: 'uniform', size: 16, material: Material.Grass };
    c.blocks[blockIndex(5, 2, 1)] = { kind: 'uniform', size: 16, material: Material.Stone };
    c.blocks[blockIndex(7, 1, 1)] = { kind: 'uniform', size: 16, material: Material.Grass };
    c.blocks[blockIndex(7, 2, 1)] = setBlockWater(null, 0);
    // Quarter-metre grass with a plank on one corner of it.
    c.blocks[blockIndex(9, 1, 1)] = blockFromVoxels([
      { x: 0, y: 12, z: 0, size: 4, material: Material.Grass },
      { x: 4, y: 12, z: 0, size: 4, material: Material.Grass },
      { x: 0, y: 0, z: 0, size: 4, material: Material.Stone },
    ]);
    c.blocks[blockIndex(9, 2, 1)] = blockFromVoxels([{ x: 0, y: 0, z: 0, size: 4, material: Material.Planks }]);
    const e = entries(topsOf(c));
    expect(e).toContainEqual([16, 32, 16, 16, 16, 255, 0, 0]);
    expect(e).toContainEqual([32, 32, 16, 16, 16, 255, 0, 1]);
    expect(e.some(([x]) => x === 48 || x === 80 || x === 112)).toBe(false);
    // Of the quarter metres, the one under the plank's not open; the other is (x 148..152).
    expect(e.filter(([x]) => x! >= 144 && x! < 160)).toEqual([[148, 32, 16, 4, 4, 255, 0, 0]]);
  });
});

describe('GrassField', () => {
  const material = () => createVoxelMaterial(createAtmosphere(1000));
  it('gives blades to the chunks near the eye (a patch to each 1/4 m), and lets them go far off', () => {
    const scene = new THREE.Scene();
    const field = new GrassField(scene, material());
    // A 1 m grass top and a 3/8 x 1/4 m one (an odd size: its patches as big as fit).
    field.setTops('0,0,0', { x: 0, y: 0, z: 0 }, Uint16Array.from([16, 32, 16, 16, 16, 255, 0, 0, 40, 32, 16, 6, 4, 200, 10, 1]));
    field.setTops('9,0,0', { x: 9 * 256, y: 0, z: 0 }, Uint16Array.from([0, 32, 0, 16, 16, 255, 0, 0]));
    field.update(new THREE.Vector3(1, 3, 1));
    expect(field.stats).toEqual({ chunks: 1, patches: 16 + 2 });
    const mesh = scene.getObjectByName('grass 0,0,0') as THREE.Mesh;
    const g = mesh.geometry as THREE.InstancedBufferGeometry;
    // The odd one: patches 4 x 4 and 2 x 4 units (size packed as across x * 8 + across z), dry, its light.
    const patch = g.getAttribute('aPatch'), lit = g.getAttribute('lit');
    expect([patch.getX(16), patch.getZ(16), patch.getW(16)]).toEqual([40, 16, 4 * 8 + 4]);
    expect([patch.getX(17), patch.getW(17)]).toEqual([44, 2 * 8 + 4]);
    expect([lit.getX(17), lit.getY(17), lit.getZ(17)].map((v) => Math.round(v * 255))).toEqual([200, 10, 255]);
    // Walked over to the other (144 m on): it gets blades; the first, left behind, none.
    field.update(new THREE.Vector3(9 * 16 + 8, 3, 8));
    expect(field.stats).toEqual({ chunks: 1, patches: 16 });
    expect(scene.getObjectByName('grass 0,0,0')).toBeUndefined();
    // Just past the edge of its range (and the margin): none; back: again.
    field.update(new THREE.Vector3(9 * 16 + 16 + GRASS_RANGE + 5, 3, 8));
    expect(field.stats.chunks).toBe(0);
    field.update(new THREE.Vector3(9 * 16 + 16 + GRASS_RANGE - 1, 3, 8));
    expect(field.stats.chunks).toBe(1);
    // Its grass gone (the chunk remeshed without, or no longer drawn): its blades go.
    field.setTops('9,0,0', null, null);
    expect(field.stats).toEqual({ chunks: 0, patches: 0 });
    field.dispose();
  });

  it('a blade: four sides and a top, a unit square column', () => {
    const g = bladeGeometry();
    expect(g.index!.count).toBe(5 * 6);
    const p = g.getAttribute('position');
    const ys = new Set(Array.from({ length: p.count }, (_, i) => p.getY(i)));
    expect(ys).toEqual(new Set([0, 1]));
  });
});
