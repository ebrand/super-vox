import { intersectsSolid, moveAabb, type Aabb, type SolidAt } from './physics.js';
import { UNITS_PER_METER } from './units.js';
import { walkStep, type WalkState } from './walking.js';
import type { ItemId } from './items.js';
import { SWORDS } from './tools.js';

/**
 * Creatures (mobs): pigs wander by day and run from whoever hits them; zombies come out at night,
 * chase players nearby and hit them; outlaws (people: see outlaws.ts) keep about their camp, and go
 * for players and villagers they see, with a sword, or keeping off with a bow. The server moves
 * them (stepMob, a few times a second) and tells nearby players where they are.
 */
export type MobKind = 'pig' | 'zombie' | 'outlaw';
/** Everything the client draws besides the world: other players and mobs. */
/** What's seen moving: players, mobs, and villagers (see villages.ts; drawn as players are). */
export type EntityKind = 'player' | 'villager' | MobKind;

export interface MobSpec {
  health: number;
  /** Body (metres). */
  width: number;
  height: number;
  /** Walking (wandering) and hurrying (fleeing, chasing) speeds, m/s. */
  walk: number;
  hurry: number;
  hostile: boolean;
  /** Hostile: damage per hit, reach (m, from body to body), time between hits (ms), how far it sees players (m). */
  damage?: number;
  reach?: number;
  attackMs?: number;
  sight?: number;
  /** Goes for villagers too (see MobTarget.villager). */
  villagers?: boolean;
}

export const MOBS: Record<MobKind, MobSpec> = {
  pig: { health: 10, width: 0.9, height: 0.9, walk: 1.2, hurry: 4, hostile: false },
  zombie: { health: 20, width: 0.6, height: 1.95, walk: 1, hurry: 2.6, hostile: true, damage: 3, reach: 1.2, attackMs: 1000, sight: 24 },
  outlaw: { health: 20, width: 0.6, height: 1.8, walk: 1.3, hurry: 3.4, hostile: true, damage: 4, reach: 1.3, attackMs: 900, sight: 28, villagers: true },
};

/** An outlaw with a bow: keeps between ARCHER_NEAR and ARCHER_FAR (m) from who they're after, shooting every ARCHER_MS (ms), from ARCHER_RANGE (m) or nearer. */
export const ARCHER_NEAR = 7;
export const ARCHER_FAR = 15;
export const ARCHER_RANGE = 22;
export const ARCHER_MS = 2500;

/**
 * Where zombies appear: in the dark. No torchlight at all (torches keep them away), and by day
 * only where the sky's light is this low or lower (caves, deep under things); at night anywhere.
 */
export const ZOMBIE_DARK = 7;

export function darkEnoughForZombies(light: { sky: number; block: number }, night: boolean): boolean {
  return light.block === 0 && (night || light.sky <= ZOMBIE_DARK);
}

/** A player's health, and how fast it comes back (1 point every REGEN_MS once unhurt for REGEN_AFTER_MS). */
export const PLAYER_HEALTH = 20;
export const REGEN_MS = 4000;
export const REGEN_AFTER_MS = 6000;

/** How far a player can hit (m, eye to the body's nearest point), and how hard: by what's in hand. */
export const ATTACK_REACH = 4.5;
export function attackDamage(weapon: ItemId | null): number {
  return weapon === null ? 1 : (SWORDS[weapon]?.damage ?? 1);
}
/** Knockback from a hit: horizontal speed (m/s) and a little hop. */
export const KNOCKBACK = 6;
export const KNOCKBACK_HOP = 4;

export interface Mob {
  id: number;
  kind: MobKind;
  /** Feet, in world units. */
  x: number;
  y: number;
  z: number;
  /** Facing (radians, 0 = -Z), as players' yaw. */
  yaw: number;
  health: number;
  walk: WalkState;
  /** Knockback still being carried (m/s, horizontal). */
  pushX: number;
  pushZ: number;
  /** Where it's wandering to (units), or null standing. */
  goal: { x: number; z: number } | null;
  /** Next time (ms) it picks something new to do. */
  nextThink: number;
  /** Running from (units) until `fleeUntil` (ms). */
  fleeFrom: { x: number; z: number } | null;
  fleeUntil: number;
  /** Hostile: who it's after, and when it may hit next (ms). */
  target: number | null;
  nextAttack: number;
  /** When it was last hurt (ms), for the hurt flash. */
  hurtAt: number;
  /** Walked into something last step: hop next. */
  hopNext: boolean;
  /** Outlaws: who (their name, how they look: see avatarText), what's in hand, whether it's a bow; where they keep about (units: within HOME_M of it); how many times they've swung. */
  name?: string;
  look?: string;
  held?: ItemId;
  archer?: boolean;
  home?: { x: number; z: number } | null;
  swings?: number;
}

