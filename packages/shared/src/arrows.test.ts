import { describe, expect, it } from 'vitest';
import { ARROW, arrowAt, arrowDamage, arrowSpeed, arrowStep, drawCharge, type ArrowShot } from './arrows.js';

const shot = (o: Partial<ArrowShot> = {}): ArrowShot => ({ id: 1, by: 1, x: 0, y: 100, z: 0, vx: 0, vy: 0, vz: -ARROW.speed, ...o });

describe('arrows', () => {
  it('are drawn harder the longer the bow is held, and hit harder for it', () => {
    expect(drawCharge(0)).toBe(0);
    expect(drawCharge(ARROW.drawMs / 2)).toBeCloseTo(0.5);
    expect(drawCharge(ARROW.drawMs * 3)).toBe(1);
    expect(arrowSpeed(0)).toBeCloseTo(ARROW.speed * ARROW.least);
    expect(arrowSpeed(1)).toBe(ARROW.speed);
    expect(arrowDamage(arrowSpeed(1))).toBe(ARROW.damage);
    expect(arrowDamage(arrowSpeed(0))).toBeLessThan(ARROW.damage / 2);
    expect(arrowDamage(0)).toBe(1);
  });

  it('fly in an arc: straight on along their aim, falling more the longer they fly', () => {
    const a = arrowAt(shot(), 1);
    expect(a.z).toBe(-ARROW.speed);
    expect(a.y).toBeCloseTo(100 - ARROW.gravity / 2);
    expect(a.vy).toBe(-ARROW.gravity);
  });

  it('stop at the first thing on their way: the world, or a box (mob, player)', () => {
    // A wall about 10 m ahead (cells z <= -160: its face at z = -159), a box 5 m ahead.
    const wall = (_x: number, _y: number, z: number) => z <= -160;
    const box = { id: 7, box: { min: [-8, 90, -88] as [number, number, number], max: [8, 120, -72] as [number, number, number] } };
    const t = 0.5; // (25 m: past both)
    const hit = arrowStep(shot(), 0, t, wall, [box]);
    expect(hit).toMatchObject({ what: 'thing', id: 7 });
    expect(hit!.at[2]).toBeCloseTo(-72);
    const past = arrowStep(shot(), 0, t, wall, []);
    expect(past).toMatchObject({ what: 'world' });
    expect(past!.at[2]).toBeCloseTo(-159);
    expect(arrowStep(shot(), 0, 0.01, wall, [])).toBeNull();
  });
});
