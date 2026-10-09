import { describe, expect, it } from 'vitest';
import { BED_WIDTH_M, CLEARANCE_M, MAX_GRADE, SAMPLE_M, SHOULDER_M, earthworks, layRoute, profile, smoothLine } from './rail.js';
import { BLOCK_SIZE } from './chunk.js';
import { Material } from './materials.js';
import { UNITS_PER_METER } from './units.js';

const M = UNITS_PER_METER;

describe('a route laid as track', () => {
  it('is a smooth line through its points, evenly sampled, from the first to the last', () => {
    const pts = [{ x: 0, z: 0 }, { x: 100 * M, z: 0 }, { x: 160 * M, z: 60 * M }, { x: 160 * M, z: 200 * M }];
    const line = smoothLine(pts, M);
    expect(line[0]).toEqual({ x: 0, z: 0 });
    expect(Math.hypot(line.at(-1)!.x - 160 * M, line.at(-1)!.z - 200 * M)).toBeLessThan(1e-6);
    for (let i = 1; i < line.length - 1; i++) expect(Math.hypot(line[i]!.x - line[i - 1]!.x, line[i]!.z - line[i - 1]!.z)).toBeCloseTo(M, 1);
    // (Through the points between, near enough.)
    for (const p of pts.slice(1, -1)) expect(Math.min(...line.map((q) => Math.hypot(q.x - p.x, q.z - p.z)))).toBeLessThan(M);
    // Drawn straight: straight.
    const straight = smoothLine([{ x: 0, z: 0 }, { x: 0, z: -50 * M }, { x: 0, z: -120 * M }], M);
    expect(straight.every((p) => Math.abs(p.x) < 1e-6)).toBe(true);
  });

  it('keeps to the ground where it can, never steeper than the grade: cut through a hill, built up over a dip', () => {
    const step = SAMPLE_M * M;
    const flat = profile(new Array(200).fill(10 * M), step);
    expect(flat.every((h) => Math.abs(h - 10 * M) < 1e-9)).toBe(true);
    // A hill 6 m high, 10 m wide, then a dip 4 m deep.
    const ground = Array.from({ length: 400 }, (_, i) => (i >= 100 && i < 110 ? 16 * M : i >= 250 && i < 260 ? 6 * M : 10 * M));
    const h = profile(ground, step);
    for (let i = 1; i < h.length; i++) expect(Math.abs(h[i]! - h[i - 1]!) / step).toBeLessThanOrEqual(MAX_GRADE + 1e-6);
    expect(Math.max(...h.slice(100, 110))).toBeLessThan(16 * M); // (cut)
    expect(Math.min(...h.slice(250, 260))).toBeGreaterThan(6 * M); // (filled)
    // A deep dip right at an end (a lakeshore): still no steeper than the grade, start to finish.
    const shore = profile(Array.from({ length: 120 }, (_, i) => (i < 3 ? 0 : i < 60 ? -23 * M : 0)), step);
    for (let i = 1; i < shore.length; i++) expect(Math.abs(shore[i]! - shore[i - 1]!) / step, `at ${i}`).toBeLessThanOrEqual(MAX_GRADE + 1e-9);
    // Far from both: on the ground.
    expect(h[30]).toBeCloseTo(10 * M, 6);
    expect(h[380]).toBeCloseTo(10 * M, 6);
  });

  it('says what it would take: its length, cut and fill, grade and tightest curve', () => {
    const hill = (x: number, z: number) => (Math.hypot(x - 50 * M, z) < 8 * M ? 15 * M : 10 * M);
    const lay = layRoute([{ x: 0, z: 0 }, { x: 100 * M, z: 0 }], hill)!;
    expect(lay.length).toBeCloseTo(100, 0);
    expect(lay.maxCut).toBeGreaterThan(2);
    expect(lay.maxGrade).toBeLessThanOrEqual(MAX_GRADE + 1e-6);
    expect(lay.points[0]!.heading).toBeCloseTo(-Math.PI / 2, 3); // (east: 0 is -z, counter-clockwise)
    const bend = layRoute([{ x: 0, z: 0 }, { x: 20 * M, z: 0 }, { x: 20 * M, z: 20 * M }], () => 0)!;
    expect(bend.minRadius).toBeLessThan(25);
    expect(layRoute([{ x: 0, z: 0 }], () => 0)).toBeNull();
  });
});

describe('earthworks', () => {
  it('builds the bed up from the ground to the rails (gravel on top), clears above (more in a cut), within the bed and shoulders', () => {
    // East along z 0 at x 0..40 m: ground 10 m; a 6 m hill at 20 m; the rails' foot made 10.3 m.
    const ground = (x: number) => (Math.abs(x - 20 * M) < 2 * M ? 16 * M : 10 * M);
    const pts = Array.from({ length: 41 }, (_, i) => ({ x: i * M, y: 10.3 * M, z: 0, heading: -Math.PI / 2, s: i * M }));
    const { fill, clear, columns } = earthworks(pts, ground);
    // Columns: a bed and shoulders wide (z from -2.5 m to 2.5 m: blocks -3..2, those whose middle's within).
    const zs = new Set(fill.map((p) => Math.floor(p.z / BLOCK_SIZE)));
    expect(Math.max(...zs) - Math.min(...zs) + 1).toBeLessThanOrEqual(BED_WIDTH_M + 2 * SHOULDER_M + 1);
    // Where the ground's 10 m: filled up to 10.25 m (quarters), gravel on top; cleared up 12 m over it.
    const at5 = fill.filter((p) => p.x >= 5 * M && p.x < 6 * M && p.z >= 0 && p.z < BLOCK_SIZE);
    expect(Math.max(...at5.map((p) => p.y + p.size))).toBe(10.25 * M);
    expect(at5.filter((p) => p.y >= 10 * M).every((p) => p.material === Material.Gravel)).toBe(true);
    // (Cleared from the metre under it: that made gravel again.)
    const c5 = clear.filter((p) => p.x >= 5 * M && p.x < 6 * M && p.z >= 0 && p.z < BLOCK_SIZE);
    expect(Math.min(...c5.map((p) => p.y))).toBe(9 * M);
    expect(Math.max(...c5.map((p) => p.y + p.size))).toBeGreaterThanOrEqual((10.25 + CLEARANCE_M) * M);
    // In the hill: cleared down to the rails, up past the hill's top (open, not a tunnel).
    const c20 = clear.filter((p) => p.x >= 20 * M && p.x < 21 * M && p.z >= 0 && p.z < BLOCK_SIZE);
    expect(Math.max(...c20.map((p) => p.y + p.size))).toBeGreaterThanOrEqual(17 * M);
    // The chunk columns it changed (a chunk is 16 m; the bed reaching 2.5 m past each end: x -2.5..42.5 m, z -2.5..2.5).
    expect(columns).toEqual(['-1,-1', '-1,0', '0,-1', '0,0', '1,-1', '1,0', '2,-1', '2,0']);
  });
});