/** Outlaws wander within this far (m) of their `home`. */
export const HOME_M = 14;

export function newMob(id: number, kind: MobKind, x: number, y: number, z: number, now: number): Mob {
  return {
    id, kind, x, y, z, yaw: 0, health: MOBS[kind].health,
    walk: { vy: 0, grounded: false }, pushX: 0, pushZ: 0,
    goal: null, nextThink: now, fleeFrom: null, fleeUntil: 0, target: null, nextAttack: now, hurtAt: -Infinity, hopNext: false,
  };
}

/** A player as mobs see them (feet, units); `vulnerable` false for creative players and spectators. */
export interface MobTarget {
  id: number;
  x: number;
  y: number;
  z: number;
  vulnerable: boolean;
  /** A villager (see VillageSim): only mobs that go for them (MobSpec.villagers) do. */
  villager?: boolean;
}

/** A mob's box (units) with its feet at (x, y, z). */
export function mobBox(kind: MobKind, x: number, y: number, z: number): Aabb {
  const h = (MOBS[kind].width * UNITS_PER_METER) / 2;
  return { min: [x - h, y, z - h], max: [x + h, y + MOBS[kind].height * UNITS_PER_METER, z + h] };
}

/** Horizontal distance (m) between two points in units. */
function metres(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz) / UNITS_PER_METER;
}

/**
 * Advances a mob by `dt` seconds at time `now` (ms): decides where to go (wander; pigs run from
 * whoever hurt them; zombies chase the nearest vulnerable player in sight) and walks there under
 * gravity, climbing ledges and hopping when blocked. Returns a hit on a player, if it made one.
 */
