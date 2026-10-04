import {
  ZOMBIE_DARK,
  blastDamage,
  darkEnoughForZombies,
  MOBS,
  Material,
  UNITS_PER_METER,
  deltaX,
  hurtMob,
  intersectsSolid,
  mobBox,
  newMob,
  normalizeX,
  stepMob,
  type EntitySnapshot,
  type Mob,
  type MobKind,
  type MobTarget,
} from '@super-vox/shared';
import type { World } from './world.js';

const M = UNITS_PER_METER;

/**
 * Mobs kept around each player (within KEEP), by kind, and where new ones appear (SPAWN_MIN..SPAWN_MAX
 * from them). Zombies by day: only in the dark (caves), so only where there's some near.
 */
const AROUND_PLAYER: Record<MobKind, { day: number; night: number }> = { pig: { day: 4, night: 2 }, zombie: { day: 3, night: 5 } };
const SPAWN_MIN = 24 * M, SPAWN_MAX = 48 * M;
/** How far (blocks) a daytime check for dark looks for the sky: light from further off is under ZOMBIE_DARK. */
const SKY_REACH = 15 - ZOMBIE_DARK;
/** Mobs further than this from every player go away. */
const KEEP = 96 * M;
/** Most mobs in a world at once. */
const MAX_MOBS = 200;
/** Where mobs start (ids below are players'). */
const FIRST_MOB_ID = 1_000_000;
/** Grassy ground pigs appear on. */
const GRASSY = new Set<number>([Material.Grass, Material.Meadow, Material.DryGrass, Material.JungleFloor, Material.TaigaFloor, Material.Tundra]);

/** A player as the mob manager sees them: feet (units), and whether mobs can hurt them. */
export type MobPlayer = MobTarget;

/**
 * A world's mobs: they appear near players (pigs on grass by day; zombies in the dark: at night,
 * or in caves, never where a torch lights), act (see stepMob), burn away in daylight (zombies
 * under the open sky), and go when nobody's near. The server steps it a few times a second.
 */
export class MobManager {
  private readonly mobs = new Map<number, Mob>();
  private nextId = FIRST_MOB_ID;
  private nextSpawn = 0;
  private nextBurn = 0;

  constructor(
    private readonly world: World,
    private readonly random: () => number = Math.random,
  ) {}

  get count(): number {
    return this.mobs.size;
  }

  get(id: number): Mob | undefined {
    return this.mobs.get(id);
  }

  /** Adds a mob (spawning normally does this; tests use it too). */
  add(kind: MobKind, x: number, y: number, z: number, now: number): Mob {
    const m = newMob(this.nextId++, kind, normalizeX(this.world.config, x), y, z, now);
    this.mobs.set(m.id, m);
    return m;
  }

  /**
   * Advances every mob by `dt` seconds at `now` (ms). `night`: zombies come out (and don't
   * burn). Returns the hits mobs made on players.
   */
  step(dt: number, now: number, players: readonly MobPlayer[], night: boolean): { player: number; damage: number }[] {
    const hits: { player: number; damage: number }[] = [];
    const cfg = this.world.config;
    for (const m of this.mobs.values()) {
      // Players as this mob sees them: at their copy nearest it (round worlds wrap).
      const near = players.map((p) => ({ ...p, x: m.x + deltaX(cfg, m.x, p.x) }));
      if (!near.some((p) => Math.hypot(p.x - m.x, p.z - m.z) < KEEP)) {
        this.mobs.delete(m.id);
        continue;
      }
      const { hit } = stepMob(m, dt, now, this.world.solidAt, near, this.random);
      m.x = normalizeX(cfg, m.x);
      if (hit) hits.push(hit);
      // Fell out of the world.
      if (m.y < cfg.minYUnits) this.mobs.delete(m.id);
    }
    // Zombies burn in daylight, under the open sky (not in caves, or under a roof): a point a second.
    if (!night && now >= this.nextBurn) {
      this.nextBurn = now + 1000;
      for (const m of this.mobs.values()) {
        if (m.kind !== 'zombie') continue;
        const head = Math.floor((m.y + MOBS.zombie.height * M - 1) / M);
        if (!this.world.skyOpenAt(Math.floor(m.x / M), head, Math.floor(m.z / M))) continue;
        if (hurtMob(m, 1, m.x, m.z, now)) this.mobs.delete(m.id);
      }
    }
    if (now >= this.nextSpawn) {
      this.nextSpawn = now + 1000;
      for (const p of players) this.spawnNear(p, night, now);
    }
    return hits;
  }

