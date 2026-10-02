import { describe, expect, it } from 'vitest';
import { moveAabb, playerBox } from './physics.js';
import type { SolidAt } from './physics.js';
import { GRAVITY, JUMP_SPEED, SINK_SPEED, SWIM_SPEED, walkStep, type Mover, type WalkState } from './walking.js';

/** Flat ground at y < 0 (units), plus extra solid boxes in units. */
function world(...boxes: [number, number, number, number, number, number][]): SolidAt {
  return (x, y, z) => y < 0 || boxes.some(([x0, y0, z0, x1, y1, z1]) => x >= x0 && x < x1 && y >= y0 && y < y1 && z >= z0 && z < z1);
}

/** A walker in metres driving moveAabb (units). */
function walker(w: SolidAt, eye: [number, number, number]) {
  const pos = [...eye] as [number, number, number];
  let state: WalkState = { vy: 0, grounded: false };
  const move: Mover = (d) => {
    const r = moveAabb(playerBox([pos[0] * 16, pos[1] * 16, pos[2] * 16]), [d[0] * 16, d[1] * 16, d[2] * 16], w);
    return { delta: [r.delta[0] / 16, r.delta[1] / 16, r.delta[2] / 16], blocked: r.blocked };
  };
  return {
    pos,
    get state() { return state; },
    step(dx: number, dz: number, jump = false, dt = 1 / 60, speed = 4, loaded = true) {
      const r = walkStep(state, { dx, dz, speed, jump }, dt, move, loaded);
      pos[0] += r.delta[0]; pos[1] += r.delta[1]; pos[2] += r.delta[2];
      state = r.state;
    },
    run(seconds: number, dx = 0, dz = 0, jump = false) {
      for (let t = 0; t < seconds; t += 1 / 60) this.step(dx, dz, jump);
    },
  };
}

const EYE = 1.62;

describe('walkStep', () => {
  it('falls under gravity and lands standing on the ground', () => {
    const p = walker(world(), [0.5, 10, 0.5]);
    p.run(0.5);
    expect(p.pos[1]).toBeLessThan(10 - 0.5 * GRAVITY * 0.25 * 0.9);
    p.run(3);
    expect(p.pos[1]).toBeCloseTo(EYE, 9);
    expect(p.state.grounded).toBe(true);
    expect(p.state.vy).toBe(0);
  });

  it('jumps about 1.3 m, only from the ground', () => {
    const p = walker(world(), [0.5, EYE, 0.5]);
    p.run(0.1);
    let peak = 0;
    p.step(0, 0, true);
    // Holding jump while airborne (~0.7 s) must not jump again...
    for (let i = 0; i < 30; i++) {
      p.step(0, 0, true);
      peak = Math.max(peak, p.pos[1] - EYE);
    }
    // ...then release and land.
    for (let i = 0; i < 60; i++) {
      p.step(0, 0, false);
      peak = Math.max(peak, p.pos[1] - EYE);
    }
    expect(peak).toBeGreaterThan(1.2);
    expect(peak).toBeLessThan(1.35);
    expect(p.state.grounded).toBe(true);
    expect(JUMP_SPEED).toBeCloseTo(Math.sqrt(2 * GRAVITY * 1.3), 12);
  });

  it('can jump onto a 1 m block but cannot walk onto it', () => {
    // A 1 m block from x = 2 m onwards.
    const block = world([32, 0, -160, 320, 16, 160]);
    const walkOnly = walker(block, [0.5, EYE, 0.5]);
    walkOnly.run(2, 1, 0);
    expect(walkOnly.pos[0]).toBeCloseTo(2 - 0.3, 6);
    expect(walkOnly.pos[1]).toBeCloseTo(EYE, 6);
    const jumper = walker(block, [0.5, EYE, 0.5]);
    jumper.run(0.1);
    jumper.run(1 / 60, 1, 0, true); // one jump...
    jumper.run(2, 1, 0); // ...while walking forward
    expect(jumper.pos[0]).toBeGreaterThan(3);
    expect(jumper.pos[1]).toBeCloseTo(1 + EYE, 6);
  });

  it('steps up small ledges while walking and falls off edges', () => {
    // A 1/4 m step from x = 1 m to 3 m, then back to ground.
    const step = world([16, 0, -160, 48, 4, 160]);
    const p = walker(step, [0.5, EYE, 0.5]);
    p.run(0.1);
    p.run(0.5, 1, 0);
    expect(p.pos[1]).toBeCloseTo(0.25 + EYE, 6);
    p.run(2, 1, 0);
    expect(p.pos[0]).toBeGreaterThan(3.5);
    expect(p.pos[1]).toBeCloseTo(EYE, 6);
  });

  it('stops rising when it hits a ceiling', () => {
    const p = walker(world([-160, 32, -160, 160, 48, 160]), [0.5, EYE, 0.5]);
    p.run(0.1);
    p.step(0, 0, true);
    for (let i = 0; i < 30; i++) p.step(0, 0, false);
    // Head (eye + 0.18 m) never passes the ceiling at 2 m.
    expect(p.pos[1] + (1.8 - EYE)).toBeLessThanOrEqual(2 + 1e-9);
  });

  it('does not fall while the ground below is not loaded', () => {
    const p = walker(world(), [0.5, 10, 0.5]);
    for (let i = 0; i < 60; i++) p.step(0, 0, false, 1 / 60, 4, false);
    expect(p.pos[1]).toBe(10);
    // Once loaded it falls.
    for (let i = 0; i < 60; i++) p.step(0, 0, false, 1 / 60, 4, true);
    expect(p.pos[1]).toBeLessThan(10);
  });
});