export function stepMob(
  m: Mob,
  dt: number,
  now: number,
  solidAt: SolidAt,
  players: readonly MobTarget[],
  random: () => number = Math.random,
): { hit: { player: number; damage: number } | null; shoot?: MobTarget } {
  const spec = MOBS[m.kind];
  let dirX = 0, dirZ = 0, speed = 0;
  let hit: { player: number; damage: number } | null = null;
  let shoot: MobTarget | undefined;

  // Hostile: the nearest vulnerable player (or villager, for those that go for them) in sight.
  if (spec.hostile) {
    let best: MobTarget | null = null, bestD = Infinity;
    for (const p of players) {
      if (!p.vulnerable || (p.villager && !spec.villagers)) continue;
      const d = metres(m.x, m.z, p.x, p.z);
      if (d < (spec.sight ?? 0) && Math.abs(p.y - m.y) < 8 * UNITS_PER_METER && d < bestD) [best, bestD] = [p, d];
    }
    m.target = best?.id ?? null;
    if (best && m.archer) {
      // A bow: keeping off (nearer than ARCHER_NEAR, back; further than ARCHER_FAR, closer), shooting.
      const gap = bestD - spec.width / 2 - 0.3;
      if (gap > ARCHER_FAR) (dirX = best.x - m.x), (dirZ = best.z - m.z), (speed = spec.hurry);
      else if (gap < ARCHER_NEAR) (dirX = m.x - best.x), (dirZ = m.z - best.z), (speed = spec.walk);
      if (gap <= ARCHER_RANGE && now >= m.nextAttack) {
        shoot = best;
        m.nextAttack = now + ARCHER_MS;
        m.swings = (m.swings ?? 0) + 1;
      }
      m.goal = null;
      // (Facing them, whichever way it's going.)
      m.yaw = Math.atan2(-(best.x - m.x), -(best.z - m.z));
    } else if (best) {
      const gap = bestD - spec.width / 2 - 0.3; // body to body (a player is 0.6 m wide)
      if (gap > (spec.reach ?? 0) * 0.8) {
        dirX = best.x - m.x;
        dirZ = best.z - m.z;
        speed = spec.hurry;
      }
      if (gap <= (spec.reach ?? 0) && now >= m.nextAttack && Math.abs(best.y - m.y) < 2 * UNITS_PER_METER) {
        hit = { player: best.id, damage: spec.damage ?? 0 };
        m.nextAttack = now + (spec.attackMs ?? 1000);
        m.swings = (m.swings ?? 0) + 1;
      }
      m.goal = null;
    }
  }
  // Running from whoever hit it.
  if (!speed && m.fleeFrom && now < m.fleeUntil) {
    dirX = m.x - m.fleeFrom.x;
    dirZ = m.z - m.fleeFrom.z;
    speed = spec.hurry;
  }
  // Otherwise wander: now and then a new spot a few metres away, or a rest.
  if (!speed && m.target === null) {
    if (now >= m.nextThink) {
      m.nextThink = now + 2000 + random() * 4000;
      if (m.home && metres(m.x, m.z, m.home.x, m.home.z) > HOME_M) {
        // (Strayed from home: back toward it.)
        const a = random() * Math.PI * 2, r = random() * HOME_M * 0.5 * UNITS_PER_METER;
        m.goal = { x: m.home.x + Math.sin(a) * r, z: m.home.z + Math.cos(a) * r };
      } else if (random() < 0.6) {
        const a = random() * Math.PI * 2, r = (2 + random() * 6) * UNITS_PER_METER;
        m.goal = { x: m.x + Math.sin(a) * r, z: m.z + Math.cos(a) * r };
      } else m.goal = null;
    }
    if (m.goal) {
      dirX = m.goal.x - m.x;
      dirZ = m.goal.z - m.z;
      if (metres(m.x, m.z, m.goal.x, m.goal.z) < 0.5) m.goal = null;
      else speed = spec.walk;
    }
  }
  const len = Math.hypot(dirX, dirZ);
  if (len > 0) {
    dirX /= len;
    dirZ /= len;
    if (!(m.archer && m.target !== null)) m.yaw = Math.atan2(-dirX, -dirZ);
  }

  // Stuck in something solid (an edit, or a slope it slid into): climb out rather than fall through.
  const box = mobBox(m.kind, m.x, m.y, m.z);
  if (intersectsSolid(box, solidAt)) {
    m.y += 4;
    m.walk = { vy: 0, grounded: false };
    return { hit, ...(shoot ? { shoot } : {}) };
  }
  // Walk (with any knockback still carried), under gravity; hop when walking into something.
  let blocked = false;
  const move = (delta: [number, number, number]) => {
    const r = moveAabb(box, [delta[0] * UNITS_PER_METER, delta[1] * UNITS_PER_METER, delta[2] * UNITS_PER_METER], solidAt);
    if (r.blocked[0] || r.blocked[2]) blocked = true;
    return { delta: r.delta.map((d) => d / UNITS_PER_METER) as [number, number, number], blocked: r.blocked };
  };
  const vx = dirX * speed + m.pushX, vz = dirZ * speed + m.pushZ;
  const v = Math.hypot(vx, vz);
  const r = walkStep(m.walk, { dx: v ? vx / v : 0, dz: v ? vz / v : 0, speed: v, jump: m.walk.grounded && m.hopNext }, dt, move, true);
  m.walk = r.state;
  m.hopNext = blocked && speed > 0;
  m.x += r.delta[0] * UNITS_PER_METER;
  m.y += r.delta[1] * UNITS_PER_METER;
  m.z += r.delta[2] * UNITS_PER_METER;
  // Knockback fades quickly.
  const fade = Math.exp(-dt * 6);
  m.pushX *= fade;
  m.pushZ *= fade;
  return { hit, ...(shoot ? { shoot } : {}) };
}

/** Hurts a mob hit from (fromX, fromZ) (units): health down, knocked back; pigs run. Returns whether it died. */
export function hurtMob(m: Mob, damage: number, fromX: number, fromZ: number, now: number): boolean {
  m.health -= damage;
  m.hurtAt = now;
  const dx = m.x - fromX, dz = m.z - fromZ, d = Math.hypot(dx, dz) || 1;
  m.pushX = (dx / d) * KNOCKBACK;
  m.pushZ = (dz / d) * KNOCKBACK;
  if (m.walk.grounded) m.walk = { vy: KNOCKBACK_HOP, grounded: false };
  if (!MOBS[m.kind].hostile) {
    m.fleeFrom = { x: fromX, z: fromZ };
    m.fleeUntil = now + 5000;
  }
  return m.health <= 0;
}