  /** Tops up the mobs around a player: one at a time (a second), somewhere suitable 24..48 m away. */
  private spawnNear(p: MobPlayer, night: boolean, now: number): void {
    if (this.mobs.size >= MAX_MOBS) return;
    const cfg = this.world.config;
    for (const kind of ['zombie', 'pig'] as const) {
      const want = night ? AROUND_PLAYER[kind].night : AROUND_PLAYER[kind].day;
      let have = 0;
      for (const m of this.mobs.values()) if (m.kind === kind && Math.hypot(deltaX(cfg, p.x, m.x), m.z - p.z) < SPAWN_MAX + 16 * M) have++;
      if (have >= want) continue;
      const a = this.random() * Math.PI * 2, r = SPAWN_MIN + this.random() * (SPAWN_MAX - SPAWN_MIN);
      const x = Math.floor(p.x + Math.sin(a) * r), z = Math.floor(p.z + Math.cos(a) * r);
      const y = this.groundAt(x, p.y, z, kind, night);
      if (y !== null) {
        this.add(kind, x + 0.5, y, z + 0.5, now);
        return; // one a second per player
      }
      // (None there, as when zombies want the dark by day and it's all daylight: pigs may.)
    }
  }

  /**
   * Where a mob could stand at column (x, z) near height `nearY` (units): on something solid, with
   * room for it, not in water; pigs on grass, the highest such place; zombies in the dark (see
   * darkEnoughForZombies), any such place (in a cave as much as on top).
   */
  private groundAt(x: number, nearY: number, z: number, kind: MobKind, night: boolean): number | null {
    const solid = this.world.solidAt;
    const spots: number[] = [];
    for (let y = Math.floor(nearY + 16 * M); y > nearY - 24 * M; y--) {
      if (!solid(x, y - 1, z) || solid(x, y, z)) continue;
      // Room for the whole body, and not under water; pigs only on grass.
      const fits = !intersectsSolid(mobBox(kind, x + 0.5, y, z + 0.5), solid) && this.world.materialAtUnit(x, y, z) === 0;
      if (kind === 'pig') return fits && GRASSY.has(this.world.materialAtUnit(x, y - 1, z) ?? 0) ? y : null;
      if (fits) spots.push(y);
    }
    // Zombies: a few of the places, at random, until one's dark.
    for (let tries = 0; tries < 4 && spots.length; tries++) {
      const y = spots.splice(Math.floor(this.random() * spots.length), 1)[0]!;
      const bx = Math.floor(x / M), by = Math.floor(y / M), bz = Math.floor(z / M);
      const block = this.world.lightAt(bx, by, bz, { block: true }).block;
      // (By day, only whether there's sky light above ZOMBIE_DARK matters: looked for that near.)
      const sky = night ? 0 : this.world.lightAt(bx, by, bz, { sky: true, reach: SKY_REACH }).sky;
      if (darkEnoughForZombies({ sky, block }, night)) return y;
    }
    return null;
  }

  /**
   * A player at eye (x, y, z) (units) hits mob `id` for `damage`: if it's within `reach` metres.
   * Returns whether it was hit, whether that killed it, and what it was.
   */
  attack(id: number, eyeX: number, eyeY: number, eyeZ: number, damage: number, reach: number, now: number): { hit: boolean; killed: boolean; kind?: MobKind } {
    const m = this.mobs.get(id);
    if (!m) return { hit: false, killed: false };
    const b = mobBox(m.kind, m.x, m.y, m.z);
    const x = m.x + deltaX(this.world.config, m.x, eyeX); // the eye's copy nearest the mob
    const gap = Math.hypot(Math.max(b.min[0] - x, 0, x - b.max[0]), Math.max(b.min[1] - eyeY, 0, eyeY - b.max[1]), Math.max(b.min[2] - eyeZ, 0, eyeZ - b.max[2])) / M;
    if (gap > reach) return { hit: false, killed: false, kind: m.kind };
    const killed = hurtMob(m, damage, x, eyeZ, now);
    if (killed) this.mobs.delete(id);
    return { hit: true, killed, kind: m.kind };
  }

  /** A blast at (x, y, z) (units) of `radius`: every mob in reach hurt (see blastDamage), knocked away from it. */
  blast(x: number, y: number, z: number, radius: number, now: number): void {
    for (const [id, m] of this.mobs) {
      const bx = m.x + deltaX(this.world.config, m.x, x); // (the blast's copy nearest the mob)
      const damage = blastDamage(Math.hypot(m.x - bx, m.y - y, m.z - z), radius);
      if (damage > 0 && hurtMob(m, damage, bx, z, now)) this.mobs.delete(id);
    }
  }

  /** Mobs within `radius` (units, horizontally) of (x, z), for a player's view. */
  near(x: number, z: number, radius: number, now: number): EntitySnapshot[] {
    const out: EntitySnapshot[] = [];
    const cfg = this.world.config;
    for (const m of this.mobs.values()) {
      if (Math.hypot(deltaX(cfg, x, m.x), m.z - z) > radius) continue;
      out.push({
        id: m.id, kind: m.kind, x: Math.round(m.x), y: Math.round(m.y), z: Math.round(m.z),
        yaw: Math.round(m.yaw * 100) / 100, health: m.health, max: MOBS[m.kind].health,
        ...(now - m.hurtAt < 300 ? { hurt: true } : {}),
      });
    }
    return out;
  }
}
