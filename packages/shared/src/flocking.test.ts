import { describe, expect, it } from 'vitest';
import { Flock, Skein, birdSettings, seededRandom, skeinSettings } from './flocking.js';

const s = birdSettings(1);
const make = (n = 60, seed = 1) => new Flock(n, s, [0, 50, 0], [1, 0, 0], 40, seededRandom(seed));

function minGap(f: Flock): number {
  let m = Infinity;
  for (let i = 0; i < f.count; i++)
    for (let j = i + 1; j < f.count; j++) m = Math.min(m, Math.hypot(f.pos[i * 3]! - f.pos[j * 3]!, f.pos[i * 3 + 1]! - f.pos[j * 3 + 1]!, f.pos[i * 3 + 2]! - f.pos[j * 3 + 2]!));
  return m;
}
function spread(f: Flock): number {
  const c = f.centre();
  let m = 0;
  for (let i = 0; i < f.count; i++) m = Math.max(m, Math.hypot(f.pos[i * 3]! - c[0], f.pos[i * 3 + 1]! - c[1], f.pos[i * 3 + 2]! - c[2]));
  return m;
}
const speeds = (f: Flock) => Array.from({ length: f.count }, (_, i) => Math.hypot(f.vel[i * 3]!, f.vel[i * 3 + 1]!, f.vel[i * 3 + 2]!));

describe('Flock', () => {
  it('is the same from the same seed, and keeps its speeds between the limits', () => {
    const a = make(), b = make();
    for (let k = 0; k < 100; k++) {
      a.step(1 / 30);
      b.step(1 / 30);
    }
    expect(a.pos).toEqual(b.pos);
    for (const v of speeds(a)) {
      expect(v).toBeGreaterThanOrEqual(s.minSpeed - 1e-3);
      expect(v).toBeLessThanOrEqual(s.maxSpeed + 1e-3);
    }
  });

  it('holds together (no wider than it started, roughly) yet keeps its members apart', () => {
    const f = make();
    const before = spread(f);
    for (let k = 0; k < 30 * 20; k++) f.step(1 / 30);
    expect(spread(f)).toBeLessThan(before * 1.5);
    // Nobody on top of anybody (crowded at the start: apart after).
    expect(minGap(f)).toBeGreaterThan(s.separationRadius * 0.25);
  });

  it('flies together: headings line up', () => {
    const f = new Flock(40, s, [0, 50, 0], [1, 0, 0], 30, seededRandom(3));
    // Each heading somewhere of its own.
    const r = seededRandom(9);
    for (let i = 0; i < f.count * 3; i++) f.vel[i] = (r() - 0.5) * s.maxSpeed;
    const order = () => {
      const m = [0, 0, 0];
      for (let i = 0; i < f.count; i++) {
        const sp = Math.hypot(f.vel[i * 3]!, f.vel[i * 3 + 1]!, f.vel[i * 3 + 2]!);
        for (let a = 0; a < 3; a++) m[a]! += f.vel[i * 3 + a]! / sp / f.count;
      }
      return Math.hypot(...m); // 1: all one way
    };
    const before = order();
    for (let k = 0; k < 30 * 10; k++) f.step(1 / 30);
    expect(order()).toBeGreaterThan(Math.max(0.8, before));
  });

  it('makes for its target, and keeps above the ground', () => {
    const f = make();
    // Heading +x; the target's 300 off to the side (+z): it turns and gets there (6-12 a second).
    f.target = [0, 60, 300];
    const ground = (x: number) => (x > -1000 ? 80 : null); // a plateau higher than it's flying
    for (let k = 0; k < 30 * 60; k++) f.step(1 / 30, ground);
    const c = f.centre();
    expect(Math.hypot(c[0], c[2] - 300)).toBeLessThan(60);
    // Over the plateau, not below its clearance (by much: it climbs as it can).
    for (let i = 0; i < f.count; i++) expect(f.pos[i * 3 + 1]!).toBeGreaterThan(80 + s.clearance * 0.5);
  });
});

