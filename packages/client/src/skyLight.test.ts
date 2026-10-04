import { describe, expect, it } from 'vitest';
import { BLOCK_SIZE, BLOCKS_PER_AXIS, BLOCKS_PER_CHUNK, Material, blockIndex, emptyChunk, type Chunk } from '@super-vox/shared';
import { BOX, SKY_LIGHT, aroundIndex, faceLight, skyLight, type LightInput } from './skyLight.js';
import { packQuads, visibleFaces } from './mesher.js';

const N = BLOCKS_PER_AXIS;
const at = (light: Uint8Array, x: number, y: number, z: number) => light[x + BOX * (z + BOX * y)]!;

/**
 * Rock everywhere in the box but what `open` says (box block coordinates): nothing above it, so
 * only what's open to the top of the box sees the sky.
 */
function rockBut(open: (x: number, y: number, z: number) => boolean, above = 0): LightInput {
  const opaque: (Uint8Array | 0 | 1)[] = [];
  for (let dy = -1; dy <= 1; dy++)
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const o = new Uint8Array(BLOCKS_PER_CHUNK);
        for (let y = 0; y < N; y++)
          for (let z = 0; z < N; z++)
            for (let x = 0; x < N; x++) o[blockIndex(x, y, z)] = open((dx + 1) * N + x, (dy + 1) * N + y, (dz + 1) * N + z) ? 0 : 1;
        opaque[aroundIndex(dx, dy, dz)] = o;
      }
  return { opaque, above: new Uint8Array(BOX * BOX).fill(above) };
}

/** A shaft from the top of the box down to y 24 at x 20, z 20, and a tunnel from its foot along +x to x 44. */
const shaftAndTunnel = (x: number, y: number, z: number) => z === 20 && ((x === 20 && y >= 24) || (y === 24 && x >= 20 && x <= 44));

describe('skyLight', () => {
  it('has nothing to work out where all is open to the sky', () => {
    const opaque = new Array(27).fill(0);
    expect(skyLight({ opaque, above: new Uint8Array(BOX * BOX) })).toBeNull();
    // Ground below, sky above: still all lit.
    opaque[aroundIndex(0, -1, 0)] = 1;
    expect(skyLight({ opaque, above: new Uint8Array(BOX * BOX) })).toBeNull();
  });

  it('is full down a shaft open to the sky and one less per block along a tunnel', () => {
    const light = skyLight(rockBut(shaftAndTunnel))!;
    expect(light).not.toBeNull();
    for (let y = 24; y < BOX; y++) expect(at(light, 20, y, 20)).toBe(SKY_LIGHT);
    for (let d = 1; d <= 24; d++) expect(at(light, 20 + d, 24, 20)).toBe(Math.max(0, SKY_LIGHT - d));
    // Rock is marked as such.
    expect(at(light, 21, 25, 20)).toBe(255);
  });

  it('is dark where something above the box shuts out the sky', () => {
    const light = skyLight(rockBut(shaftAndTunnel, 1))!;
    for (let y = 24; y < BOX; y++) expect(at(light, 20, y, 20)).toBe(0);
    expect(at(light, 25, 24, 20)).toBe(0);
  });

  it('agrees where two chunks meet (each works it out from its own box)', () => {
    // The world: rock with the shaft and tunnel (world block coordinates, the box above at chunk 0).
    const world = (x: number, y: number, z: number) => shaftAndTunnel(x + N, y + N, z + N);
    const boxOf = (cx: number) => rockBut((x, y, z) => world(x - N + cx * N, y - N, z - N));
    const a = skyLight(boxOf(0))!, b = skyLight(boxOf(1))!;
    // Along the tunnel (world x 4 .. 28, y 8, z 4), in both boxes where both have it.
    for (let x = 4; x <= 28; x++) {
      const inA = x + N, inB = x + N - N;
      if (inA >= BOX || inB < 0) continue;
      expect(at(a, inA, 8 + N, 4 + N)).toBe(at(b, inB, 8 + N, 4 + N));
    }
  });
});

describe('faceLight', () => {
  it('lights a floor by the blocks over it, blended between block corners', () => {
    const light = skyLight(rockBut(shaftAndTunnel))!;
    // The tunnel's floor at box x 26 (chunk-local block 10), y 23 under it: face +Y at the plane
    // between them (chunk-local units; on +Y faces U is z and V is x).
    const x = (26 - N) * BLOCK_SIZE, plane = (24 - N) * BLOCK_SIZE, z = (20 - N) * BLOCK_SIZE;
    const l = faceLight(light, 2, plane, z, x, BLOCK_SIZE, BLOCK_SIZE);
    // Corners at x 26 and 27: the open blocks around each (the rock beside the tunnel doesn't
    // count), light 10 at x 25, 9 at 26, 8 at 27.
    const v = (n: number) => Math.round((n / SKY_LIGHT) * 255);
    expect(l).toEqual([v(9.5), v(9.5), v(8.5), v(8.5)]);
    // Halfway along, half of each.
    const h = faceLight(light, 2, plane, z, x, BLOCK_SIZE, BLOCK_SIZE / 2);
    expect(h[2]).toBe(v(9));
  });

  it('is full against the open sky', () => {
    // Ground up to y 27 of the box (open above), with the dark tunnel under it.
    const light = skyLight(rockBut((x, y, z) => y >= 28 || shaftAndTunnel(x, y, z)))!;
    expect(light).not.toBeNull();
    const l = faceLight(light, 2, (28 - N) * BLOCK_SIZE, 0, 0, BLOCK_SIZE, BLOCK_SIZE);
    expect(l).toEqual([255, 255, 255, 255]);
  });
});

describe('meshing with sky light', () => {
  it('shades faces in the dark and packs it per vertex; lit meshes carry none', () => {
    // A chunk of rock with a tunnel through it at y 8, z 4 (from the shaft-and-tunnel world).
    const chunk: Chunk = emptyChunk({ cx: 0, cy: 0, cz: 0 });
    const rock = { kind: 'uniform', size: 16, material: Material.Stone } as const;
    for (let y = 0; y < N; y++) for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) if (!shaftAndTunnel(x + N, y + N, z + N)) chunk.blocks[blockIndex(x, y, z)] = rock;
    const neighbors = new Array(6).fill(null).map(() => ({ ...emptyChunk({ cx: 0, cy: 0, cz: 0 }), blocks: new Array(BLOCKS_PER_CHUNK).fill(rock) }));
    const light = skyLight(rockBut(shaftAndTunnel))!;
    const quads = visibleFaces(chunk, neighbors, true, light);
    expect(quads.length).toBeGreaterThan(0);
    expect(quads.some((q) => q.light && q.light.some((l) => l < 255))).toBe(true);
    // Farther down the tunnel, darker.
    const floor = (bx: number) => quads.find((q) => q.dir === 2 && q.v <= bx * BLOCK_SIZE && q.v + q.dv > bx * BLOCK_SIZE)!;
    expect(floor(14).light![0]).toBeLessThan(floor(8).light![0]);
    const packed = packQuads(quads);
    expect(packed.dark).toBeInstanceOf(Uint8Array);
    expect(packed.dark!.length).toBe(packed.quadCount * 4);
    expect(Math.max(...packed.dark!)).toBeGreaterThan(0);
    // Without light: no shade.
    expect(packQuads(visibleFaces(chunk, neighbors)).dark).toBeUndefined();
  });
});
