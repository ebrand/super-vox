import { describe, expect, it } from 'vitest';
import { Material } from '@super-vox/shared';
import { createAtmosphere } from './atmosphere.js';
import { createVoxelMaterial } from './voxelMaterial.js';

describe('grass in the wind (voxel material)', () => {
  it('is off until the game turns it on; drifts with the wind; its flutter time goes round every 100 s', () => {
    const m = createVoxelMaterial(createAtmosphere(1000));
    const u = m.uniforms;
    expect(u.grassOn!.value).toBe(0);
    m.setGrassWind({ x: 3, z: -4 }, 0.5);
    expect(u.grassOn!.value).toBe(1);
    expect(u.grassWind!.value.toArray()).toEqual([3, -4]);
    expect(u.grassDrift!.value.toArray()).toEqual([1.5, -2]);
    // The wind changes: the drift goes on from where it was (no jump).
    m.setGrassWind({ x: -1, z: 0 }, 1);
    expect(u.grassDrift!.value.toArray()).toEqual([0.5, -2]);
    for (let i = 0; i < 200; i++) m.setGrassWind({ x: 0, z: 0 }, 0.5);
    expect(u.grassTime!.value).toBeCloseTo(1.5, 6); // 101.5 s on: round once
    // Only grass and dry grass, and only their tops.
    expect(m.vertexShader).toContain(`material == ${Material.Grass} || material == ${Material.DryGrass}`);
    expect(m.fragmentShader).toContain('vGrass > 0.5 && n.y > 0.5');
  });
});
