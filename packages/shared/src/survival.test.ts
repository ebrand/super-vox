import { describe, expect, it } from 'vitest';
import { Item } from './items.js';
import { PLAYER_HEALTH, REGEN_AFTER_MS, REGEN_MS } from './mobs.js';
import { AIR_SECONDS, DROWN_DAMAGE, EXHAUSTION, EXHAUSTION_PER_FOOD, MAX_AIR, MAX_FOOD, REGEN_FOOD, STARVE_MS, Vitals, fallDamage, isFood } from './survival.js';
import { GRAVITY, JUMP_SPEED, TERMINAL_SPEED } from './walking.js';

/** Landing speed after falling `h` metres. */
const after = (h: number) => Math.sqrt(2 * GRAVITY * h);

/** Runs `v` for `seconds` in 0.1 s steps from `start` (ms); returns what hurt it, and the time after. */
function run(v: Vitals, seconds: number, underwater: boolean, start = 0): { hurt: { cause: string | null; damage: number; died: boolean }[]; now: number } {
  const hurt = [];
  let now = start;
  for (let i = 0; i < Math.round(seconds * 10); i++) {
    now += 100;
    const r = v.step(0.1, now, underwater);
    if (r.damage) hurt.push({ cause: r.cause, damage: r.damage, died: r.died });
  }
  return { hurt, now };
}

describe('fall damage', () => {
  it('is nothing for a jump or a 3 m drop, then a point a metre', () => {
    expect(fallDamage(JUMP_SPEED)).toBe(0);
    expect(fallDamage(after(3))).toBe(0);
    expect(fallDamage(after(4))).toBe(1);
    expect(fallDamage(after(10))).toBe(7);
    expect(fallDamage(after(23))).toBe(PLAYER_HEALTH); // dead
    // No faster than terminal speed, whatever's claimed.
    expect(fallDamage(1e6)).toBe(fallDamage(TERMINAL_SPEED));
    expect(fallDamage(-5)).toBe(0);
  });
});

describe('Vitals', () => {
  it('drowns after AIR_SECONDS under water, DROWN_DAMAGE a second, and gets its breath back quickly', () => {
    const v = new Vitals();
    expect(v.bubbles).toBe(MAX_AIR);
    let r = run(v, AIR_SECONDS - 0.5, true);
    expect(r.hurt).toEqual([]);
    expect(v.bubbles).toBe(1);
    r = run(v, 3, true, r.now);
    expect(r.hurt.length).toBe(3);
    expect(r.hurt.every((h) => h.cause === 'drowned' && h.damage === DROWN_DAMAGE)).toBe(true);
    expect(v.health).toBe(PLAYER_HEALTH - 3 * DROWN_DAMAGE);
    // Up for air: full again within a few seconds.
    r = run(v, AIR_SECONDS / 5 + 0.2, false, r.now);
    expect(r.hurt).toEqual([]);
    expect(v.bubbles).toBe(MAX_AIR);
  });

  it('drowns to death in the end, and comes back whole, fed and breathing', () => {
    const v = new Vitals();
    v.food = 3;
    const r = run(v, AIR_SECONDS + PLAYER_HEALTH / DROWN_DAMAGE + 1, true);
    const died = r.hurt.filter((h) => h.died);
    expect(died.length).toBe(1);
    expect(died[0]!.cause).toBe('drowned');
    expect(v.food).toBe(MAX_FOOD);
    expect(v.health).toBeGreaterThan(PLAYER_HEALTH - 2 * DROWN_DAMAGE);
  });

  it('gets hungry living, faster for effort; eating fills it up, but not past full', () => {
    const v = new Vitals();
    run(v, 120, false);
    expect(v.food).toBe(MAX_FOOD - 1); // a point every two minutes, just living
    v.exert(EXHAUSTION_PER_FOOD * 5);
    expect(v.food).toBe(MAX_FOOD - 6);
    // A kilometre sprinted: 25 points (all there is).
    v.exert(EXHAUSTION.sprint * 1000);
    expect(v.food).toBe(0);
    expect(isFood(Item.Pork)).toBe(true);
    expect(isFood(Item.Stick)).toBe(false);
    expect(v.eat(Item.Stick)).toBe(false);
    expect(v.eat(Item.Pork)).toBe(true);
    expect(v.food).toBe(4);
    v.food = MAX_FOOD - 1;
    expect(v.eat(Item.Pork)).toBe(true);
    expect(v.food).toBe(MAX_FOOD);
    expect(v.eat(Item.Pork)).toBe(false); // not hungry
  });

  it('heals only when well fed, and healing makes you hungry', () => {
    const v = new Vitals();
    v.hurt(6, 0);
    v.food = REGEN_FOOD - 1;
    let r = run(v, (REGEN_AFTER_MS + 3 * REGEN_MS) / 1000, false);
    expect(v.health).toBe(PLAYER_HEALTH - 6);
    v.food = MAX_FOOD;
    v.exhaustion = 0;
    r = run(v, (3 * REGEN_MS) / 1000, false, r.now);
    expect(v.health).toBe(PLAYER_HEALTH - 3);
    // Three points healed: 6 exhaustion, a food point and a half.
    expect(v.food).toBe(MAX_FOOD - 1);
    expect(v.exhaustion).toBeCloseTo(3 * EXHAUSTION.heal + 12 * EXHAUSTION.living - EXHAUSTION_PER_FOOD, 5);
  });

  it('starving wears health down a point at a time, but never kills', () => {
    const v = new Vitals();
    v.food = 0;
    const r = run(v, (STARVE_MS / 1000) * (PLAYER_HEALTH + 5), false);
    expect(r.hurt.every((h) => h.cause === 'starved' && !h.died)).toBe(true);
    expect(r.hurt.length).toBe(PLAYER_HEALTH - 1);
    expect(v.health).toBe(1);
  });

  it('dies of a big enough hurt, and is whole again', () => {
    const v = new Vitals();
    expect(v.hurt(0, 0)).toBe(false);
    expect(v.hurt(19, 0)).toBe(false);
    expect(v.health).toBe(1);
    expect(v.hurt(5, 0)).toBe(true);
    expect(v.health).toBe(PLAYER_HEALTH);
  });
});

describe('Vitals kept between visits', () => {
  it('come back as saved; anything out of range or missing is left as it was, and never dead', () => {
    const v = new Vitals();
    v.hurt(7, 0);
    v.exert(EXHAUSTION_PER_FOOD * 3 + 1);
    const saved = v.saved();
    expect(saved).toEqual({ health: 13, food: 17, air: AIR_SECONDS, exhaustion: 1 });
    const back = new Vitals();
    back.restore(saved);
    expect(back.saved()).toEqual(saved);
    const odd = new Vitals();
    odd.restore({ health: 0, food: 21, air: Number.NaN });
    expect(odd.saved()).toEqual(new Vitals().saved());
    odd.restore({ food: 4.4 });
    expect(odd.food).toBe(4);
  });
});
