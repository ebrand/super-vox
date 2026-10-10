import { describe, expect, it } from 'vitest';
import { BED_WIDTH_M, CLEARANCE_M, MAX_GRADE, groundGrade, MAX_SEGMENT_M, MIN_RADIUS_M, SAMPLE_M, SHOULDER_M, curveSpeed, earthworks, layLine, profile, radiusFor, segmentLine } from './rail.js';
import { BLOCK_SIZE } from './chunk.js';
import { Material } from './materials.js';
import { UNITS_PER_METER } from './units.js';

const M = UNITS_PER_METER;

describe('a segment of track', () => {
  const step = SAMPLE_M * M;
  const gap = (line: { x: number; z: number }[]) => line.slice(1).map((p, i) => Math.hypot(p.x - line[i]!.x, p.z - line[i]!.z));

  it('straight: from anywhere to anywhere; on from a heading, straight on as far as the aim is ahead', () => {
    const free = segmentLine({ from: { x: 0, z: 0 }, heading: null, to: { x: 30 * M, z: 40 * M }, curve: false }, step);
    if (typeof free === 'string') throw new Error(free);
    expect(free.radius).toBe(Infinity);
    expect(free.line.at(-1)!.x).toBeCloseTo(30 * M, 6);
    expect(free.line.at(-1)!.z).toBeCloseTo(40 * M, 6);
    for (const g of gap(free.line)) expect(g).toBeCloseTo(M, 6);
    // Heading east (-pi/2), aimed east and a bit north: east, as far as it's ahead.
    const on = segmentLine({ from: { x: 0, z: 0 }, heading: -Math.PI / 2, to: { x: 50 * M, z: -7 * M }, curve: false }, step);
    if (typeof on === 'string') throw new Error(on);
    expect(on.line.every((p) => Math.abs(p.z) < 1e-6)).toBe(true);
    expect(on.line.at(-1)!.x).toBeCloseTo(50 * M, 6);
    expect(on.endHeading).toBeCloseTo(-Math.PI / 2, 9);
    expect(segmentLine({ from: { x: 0, z: 0 }, heading: -Math.PI / 2, to: { x: -50 * M, z: 0 }, curve: false }, step)).toMatch(/ahead/);
    expect(segmentLine({ from: { x: 0, z: 0 }, heading: null, to: { x: (MAX_SEGMENT_M + 1) * M, z: 0 }, curve: false }, step)).toMatch(/too long/);
    expect(segmentLine({ from: { x: 0, z: 0 }, heading: null, to: { x: 2 * M, z: 0 }, curve: false }, step)).toMatch(/too short/);
  });

  it('curved: the arc leaving along the heading through the aim, its radius, the heading at its end', () => {
    // East, to 50 m east and 50 m south (+z): a quarter circle of 50 m, ending heading south (pi).
    const q = segmentLine({ from: { x: 0, z: 0 }, heading: -Math.PI / 2, to: { x: 50 * M, z: 50 * M }, curve: true }, step);
    if (typeof q === 'string') throw new Error(q);
    expect(q.radius).toBeCloseTo(50, 6);
    expect(q.line.at(-1)!.x).toBeCloseTo(50 * M, 4);
    expect(q.line.at(-1)!.z).toBeCloseTo(50 * M, 4);
    expect(Math.abs(Math.cos(q.endHeading) - Math.cos(Math.PI))).toBeLessThan(1e-9);
    expect(Math.sin(q.endHeading)).toBeCloseTo(0, 9);
    // (Every point 50 m from the centre, at x 0, z 50 m; starting off east.)
    for (const p of q.line) expect(Math.hypot(p.x, p.z - 50 * M)).toBeCloseTo(50 * M, 4);
    expect(q.line[1]!.x).toBeGreaterThan(0.99 * M);
    for (const g of gap(q.line)) expect(g).toBeGreaterThan(0.95 * M);
    // The other way (north): mirrored, ending heading north.
    const n = segmentLine({ from: { x: 0, z: 0 }, heading: -Math.PI / 2, to: { x: 50 * M, z: -50 * M }, curve: true }, step);
    if (typeof n === 'string') throw new Error(n);
    expect(n.endHeading).toBeCloseTo(0, 9);
    expect(segmentLine({ from: { x: 0, z: 0 }, heading: -Math.PI / 2, to: { x: -5 * M, z: 50 * M }, curve: true }, step)).toMatch(/half round/);
    expect(segmentLine({ from: { x: 0, z: 0 }, heading: null, to: { x: 50 * M, z: 50 * M }, curve: true }, step)).toMatch(/track's end/);
  });

  it('a curve is as fast as its radius lets it be', () => {
    expect(curveSpeed(Infinity)).toBe(Infinity);
    expect(curveSpeed(radiusFor(80))).toBeCloseTo(80, 9);
    expect(radiusFor(100)).toBeGreaterThan(radiusFor(60));
    expect(curveSpeed(MIN_RADIUS_M)).toBeGreaterThan(20);
  });

  it('keeps to the ground where it can, never steeper than the grade: cut through a hill, built up over a dip', () => {
    const flat = profile(new Array(200).fill(10 * M), step)!;
    expect(flat.every((h) => Math.abs(h - 10 * M) < 1e-9)).toBe(true);
    // A hill 6 m high, 10 m wide, then a dip 4 m deep.
    const ground = Array.from({ length: 400 }, (_, i) => (i >= 100 && i < 110 ? 16 * M : i >= 250 && i < 260 ? 6 * M : 10 * M));
    const h = profile(ground, step)!;
    for (let i = 1; i < h.length; i++) expect(Math.abs(h[i]! - h[i - 1]!) / step).toBeLessThanOrEqual(MAX_GRADE + 1e-6);
    expect(Math.max(...h.slice(100, 110))).toBeLessThan(16 * M); // (cut)
    expect(Math.min(...h.slice(250, 260))).toBeGreaterThan(6 * M); // (filled)
    // A deep dip right at an end (a lakeshore): still no steeper than the grade, start to finish.
    const shore = profile(Array.from({ length: 120 }, (_, i) => (i < 3 ? 0 : i < 60 ? -23 * M : 0)), step)!;
    for (let i = 1; i < shore.length; i++) expect(Math.abs(shore[i]! - shore[i - 1]!) / step, `at ${i}`).toBeLessThanOrEqual(MAX_GRADE + 1e-9);
    expect(h[30]).toBeCloseTo(10 * M, 6);
    expect(h[380]).toBeCloseTo(10 * M, 6);
  });

  it('starts (or ends) where it is pinned, a track end, keeping to the grade from there; both too far apart: null', () => {
    const ground = new Array(101).fill(10 * M);
    const up = profile(ground, step, MAX_GRADE, { start: 12 * M })!;
    expect(up[0]).toBe(12 * M);
    for (let i = 1; i < up.length; i++) expect(Math.abs(up[i]! - up[i - 1]!) / step).toBeLessThanOrEqual(MAX_GRADE + 1e-9);
    expect(up.at(-1)).toBeCloseTo(10 * M, 6); // (back on the ground well before its end)
    const both = profile(ground, step, MAX_GRADE, { start: 12 * M, end: 10 * M })!;
    expect(both[0]).toBe(12 * M);
    expect(both.at(-1)).toBe(10 * M);
    for (let i = 1; i < both.length; i++) expect(Math.abs(both[i]! - both[i - 1]!) / step).toBeLessThanOrEqual(MAX_GRADE + 1e-9);
    expect(profile(ground, step, MAX_GRADE, { start: 0, end: 4 * M })).toBeNull(); // (4 m in 100 m: 4%)
  });

  it('says what it would take: its length, deepest cut and highest fill (and where), steepest grade', () => {
    const hill = (x: number, z: number) => (Math.hypot(x - 50 * M, z) < 8 * M ? 15 * M : 10 * M);
    const s = segmentLine({ from: { x: 0, z: 0 }, heading: null, to: { x: 100 * M, z: 0 }, curve: false }, step);
    if (typeof s === 'string') throw new Error(s);
    const lay = layLine(s.line, hill)!;
    expect(lay.length).toBeCloseTo(100, 6);
    expect(lay.maxCut).toBeGreaterThan(2);
    expect(Math.abs(lay.cutAt - 50)).toBeLessThan(8);
    expect(lay.maxGrade).toBeLessThanOrEqual(MAX_GRADE + 1e-6);
    expect(lay.points[0]!.heading).toBeCloseTo(-Math.PI / 2, 6); // (east: 0 is -z, counter-clockwise)
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

  it('at its edges, in quarter-metre columns: none outside the bed and shoulders, all within cleared at the bed', () => {
    // North-east, on flat ground at 10 m, the rails' foot 10.3 m.
    const pts = Array.from({ length: 60 }, (_, i) => ({ x: (i * M) / Math.SQRT2, y: 10.3 * M, z: -(i * M) / Math.SQRT2, heading: -Math.PI / 4, s: i * M }));
    const { clear } = earthworks(pts, () => 10 * M);
    const half = (BED_WIDTH_M / 2 + SHOULDER_M) * M, Q = BLOCK_SIZE / 4;
    // (How far from the line: across it, the line being x = -z, from 3 m to 38 m along, clear of its ends.)
    const off = (x: number, z: number) => Math.abs(x + z) / Math.SQRT2;
    const along = (x: number, z: number) => (x - z) / Math.SQRT2;
    const bed = clear.filter((p) => p.y <= 9.5 * M && p.y + p.size > 9.5 * M);
    expect(bed.some((p) => p.size === Q)).toBe(true);
    for (const p of bed) {
      // Every corner of a whole block, and the middle of a quarter, within.
      const corners = p.size === Q ? [[p.x + Q / 2, p.z + Q / 2]] : [[p.x, p.z], [p.x + p.size, p.z], [p.x, p.z + p.size], [p.x + p.size, p.z + p.size]];
      for (const [x, z] of corners) if (along(x!, z!) > 3 * M && along(x!, z!) < 38 * M) expect(off(x!, z!)).toBeLessThanOrEqual(half + 1e-6);
    }
    // All within (a quarter in from the edge), cleared at the bed.
    const covered = (x: number, z: number) => bed.some((p) => x >= p.x && x < p.x + p.size && z >= p.z && z < p.z + p.size);
    for (let a = 5 * M; a < 35 * M; a += 0.37 * M)
      for (let o = -half + Q; o <= half - Q; o += 0.29 * M) {
        const x = (a + o) / Math.SQRT2, z = (o - a) / Math.SQRT2;
        expect(covered(x, z), `at ${(a / M).toFixed(2)} m along, ${(o / M).toFixed(2)} m across`).toBe(true);
      }
  });

  it("measures the ground's grade over GRADE_WINDOW_M: a short step's nothing, a long slope's its grade", () => {
    const step = M;
    expect(groundGrade(Array.from({ length: 200 }, (_, i) => (i < 100 ? 0 : 0.5 * M)), step).grade).toBeLessThan(MAX_GRADE);
    const slope = groundGrade(Array.from({ length: 200 }, (_, i) => (i >= 50 && i < 150 ? (i - 50) * 0.05 * M : i >= 150 ? 5 * M : 0)), step);
    expect(slope.grade).toBeCloseTo(0.05, 6);
    expect(slope.at / M).toBeGreaterThan(50);
    expect(slope.at / M).toBeLessThan(150);
  });

  it('in a cut, the bed under the rails is solid gravel (cleared, then made again), in whole blocks and at the edges', () => {
    // East along z 0.4 m; the ground 14 m, the rails' foot 10.3 m: a cut 3.7 m deep.
    const pts = Array.from({ length: 41 }, (_, i) => ({ x: i * M, y: 10.3 * M, z: 0.4 * M, heading: -Math.PI / 2, s: i * M }));
    const { fill, clear } = earthworks(pts, () => 14 * M);
    const Q = BLOCK_SIZE / 4;
    const at = (list: typeof fill, x: number, y: number, z: number) => list.filter((p) => x >= p.x && x < p.x + p.size && y >= p.y && y < p.y + p.size && z >= p.z && z < p.z + p.size);
    // Across the bed (whole blocks in the middle, quarters at the edges), from a metre under the foot to it: filled, gravel; over it, cleared.
    for (let zq = -1.6; zq <= 2.4; zq += 0.25)
      for (let y = 9.3 + Q / M / 2; y < 10.25; y += 0.25) {
        const f = at(fill, 20.5 * M, y * M, zq * M);
        expect(f.length, `filled at z ${zq}, y ${y.toFixed(3)}`).toBeGreaterThan(0);
        expect(f.every((p) => p.material === Material.Gravel)).toBe(true);
      }
    expect(at(clear, 20.5 * M, 12 * M, 0.4 * M).length).toBeGreaterThan(0);
  });
});