describe('Skein', () => {
  const make = (n = 15, seed = 2) => new Skein(n, skeinSettings(1, 10), [0, 50, 0], 0, seededRandom(seed));

  it('settles into a V behind its leader: each further back and out, alternately left and right', () => {
    const k = make();
    for (let t = 0; t < 30 * 15; t++) k.step(1 / 30, [0, 50, 10_000]); // straight on (+z)
    const lead = [k.pos[0]!, k.pos[1]!, k.pos[2]!];
    for (let i = 1; i < k.count; i++) {
      const dx = k.pos[i * 3]! - lead[0]!, dz = k.pos[i * 3 + 2]! - lead[2]!, rank = Math.ceil(i / 2);
      expect(dz).toBeLessThan(0); // behind (heading +z)
      expect(Math.sign(dx)).toBe(i % 2 ? -1 : 1); // its side: odd ones one way, even the other
      // Near its place (it drifts about it).
      const slot = k.slot(i, lead);
      expect(Math.hypot(k.pos[i * 3]! - slot[0], k.pos[i * 3 + 2]! - slot[2])).toBeLessThan(k.settings.wobble * 2 + 0.5);
      if (rank > 1) expect(-dz).toBeGreaterThan(Math.cos(k.settings.spread) * k.settings.spacing * (rank - 1));
    }
  });

  it('each bird moves on its own (not in lockstep), and they keep apart', () => {
    const k = make();
    const before: number[] = [];
    for (let t = 0; t < 30 * 10; t++) k.step(1 / 30, [0, 50, 10_000]);
    for (let i = 1; i < k.count; i++) before.push(k.vel[i * 3]!);
    k.step(1, [0, 50, 10_000]);
    // Their sideways speeds differ (each drifts in its own time).
    expect(new Set(before.map((v) => v.toFixed(2))).size).toBeGreaterThan(k.count / 2);
    let gap = Infinity;
    for (let i = 0; i < k.count; i++)
      for (let j = i + 1; j < k.count; j++) gap = Math.min(gap, Math.hypot(k.pos[i * 3]! - k.pos[j * 3]!, k.pos[i * 3 + 1]! - k.pos[j * 3 + 1]!, k.pos[i * 3 + 2]! - k.pos[j * 3 + 2]!));
    expect(gap).toBeGreaterThan(0.3);
  });

  it('turns (no faster than it can) and climbs toward its goal, the V turning with it', () => {
    const k = make();
    const goal: [number, number, number] = [2000, 120, 0]; // off to +x, higher
    k.step(1 / 30, goal);
    expect(k.heading).toBeLessThanOrEqual(k.settings.turnRate / 30 + 1e-9);
    for (let t = 0; t < 30 * 60; t++) k.step(1 / 30, goal); // (70 up at 1.5 a second: about 47 s)
    expect(k.heading).toBeCloseTo(Math.PI / 2, 1); // now heading +x
    expect(k.pos[1]).toBeCloseTo(120, 0);
    // The last in each arm is behind (-x) the leader now.
    expect(k.pos[(k.count - 1) * 3]!).toBeLessThan(k.pos[0]!);
  });

  it('flies in other shapes too: a J, an echelon, single file', () => {
    const fly = (shape: 'j' | 'echelon' | 'line') => {
      const k = new Skein(13, { ...skeinSettings(1, 10), shape }, [0, 50, 0], 0, seededRandom(4));
      for (let t = 0; t < 30 * 15; t++) k.step(1 / 30, [0, 50, 10_000]);
      // Each follower's side of the leader (heading +z: across is x), and how far behind.
      return Array.from({ length: k.count - 1 }, (_, j) => ({ dx: k.pos[(j + 1) * 3]! - k.pos[0]!, dz: k.pos[(j + 1) * 3 + 2]! - k.pos[2]! }));
    };
    // Echelon: all off to one side.
    const e = fly('echelon');
    expect(new Set(e.map((f) => Math.sign(f.dx))).size).toBe(1);
    // Single file: straight behind (within its drift), further and further back.
    const l = fly('line');
    for (const f of l) expect(Math.abs(f.dx)).toBeLessThan(2.5);
    expect(Math.min(...l.map((f) => -f.dz))).toBeGreaterThan(0);
    // J: both sides, one twice the other.
    const j = fly('j');
    const right = j.filter((f) => f.dx > 0).length, left = j.filter((f) => f.dx < 0).length;
    expect(Math.min(left, right)).toBeGreaterThan(0);
    expect(Math.max(left, right)).toBeGreaterThanOrEqual(Math.min(left, right) * 2 - 1);
  });
});
