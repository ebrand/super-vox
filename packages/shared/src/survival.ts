import { Item, type ItemId } from './items.js';
import { PLAYER_HEALTH, REGEN_AFTER_MS, REGEN_MS } from './mobs.js';
import { GRAVITY, TERMINAL_SPEED } from './walking.js';

/**
 * Survival's needs (Minecraft's, more or less): falling hurts, breath runs out under water, and
 * food runs down as you go (faster sprinting, swimming, fighting, mining, healing); you heal only
 * when well fed, and starving wears you down (never quite to death). The server keeps each
 * player's (see Vitals); the client shows them.
 */

/** Food points when full. */
export const MAX_FOOD = 20;
/** Breath (s) under water before drowning starts, shown as MAX_AIR bubbles. */
export const AIR_SECONDS = 15;
export const MAX_AIR = 10;
/** How much faster breath comes back than it goes. */
const AIR_REFILL = 5;
/** Drowning: this much damage each DROWN_MS once out of breath. */
export const DROWN_DAMAGE = 2;
export const DROWN_MS = 1000;
/** Starving (no food points left): a point of damage each STARVE_MS, never below 1 health. */
export const STARVE_MS = 4000;
/** Healing needs at least this much food. */
export const REGEN_FOOD = 18;
/** A fall this high (m) or less doesn't hurt; each metre more is a point of damage. */
export const FALL_SAFE_METRES = 3;

/** Exhaustion: EXHAUSTION_PER_FOOD of it uses up a food point. */
export const EXHAUSTION_PER_FOOD = 4;
export const EXHAUSTION = {
  /** Just being alive, per second (a food point every two minutes). */
  living: 1 / 30,
  /** Per metre on foot, sprinting, swimming. */
  walk: 0.01,
  sprint: 0.1,
  swim: 0.015,
  /** Per swing at something, per thing mined. */
  attack: 0.1,
  mine: 0.025,
  /** Per point of health healed (half a food point: there's no saturation to soften it, as Minecraft has). */
  heal: 2,
} as const;

/** Food points each food gives back. */
export const FOODS: Readonly<Record<ItemId, number>> = { [Item.Pork]: 3, [Item.CookedPork]: 8 };

export function isFood(item: ItemId): boolean {
  return FOODS[item] !== undefined;
}

/** Damage from landing at `speed` (m/s, downward): a point per metre fallen beyond FALL_SAFE_METRES. */
export function fallDamage(speed: number): number {
  const v = Math.min(Math.max(0, speed), TERMINAL_SPEED);
  return Math.max(0, Math.floor((v * v) / (2 * GRAVITY) - FALL_SAFE_METRES + 1e-9));
}

export type DeathCause = 'fell' | 'drowned' | 'starved' | 'mob' | 'blast';

/** Vitals as kept between visits (see Vitals.saved, Vitals.restore). */
export interface SavedVitals {
  health: number;
  food: number;
  /** Breath left (s). */
  air: number;
  exhaustion: number;
}

/** A player's health, food and breath (see the module comment); times are ms. */
export class Vitals {
  health = PLAYER_HEALTH;
  food = MAX_FOOD;
  /** Toward the next food point used (see EXHAUSTION_PER_FOOD). */
  exhaustion = 0;
  /** Breath left (s). */
  air = AIR_SECONDS;
  lastHurt = 0;
  private lastRegen = 0;
  private lastStarve = 0;
  private lastDrown = 0;

  /** What to keep of them between visits. */
  saved(): SavedVitals {
    return { health: this.health, food: this.food, air: this.air, exhaustion: this.exhaustion };
  }

  /** Back as they were kept (anything out of range or missing left as it is; never dead). */
  restore(s: Partial<SavedVitals>): void {
    const ok = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
    if (ok(s.health, 1, PLAYER_HEALTH)) this.health = Math.round(s.health);
    if (ok(s.food, 0, MAX_FOOD)) this.food = Math.round(s.food);
    if (ok(s.air, 0, AIR_SECONDS)) this.air = s.air;
    if (ok(s.exhaustion, 0, EXHAUSTION_PER_FOOD)) this.exhaustion = s.exhaustion;
  }

  /** Breath as bubbles (0..MAX_AIR). */
  get bubbles(): number {
    return Math.ceil((this.air / AIR_SECONDS) * MAX_AIR - 1e-9);
  }

  /** Hurt by `damage`: true if that killed them (they're whole again, fed and breathing: back at the spawn point). */
  hurt(damage: number, now: number): boolean {
    if (damage <= 0) return false;
    this.health -= damage;
    this.lastHurt = now;
    if (this.health > 0) return false;
    this.health = PLAYER_HEALTH;
    this.food = MAX_FOOD;
    this.exhaustion = 0;
    this.air = AIR_SECONDS;
    return true;
  }

  /** Effort: exhaustion, which uses up food. */
  exert(amount: number): void {
    this.exhaustion += amount;
    while (this.exhaustion >= EXHAUSTION_PER_FOOD) {
      this.exhaustion -= EXHAUSTION_PER_FOOD;
      this.food = Math.max(0, this.food - 1);
    }
  }

  /** Eats one `item`: whether it could (it's food, and they're hungry). */
  eat(item: ItemId): boolean {
    const value = FOODS[item];
    if (value === undefined || this.food >= MAX_FOOD) return false;
    this.food = Math.min(MAX_FOOD, this.food + value);
    return true;
  }

  /**
   * `dt` seconds pass (eye under water or not): breath goes or comes back, food runs down, and
   * they drown, starve or heal. Returns damage taken and why (null: none), and whether it killed them.
   */
  step(dt: number, now: number, underwater: boolean): { damage: number; cause: DeathCause | null; died: boolean } {
    this.exert(EXHAUSTION.living * dt);
    this.air = underwater ? Math.max(0, this.air - dt) : Math.min(AIR_SECONDS, this.air + dt * AIR_REFILL);
    if (underwater && this.air === 0 && now - this.lastDrown >= DROWN_MS) {
      this.lastDrown = now;
      return { damage: DROWN_DAMAGE, cause: 'drowned', died: this.hurt(DROWN_DAMAGE, now) };
    }
    if (this.food === 0 && this.health > 1 && now - this.lastStarve >= STARVE_MS) {
      this.lastStarve = now;
      return { damage: 1, cause: 'starved', died: this.hurt(1, now) };
    }
    if (this.food >= REGEN_FOOD && this.health < PLAYER_HEALTH && now - this.lastHurt >= REGEN_AFTER_MS && now - this.lastRegen >= REGEN_MS) {
      this.health++;
      this.lastRegen = now;
      this.exert(EXHAUSTION.heal);
    }
    return { damage: 0, cause: null, died: false };
  }
}
