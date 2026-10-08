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

describe('grass patches', () => {
  it(`cover GRASS_COVER of the grass (measured on the shader's own noise)`, async () => {
    const { GRASS_COVER, noiseCut } = await import('./voxelMaterial.js');
    expect(GRASS_COVER).toBe(0.65);
    expect(noiseCut(0.5)).toBeCloseTo(0.5, 3);
    expect(noiseCut(0.65)).toBeCloseTo(0.595, 3);
    expect(noiseCut(0.625)).toBeCloseTo((0.563 + 0.595) / 2, 3);
    // The shader's cellHash and valueNoise (in doubles, near enough), and grassPatch's soft cut.
    const fract = (x: number) => x - Math.floor(x), mod = (a: number, b: number) => a - b * Math.floor(a / b);
    const hash = (cx: number, cy: number) => {
      let px = fract(mod(cx, 1024) * 0.1031), py = fract(mod(cy, 1024) * 0.103);
      const d = px * (py + 33.33) + py * (px + 33.33);
      px += d;
      py += d;
      return fract((px + py) * px);
    };
    const noise = (x: number, y: number) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      let fx = x - ix, fy = y - iy;
      fx = fx * fx * (3 - 2 * fx);
      fy = fy * fy * (3 - 2 * fy);
      const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
      return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
    };
    const smooth = (e0: number, e1: number, x: number) => {
      const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
      return t * t * (3 - 2 * t);
    };
    const cut = noiseCut(GRASS_COVER);
    let sum = 0, n = 0;
    for (let x = 0; x < 2000; x += 1.7) for (let z = 0; z < 2000; z += 1.3, n++) sum += 1 - smooth(cut - 0.03, cut + 0.03, noise(x * 0.25 + 91, z * 0.25 + 37));
    expect(sum / n).toBeGreaterThan(0.62);
    expect(sum / n).toBeLessThan(0.68);
  });
});