describe('swimming', () => {
  /** A player over flat ground at y = 0, in water below `surface` (m), eye starting at `eyeY`. */
  const swimmer = (eyeY: number, surface = 5) => {
    const pos: [number, number, number] = [0, eyeY, 0];
    let state: WalkState = { vy: 0, grounded: false };
    const move: Mover = (d) => {
      const r = moveAabb(playerBox([pos[0] * 16, pos[1] * 16, pos[2] * 16]), [d[0] * 16, d[1] * 16, d[2] * 16], world());
      return { delta: [r.delta[0] / 16, r.delta[1] / 16, r.delta[2] / 16], blocked: r.blocked };
    };
    return {
      pos,
      get state() { return state; },
      run(seconds: number, up = false, down = false, loaded = true) {
        for (let t = 0; t < seconds; t += 1 / 60) {
          const swim = pos[1] - 0.75 < surface ? { swim: { up, down } } : {};
          const r = walkStep(state, { dx: 0, dz: 0, speed: 2, jump: up, ...swim }, 1 / 60, move, loaded);
          pos[1] += r.delta[1];
          state = r.state;
        }
      },
    };
  };

  it('sinks slowly instead of falling, and settles on the bottom', () => {
    const s = swimmer(4.5);
    s.run(0.5);
    expect(s.state.vy).toBeLessThan(0);
    expect(s.state.vy).toBeGreaterThanOrEqual(-SINK_SPEED - 1e-9);
    s.run(8);
    expect(s.pos[1]).toBeCloseTo(EYE, 2);
    expect(s.state.grounded).toBe(true);
  });

  it('swims up and down at swimming speed', () => {
    const up = swimmer(3, 50);
    up.run(2, true);
    expect(up.state.vy).toBeCloseTo(SWIM_SPEED, 3);
    const down = swimmer(40, 50);
    down.run(2, false, true);
    expect(down.state.vy).toBeCloseTo(-SWIM_SPEED, 3);
  });

  it('bobs at the surface while swimming up, instead of flying out', () => {
    const s = swimmer(2);
    s.run(6, true);
    // Surface at 5 m: the body's middle (eye - 0.75) stays around it.
    expect(s.pos[1] - 0.75).toBeGreaterThan(4.3);
    expect(s.pos[1] - 0.75).toBeLessThan(5.8);
  });

  it('does not sink while the ground below is not loaded', () => {
    const s = swimmer(4);
    s.run(1, false, false, false);
    expect(s.pos[1]).toBe(4);
  });
});
