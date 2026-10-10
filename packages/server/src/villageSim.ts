import {
  BLOCK_SIZE,
  CROP_STAGE_MS,
  DRIFT_M,
  GATHER,
  GATHER_TOOL,
  START_COINS,
  START_STOCK,
  STOCK_MAX,
  BREAD_WHEAT,
  WHEAT_KEPT,
  MAX_TOOLS,
  Item,
  stagePieces,
  stockOf,
  villageOffers,
  type Offer,
  FOUNDERS,
  FOUND_M,
  JOIN_VILLAGE_M,
  MAX_COTTAGES,
  Material,
  PER_COTTAGE,
  RIPE,
  UNITS_PER_METER,
  VILLAGER_SPEED,
  VILLAGE_RADIUS_M,
  VILLAGER_SEAT,
  GATES,
  WALL_AT,
  WALL_M,
  WALL_SECTIONS,
  inGate,
  wallSection,
  wallStage,
  avatarText,
  cottageStage,
  cropStage,
  defaultAvatar,
  villageName,
  villagePlot,
  villagerName,
  type Avatar,
  type Cottage,
  type EntitySnapshot,
  type Field,
  type Village,
  type VillagePiece,
  type Villager,
} from '@super-vox/shared';
import type { EditResult } from './world.js';

const M = UNITS_PER_METER, B = BLOCK_SIZE;
/** Wanderers come to land this big a square (m) the first time a player's near it, this many of them. */
const CELL_M = 2000;
const PER_CELL = 4;
/** A player this near a square's middle (m) brings its wanderers. */
const NEAR_CELL_M = 1800;
/** Choices made this often (s); kept this often (s), and when something changes. */
const THINK_S = 1;
const SAVE_S = 30;
/** Villages this far apart at least (m); and from trading posts. */
const APART_M = 400;
/** A ripe block harvested (and sown again) each this long (s), by a villager at the field. */
const HARVEST_S = 1.5;
/** Each this many bundles of wheat a village has in store, per villager, a newcomer comes to it. */
const WHEAT_PER_NEWCOMER = 12;

/** What the simulation needs of the world (see World): its ground, its size, building, and where players have built. */
export interface VillageWorld {
  config: { widthUnits: number; depthUnits: number };
  terrainAt(x: number, z: number): { h: number; water: boolean; tree: boolean; land: boolean };
  buildWorks(clear: readonly VillagePiece[], place: readonly VillagePiece[]): Promise<EditResult[]>;
  editedNear(x: number, z: number, r: number): boolean;
  /** Something else there (a trading post): no village within `r` units. */
  occupied?(x: number, z: number, r: number): boolean;
  /** The railway (see TrainYard), for going places by train and sending wheat off to sell. */
  rail?: Rail;
}

/** What villagers need of the railway: its stations and lines, trains stopped at stations, seats, and wheat loaded and unloaded. */
export interface Rail {
  stations(): { id: number; name: string; x: number; z: number }[];
  lines(): { stations: number[] }[];
  platformAt(id: number): { x: number; y: number; z: number } | null;
  stoppedAt(id: number, now: number): { train: { id: number }; line: { stations: number[] } }[];
  seat(train: number, who: number): { car: number; seat: number } | null;
  seatPose(who: number): { x: number; y: number; z: number; heading: number } | null;
  trainOfSeat(who: number): number | null;
  unseat(who: number): void;
  ship(train: number, village: number, wheat: number): number;
  unship(train: number): { village: number; wheat: number }[];
  /** Trading posts: where, and what they pay for a bundle of wheat (coins). */
  posts(): { x: number; z: number; wheat: number }[];
}

/** Stations this near a village (m) are its; this near a trading post, the post's. */
const STATION_NEAR_M = 400;
/** A newcomer comes to a village for each of this many coins it's had for its wheat. */
const COINS_PER_NEWCOMER = 20;
/** Villagers going places by train: at most this many from a village at once; a visit there this long (ms); waiting at most this long for a train (ms). */
const TRAVELLERS = 2;
const VISIT_MS = 3 * 60_000;
const WAIT_MS = 15 * 60_000;
/**
 * A village a player's this near (m) is watched: its villagers walk and work, building a piece at a
 * time (each PLACE_S s, within BUILD_REACH_M of it). One nobody's near goes on as CREW builders
 * would, a piece every PLACE_S s each, in batches; its villagers stay where they are.
 */
const OBSERVE_M = 300;
const PLACE_S = 1;
const BUILD_REACH_M = 4.5;
const CREW = 2;
/** Away (the world shut, nobody in it) longer than GAP_MS: caught up with, CATCH_UP_S at a time, at most CATCH_UP_MS of it. */
const GAP_MS = 5000;
const CATCH_UP_S = 60;
const CATCH_UP_MS = 4 * 3600_000;
/** What entities show villagers as: this and their id. */
const VILLAGER_ENTITY = 1_000_000;

/** A building job: a stage's pieces (in order), what's cleared first, how many are in so far (undefined: not cleared yet), where to stand to put one in; done, the next. */
interface Job {
  pieces: VillagePiece[];
  clear: VillagePiece[];
  placed: number | undefined;
  set(n: number): void;
  done(): void;
  standAt(piece: VillagePiece): { x: number; z: number };
}

/** A trip by train: where it's got to, the stations from and to, where they're visiting, and till when. */
interface Trip {
  stage: 'out' | 'wait' | 'ride' | 'visit' | 'back' | 'waitBack' | 'rideBack';
  from: number;
  to: number;
  dest: { x: number; z: number };
  until: number;
}

type Mode = 'wander' | 'join' | 'work' | 'field' | 'idle' | 'home';

/** A villager as the simulation has them: where they're going, and what they're doing. */
interface Walker extends Villager {
  tx: number;
  tz: number;
  mode: Mode;
  /** Time spent at what they're doing (s). */
  busy: number;
  /** Where to go first, in order, before where they're going (units): round a building's corner, or round a wall and through its gate. */
  path?: { x: number; z: number }[];
  /** Blocked just now (water, steep ground): somewhere off to the side first. */
  stuck?: boolean;
  /** Going somewhere by train. */
  trip?: Trip | null;
}

/** Kept (see save). */
interface SimSave {
  villagers: Villager[];
  villages: Village[];
  cells: string[];
  next: number;
  /** When it was last stepped (ms). */
  at?: number;
}

/** A repeatable random number in [0, 1). */
function rand(seed: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * A world's villagers and villages (see villages.ts): wanderers brought to land near players,
 * drifting toward each other; founding villages where FOUNDERS meet on good land; building their
 * cottages in stages (each written into the world) while someone works at them; tilling and sowing
 * a field by each, harvesting it when it's ripe; taking in wanderers and newcomers as they prosper;
 * home to their cottages at night. Stepped ten times a second; their choices made once a second.
 */
export class VillageSim {
  private readonly walkers = new Map<number, Walker>();
  private readonly villages = new Map<number, Village>();
  private readonly cells = new Set<string>();
  private next = 1;
  private thinkIn = 0;
  private saveIn = SAVE_S;
  private dirty = false;
  /** Whether what's told about villages has changed (to tell everyone). */
  changed = false;
  /** What's written into the world, in order (one at a time). */
  private writing: Promise<void> = Promise.resolve();
  /** Told what building changes in the world (to send on); and of a write that failed. */
  onEdits: ((r: EditResult[]) => void) | null = null;
  onError: ((err: unknown) => void) | null = null;
  /** The villages someone's near (see OBSERVE_M), as of the last choices made. */
  private readonly watched = new Set<number>();
  /** When last stepped (ms; null: not yet). */
  private at: number | null = null;
  /** Unwatched villages' building, pieces' worth owed (see coarse). */
  private readonly owed = new Map<number, number>();
  /** Stages' pieces, worked out (by village, cottage or wall section, and stage). */
  private readonly stages = new Map<string, { clear: VillagePiece[]; pieces: VillagePiece[] }>();
  /** Ground looked up, by 4 m square (it doesn't change: it's the ground as generated). */
  private readonly ground = new Map<string, { h: number; ok: boolean; tree: boolean }>();

  constructor(
    private readonly world: VillageWorld & { saveVillages?(s: unknown): void },
    raw?: unknown,
  ) {
    const saved = kept(raw);
    if (!saved) return;
    for (const v of saved.villages) {
      // (Kept before villages had stock or coins: as a new one's.)
      v.stock ??= { ...START_STOCK };
      v.coins ??= START_COINS;
      this.villages.set(v.id, v);
    }
    this.at = saved.at ?? null;
    for (const p of saved.villagers) this.walkers.set(p.id, { ...p, tx: p.x, tz: p.z, mode: p.home === null ? 'wander' : 'idle', busy: 0 });
    for (const c of saved.cells) this.cells.add(c);
    this.next = saved.next;
  }

  list(): Village[] {
    return [...this.villages.values()];
  }

  get population(): number {
    return this.walkers.size;
  }

  /** The village whose land (x, z) (units) is on, if any: theirs, not to be built on or dug. */
  villageAt(x: number, z: number): Village | null {
    for (const v of this.villages.values()) if (Math.hypot(v.x - x, v.z - z) < (VILLAGE_RADIUS_M + 8) * M) return v;
    return null;
  }

  /** Villagers within `r` units of (x, z), as they're seen. */
  near(x: number, z: number, r: number): EntitySnapshot[] {
    const out: EntitySnapshot[] = [];
    for (const p of this.walkers.values())
      if (Math.abs(p.x - x) < r && Math.abs(p.z - z) < r) out.push({ id: VILLAGER_ENTITY + p.id, kind: 'villager', x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), yaw: p.yaw, name: p.name, look: p.look, ...(p.home !== null ? { home: p.home } : {}) });
    return out;
  }

  /** What's kept. */
  save(): SimSave {
    return { villagers: [...this.walkers.values()].map(({ tx: _x, tz: _z, mode: _m, busy: _b, path: _p, stuck: _s, trip: _t, ...v }) => v), villages: this.list(), cells: [...this.cells], next: this.next, ...(this.at !== null ? { at: this.at } : {}) };
  }

  /** Done once what's been asked to be written into the world has been. */
  written(): Promise<void> {
    return this.writing;
  }

  /** Whether a village is watched (someone's near it: its villagers walking and working). */
  isWatched(id: number): boolean {
    return this.watched.has(id);
  }

  /** The ground at (x, z) (units, looked up a 4 m square at a time): its height, and whether it can be walked (land, not water). */
  private groundAt(x: number, z: number): { h: number; ok: boolean; tree: boolean } {
    const k = `${Math.floor(x / (4 * M))},${Math.floor(z / (4 * M))}`;
    let g = this.ground.get(k);
    if (!g) {
      if (this.ground.size > 200_000) this.ground.clear();
      const t = this.world.terrainAt(x, z);
      this.ground.set(k, (g = { h: t.h, ok: t.land && !t.water, tree: t.tree }));
    }
    return g;
  }

  /**
   * On `dt` s (now `now`, ms): wanderers brought near `players` (units), everyone walked on toward
   * where they're going; once a second, their choices; at `night`, home.
   */
  step(dt: number, now: number, players: readonly { x: number; z: number }[], night: boolean): void {
    // (Back after a while with nobody here: what would have happened meanwhile, roughly.)
    if (this.at !== null && now - this.at > GAP_MS) this.catchUp(this.at, now);
    this.at = now;
    for (const p of this.walkers.values()) {
      if (!this.detailed(p)) continue;
      // (On a train: where their seat is.)
      const seated = p.trip && (p.trip.stage === 'ride' || p.trip.stage === 'rideBack') ? this.world.rail?.seatPose(VILLAGER_SEAT + p.id) : null;
      if (seated) {
        p.x = seated.x;
        p.y = seated.y;
        p.z = seated.z;
        p.yaw = seated.heading;
        p.tx = p.x;
        p.tz = p.z;
        continue;
      }
      this.walk(p, dt);
    }
    this.thinkIn -= dt;
    if (this.thinkIn <= 0) {
      this.thinkIn = THINK_S;
      this.watch(players);
      this.bring(players, now);
      for (const p of this.walkers.values()) if (this.detailed(p)) this.think(p, now, night);
      for (const v of this.villages.values()) {
        if (!this.watched.has(v.id)) this.coarse(v, THINK_S, now);
        this.gather(v, THINK_S);
        this.grow(v, now);
      }
      this.found(now);
      this.freight(now);
    }
    this.saveIn -= dt;
    if ((this.dirty || this.changed) && this.saveIn <= 0) this.persist();
  }

  /** Kept now. */
  persist(): void {
    this.saveIn = SAVE_S;
    this.dirty = false;
    this.world.saveVillages?.(this.save());
  }

  /** Walks a villager toward where they're going: round buildings (by a corner), not into water or up steep ground (blocked there: they pick somewhere else). */
  private walk(p: Walker, dt: number): void {
    const to = p.path?.[0] ?? { x: p.tx, z: p.tz };
    const dx = to.x - p.x, dz = to.z - p.z, d = Math.hypot(dx, dz);
    if (d < 0.3 * M) {
      p.path?.shift();
      return;
    }
    const step = Math.min(d, VILLAGER_SPEED * M * dt), nx = p.x + (dx / d) * step, nz = p.z + (dz / d) * step;
    const here = this.groundAt(p.x, p.z), there = this.groundAt(nx, nz);
    // A wall in the way: round by a gate (on this side of it), then through.
    const wall = this.wallBetween(p, { x: nx, z: nz });
    if (wall && !p.path?.length) {
      p.path = this.gateFor(wall, p);
      return;
    }
    // (Inside one already, somehow: let out.)
    const building = this.buildingAt(p.x, p.z) ? null : this.buildingAt(nx, nz);
    if (building && !p.path?.length) {
      p.path = [this.corner(building, p, { x: p.tx, z: p.tz })];
      return;
    }
    if (!there.ok || Math.abs(there.h - here.h) > 1.6 * M || building || wall || nx < 0 || nz < 0 || nx >= this.world.config.widthUnits || nz >= this.world.config.depthUnits) {
      // (Blocked: stay, and somewhere else is chosen: off to the side, first.)
      p.tx = p.x;
      p.tz = p.z;
      p.path = [];
      p.stuck = true;
      return;
    }
    p.x = nx;
    p.z = nz;
    p.y = there.h;
    p.yaw = Math.atan2(-dx, -dz);
    this.dirty = true;
  }

  /** The cottage (being built, or built) whose footprint (x, z) (units) is in, if any. */
  private buildingAt(x: number, z: number): Cottage | null {
    const bx = Math.floor(x / B), bz = Math.floor(z / B);
    for (const v of this.villages.values()) {
      if (Math.abs(v.x - x) > 40 * M || Math.abs(v.z - z) > 40 * M) continue;
      for (const c of v.cottages) if (c.stage > 0 && bx >= c.bx && bx < c.bx + c.w && bz >= c.bz && bz < c.bz + c.d) return c;
    }
    return null;
  }

  /** The corner of a cottage (a little out from it) to go round it by, from `from` to `to` (units): the one making the shorter way of those reachable straight from `from`. */
  private corner(c: Cottage, from: { x: number; z: number }, to: { x: number; z: number }): { x: number; z: number } {
    const m = 1.2 * B, x0 = c.bx * B - m, x1 = (c.bx + c.w) * B + m, z0 = c.bz * B - m, z1 = (c.bz + c.d) * B + m;
    const corners = [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x0, z: z1 }, { x: x1, z: z1 }];
    // (Reached straight: the way there doesn't cross the footprint, checked a unit at a time, from
    // the start: a metre at a time, the first steps of a way from right beside the cottage weren't,
    // and one blocked there was sent the same way again, and again.)
    const clear = (a: { x: number; z: number }, b: { x: number; z: number }) => {
      const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z));
      for (let i = 1; i < n; i++) if (this.buildingAt(a.x + ((b.x - a.x) * i) / n, a.z + ((b.z - a.z) * i) / n) === c) return false;
      return true;
    };
    const way = (k: { x: number; z: number }) => Math.hypot(k.x - from.x, k.z - from.z) + Math.hypot(to.x - k.x, to.z - k.z);
    const reach = corners.filter((k) => clear(from, k));
    return (reach.length ? reach : corners).reduce((a, b) => (way(b) < way(a) ? b : a));
  }

  /** Wanderers to land near players that's not had any yet: PER_CELL to each CELL_M square, on land. */
  private bring(players: readonly { x: number; z: number }[], now: number): void {
    const C = CELL_M * M;
    for (const pl of players)
      for (let cx = Math.floor(pl.x / C) - 1; cx <= Math.floor(pl.x / C) + 1; cx++)
        for (let cz = Math.floor(pl.z / C) - 1; cz <= Math.floor(pl.z / C) + 1; cz++) {
          const key = `${cx},${cz}`;
          if (this.cells.has(key) || cx < 0 || cz < 0 || cx * C >= this.world.config.widthUnits || cz * C >= this.world.config.depthUnits) continue;
          if (Math.hypot((cx + 0.5) * C - pl.x, (cz + 0.5) * C - pl.z) > NEAR_CELL_M * M) continue;
          this.cells.add(key);
          this.dirty = true;
          for (let i = 0, made = 0; i < 20 && made < PER_CELL; i++) {
            const x = (cx + rand(cx * 7919 + cz * 104729 + i * 31) ) * C, z = (cz + rand(cx * 15485863 + cz * 32452843 + i * 17)) * C;
            if (x >= this.world.config.widthUnits || z >= this.world.config.depthUnits || !this.groundAt(x, z).ok) continue;
            this.add(x, z, now);
            made++;
          }
        }
  }

  /** A new wanderer at (x, z) (units). */
  private add(x: number, z: number, now: number, home: number | null = null): Walker {
    const id = this.next++, r = (k: number) => rand(id * 977 + k);
    const name = villagerName(id - 1);
    const look: Avatar = { ...defaultAvatar(name), figure: r(1) < 0.5 ? 'man' : 'woman', shirt: ['#7a5c3e', '#5e6b3a', '#7d3c33', '#4f5d75', '#8a7a52', '#6b4e71'][Math.floor(r(2) * 6)]!, trousers: ['#3e3a33', '#4a4f57', '#5a4632'][Math.floor(r(3) * 3)]! };
    const p: Walker = { id, name, look: avatarText(look), x, y: this.groundAt(x, z).h, z, yaw: 0, home, tx: x, tz: z, mode: home === null ? 'wander' : 'join', busy: 0 };
    this.walkers.set(id, p);
    this.dirty = true;
    void now;
    return p;
  }

  /** Somewhere a little way off to walk to, from (x, z) (units), within `r` m (on land, if it can find it). */
  private somewhere(x: number, z: number, r: number, seed: number): { x: number; z: number } {
    for (let i = 0; i < 8; i++) {
      const a = rand(seed + i * 13) * Math.PI * 2, d = (0.3 + 0.7 * rand(seed + i * 29)) * r * M;
      const tx = x + Math.cos(a) * d, tz = z + Math.sin(a) * d;
      if (tx > 0 && tz > 0 && tx < this.world.config.widthUnits && tz < this.world.config.depthUnits && this.groundAt(tx, tz).ok) return { x: tx, z: tz };
    }
    return { x, z };
  }

  private arrived = (p: Walker) => Math.hypot(p.tx - p.x, p.tz - p.z) < 0.5 * M;

  /** A villager's choices: where to go and what to do. */
  private think(p: Walker, now: number, night: boolean): void {
    const seed = p.id * 7 + Math.floor(now / 1000);
    if (p.home === null) {
      // A village near with room: there, to live.
      const v = this.villageWithRoom(p.x, p.z, JOIN_VILLAGE_M);
      if (v) {
        p.mode = 'join';
        p.tx = v.x;
        p.tz = v.z;
        if (Math.hypot(v.x - p.x, v.z - p.z) < VILLAGE_RADIUS_M * M) {
          p.home = v.id;
          p.mode = 'idle';
          this.changed = true;
        }
        return;
      }
      // Else toward the nearest other wanderer, if one's near; else on somewhere. (Blocked: a way off to the side first.)
      if (p.stuck) {
        p.stuck = false;
        const to = this.somewhere(p.x, p.z, 120, seed + 5);
        p.tx = to.x;
        p.tz = to.z;
        return;
      }
      if (!this.arrived(p) && rand(seed) > 0.05) return;
      let best: Walker | null = null, bd = DRIFT_M * M;
      for (const o of this.walkers.values()) {
        if (o === p || o.home !== null) continue;
        const d = Math.hypot(o.x - p.x, o.z - p.z);
        if (d < bd) (bd = d), (best = o);
      }
      const to = best ? this.somewhere(best.x, best.z, 12, seed) : this.somewhere(p.x, p.z, 300, seed);
      p.tx = to.x;
      p.tz = to.z;
      p.mode = 'wander';
      return;
    }
    const v = this.villages.get(p.home);
    if (!v) {
      p.home = null;
      return;
    }
    if (p.trip) return this.travel(p, p.trip, now);
    // At night: home (by their cottage's door, or the middle).
    if (night) {
      const c = v.cottages.filter((c) => c.stage >= 3)[this.homeOf(p, v)];
      const at = c ? this.doorstep(c) : { x: v.x, z: v.z };
      p.mode = 'home';
      p.tx = at.x;
      p.tz = at.z;
      return;
    }
    // Builders (the first two to live there) to a cottage going up, the rest to the fields; either
    // to the other when theirs needs nothing.
    const site = v.cottages.find((c) => c.stage < 3);
    const job = this.job(v);
    const field = v.fields.find((f) => (!f.tilled && v.cottages[v.fields.indexOf(f)]?.stage === 3) || f.sown.some((s) => cropStage(s, now) >= RIPE));
    // (At most four at one job: two builders, two more to help when the fields need nothing.)
    const rank = this.rankIn(p, v), builder = rank < 2, helper = rank < 4;
    // Building (a cottage going up; else, big enough, its wall): to where the next piece goes, and in with it.
    if (job && (builder || (helper && !field))) {
      p.mode = 'work';
      const piece = job.pieces[job.placed ?? 0];
      if (!piece) return void this.put(v, job, 0);
      const px = piece.x + piece.size / 2, pz = piece.z + piece.size / 2, spot = job.standAt(piece);
      // (Within reach: in it goes; blocked short of it, near enough will do.)
      const reach = Math.hypot(px - p.x, pz - p.z);
      if (reach <= BUILD_REACH_M * M || (p.stuck && reach <= 8 * M)) {
        p.stuck = false;
        p.busy += THINK_S;
        if (p.busy >= PLACE_S) {
          p.busy = 0;
          this.put(v, job, 1);
        }
      } else {
        p.stuck = false;
        p.tx = spot.x;
        p.tz = spot.z;
      }
      return;
    }
    // A field to till (its cottage built), or ripe: there, to work it.
    if (field) {
      const mid = { x: (field.bx + field.w / 2) * B, z: (field.bz + field.d / 2) * B };
      p.mode = 'field';
      if (Math.hypot(mid.x - p.x, mid.z - p.z) > (field.w / 2 + 2) * M) {
        p.tx = mid.x + (rand(seed) - 0.5) * field.w * M * 0.8;
        p.tz = mid.z + (rand(seed + 1) - 0.5) * field.d * M * 0.8;
      } else if (!field.tilled) {
        this.till(field, now);
      } else {
        p.busy += THINK_S;
        if (p.busy >= HARVEST_S) {
          p.busy = 0;
          const i = field.sown.findIndex((s) => cropStage(s, now) >= RIPE);
          if (i >= 0) {
            field.sown[i] = now;
            v.wheat++;
            this.changed = true;
            p.tx = (field.bx + (i % field.w) + 0.5) * B;
            p.tz = (field.bz + Math.floor(i / field.w) + 0.5) * B;
          }
        }
      }
      return;
    }
    // Nothing to do: now and then, off somewhere by train (if their village has a station on a line); else about the village.
    if (rank >= 4 && rand(seed + 7) < 1 / 120 && this.startTrip(p, v, now)) return;
    p.mode = 'idle';
    if (this.arrived(p) && rand(seed) < 0.3) {
      const to = this.somewhere(v.x, v.z, VILLAGE_RADIUS_M * 0.7, seed);
      p.tx = to.x;
      p.tz = to.z;
    }
  }

  /** A village's stations (those within STATION_NEAR_M of it), nearest first. */
  private stationsOf(v: { x: number; z: number }): { id: number; name: string; x: number; z: number }[] {
    return (this.world.rail?.stations() ?? []).filter((s) => Math.hypot(s.x - v.x, s.z - v.z) < STATION_NEAR_M * M).sort((a, b) => Math.hypot(a.x - v.x, a.z - v.z) - Math.hypot(b.x - v.x, b.z - v.z));
  }

  /** Somewhere to go from station `from`, by a line through it: another station near a village or a trading post, and the place itself. */
  private destination(from: number, seed: number): { to: number; dest: { x: number; z: number } } | null {
    const rail = this.world.rail!, all = rail.stations(), posts = rail.posts();
    const options: { to: number; dest: { x: number; z: number } }[] = [];
    for (const l of rail.lines()) {
      if (!l.stations.includes(from)) continue;
      for (const id of l.stations) {
        if (id === from) continue;
        const st = all.find((s) => s.id === id);
        if (!st) continue;
        for (const v of this.villages.values()) if (Math.hypot(v.x - st.x, v.z - st.z) < STATION_NEAR_M * M) options.push({ to: id, dest: { x: v.x, z: v.z } });
        for (const t of posts) if (Math.hypot(t.x - st.x, t.z - st.z) < STATION_NEAR_M * M) options.push({ to: id, dest: { x: t.x + 4 * M, z: t.z + 4 * M } });
      }
    }
    return options.length ? options[Math.floor(rand(seed) * options.length)]! : null;
  }

  /** `p` off on a trip by train, if their village has a station on a line to somewhere (and few others are away). */
  private startTrip(p: Walker, v: Village, now: number): boolean {
    if (!this.world.rail) return false;
    const away = [...this.walkers.values()].filter((o) => o.home === v.id && o.trip).length;
    if (away >= TRAVELLERS) return false;
    for (const st of this.stationsOf(v)) {
      const d = this.destination(st.id, p.id * 31 + Math.floor(now / 1000));
      if (!d) continue;
      p.trip = { stage: 'out', from: st.id, to: d.to, dest: d.dest, until: 0 };
      this.changed = true;
      return true;
    }
    return false;
  }

  /** A trip by train, a stage at a time: to the station, waiting, aboard, off at the other end, visiting, and the same back. */
  private travel(p: Walker, t: Trip, now: number): void {
    const rail = this.world.rail;
    const who = VILLAGER_SEAT + p.id;
    const end = () => {
      rail?.unseat(who);
      p.trip = null;
      p.mode = 'idle';
      this.changed = true;
    };
    if (!rail) return end();
    p.mode = 'idle';
    const goTo = (q: { x: number; z: number } | null) => {
      if (!q) return end();
      p.tx = q.x;
      p.tz = q.z;
    };
    switch (t.stage) {
      case 'out':
      case 'back': {
        const at = rail.platformAt(t.stage === 'out' ? t.from : t.to);
        goTo(at);
        if (at && Math.hypot(at.x - p.x, at.z - p.z) < 3 * M) (t.stage = t.stage === 'out' ? 'wait' : 'waitBack'), (t.until = now + WAIT_MS);
        return;
      }
      case 'wait':
      case 'waitBack': {
        const [here, there] = t.stage === 'wait' ? [t.from, t.to] : [t.to, t.from];
        const ride = rail.stoppedAt(here, now).find((s) => s.line.stations.includes(there) && rail.seat(s.train.id, who));
        if (ride) {
          t.stage = t.stage === 'wait' ? 'ride' : 'rideBack';
          this.changed = true;
        } else if (now > t.until) end();
        return;
      }
      case 'ride':
      case 'rideBack': {
        const train = rail.trainOfSeat(who), there = t.stage === 'ride' ? t.to : t.from;
        if (train === null) return end();
        if (rail.stoppedAt(there, now).some((s) => s.train.id === train)) {
          rail.unseat(who);
          const at = rail.platformAt(there);
          if (at) (p.x = at.x), (p.y = at.y), (p.z = at.z);
          if (t.stage === 'rideBack') return end();
          t.stage = 'visit';
          t.until = 0;
          this.changed = true;
        }
        return;
      }
      case 'visit': {
        goTo(t.dest);
        if (Math.hypot(t.dest.x - p.x, t.dest.z - p.z) < 6 * M && !t.until) t.until = now + VISIT_MS;
        if (t.until && now > t.until) t.stage = 'back';
        return;
      }
    }
  }

  /**
   * Wheat by rail: a village's (over what it keeps) loaded onto the flatbeds of line trains stopped
   * at its stations; at stations by trading posts, taken off and sold, the coins the village's.
   */
  private freight(now: number): void {
    const rail = this.world.rail;
    if (!rail) return;
    for (const v of this.villages.values()) {
      const spare = Math.floor(v.wheat - WHEAT_KEPT);
      if (spare <= 0) continue;
      for (const st of this.stationsOf(v))
        for (const { train } of rail.stoppedAt(st.id, now)) {
          const sent = rail.ship(train.id, v.id, Math.floor(v.wheat - WHEAT_KEPT));
          if (sent > 0) (v.wheat -= sent), (this.changed = true);
        }
    }
    const posts = rail.posts();
    for (const st of rail.stations()) {
      const post = posts.find((t) => Math.hypot(t.x - st.x, t.z - st.z) < STATION_NEAR_M * M);
      if (!post) continue;
      for (const { train } of rail.stoppedAt(st.id, now))
        for (const { village, wheat } of rail.unship(train.id)) {
          const v = this.villages.get(village);
          if (v) (v.coins = (v.coins ?? 0) + wheat * post.wheat), (this.changed = true);
        }
    }
  }

  /** Where `p` comes among those living in `v` (the order they came: their ids). */
  private rankIn(p: Walker, v: Village): number {
    return [...this.walkers.values()].filter((o) => o.home === v.id).map((o) => o.id).sort((a, b) => a - b).indexOf(p.id);
  }

  /** Which of a village's built cottages is `p`'s (two to each, in the order they came). */
  private homeOf(p: Walker, v: Village): number {
    return Math.floor(this.rankIn(p, v) / PER_COTTAGE);
  }

  /** Just outside a cottage's door (units). */
  private doorstep(c: Cottage): { x: number; z: number } {
    const mx = (c.bx + c.w / 2) * B, mz = (c.bz + c.d / 2) * B;
    const off = [{ x: 0, z: -1 }, { x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }][c.door]!;
    return { x: mx + off.x * (c.w / 2 + 1.2) * B, z: mz + off.z * (c.d / 2 + 1.2) * B };
  }

  /** A village within `r` m of (x, z) with room for another (fewer than two to each cottage it'll have). */
  private villageWithRoom(x: number, z: number, r: number): Village | null {
    for (const v of this.villages.values()) {
      if (Math.hypot(v.x - x, v.z - z) > r * M) continue;
      const members = [...this.walkers.values()].filter((o) => o.home === v.id).length;
      if (members < MAX_COTTAGES * PER_COTTAGE) return v;
    }
    return null;
  }

  /** Wanderers meeting (FOUNDERS within FOUND_M of each other) found a village on good land near them, if there's some. */
  private found(now: number): void {
    const free = [...this.walkers.values()].filter((p) => p.home === null);
    for (const p of free) {
      if (p.home !== null) continue;
      const group = free.filter((o) => o.home === null && Math.hypot(o.x - p.x, o.z - p.z) < FOUND_M * M);
      if (group.length < FOUNDERS) continue;
      const cx = group.reduce((s, o) => s + o.x, 0) / group.length, cz = group.reduce((s, o) => s + o.z, 0) / group.length;
      const site = this.site(cx, cz);
      if (!site) continue;
      const v: Village = { id: this.next++, name: villageName(this.villages.size), x: site.x, y: this.groundAt(site.x, site.z).h, z: site.z, founded: now, cottages: [], fields: [], wheat: 0, stock: { ...START_STOCK }, coins: START_COINS };
      this.villages.set(v.id, v);
      for (const o of group) (o.home = v.id), (o.mode = 'idle');
      this.plan(v);
      this.changed = true;
    }
  }

  /**
   * Somewhere near (x, z) (units, within 300 m) for a village: land, no water, not steep (its ground
   * within 6 m), not much forest, clear of other villages, trading posts and what players have built.
   */
  private site(x: number, z: number): { x: number; z: number } | null {
    const R = VILLAGE_RADIUS_M * M;
    for (let ring = 0; ring <= 10; ring++)
      for (let k = 0; k < Math.max(1, ring * 6); k++) {
        const a = (k / Math.max(1, ring * 6)) * Math.PI * 2, sx = x + Math.cos(a) * ring * 30 * M, sz = z + Math.sin(a) * ring * 30 * M;
        if (sx < R || sz < R || sx > this.world.config.widthUnits - R || sz > this.world.config.depthUnits - R) continue;
        if ([...this.villages.values()].some((v) => Math.hypot(v.x - sx, v.z - sz) < APART_M * M)) continue;
        if (this.world.editedNear(sx, sz, R + 16 * M) || this.world.occupied?.(sx, sz, R + 60 * M)) continue;
        let lo = Infinity, hi = -Infinity, trees = 0, ok = true;
        for (let i = -4; i <= 4 && ok; i++)
          for (let j = -4; j <= 4 && ok; j++) {
            const g = this.groundAt(sx + (i * R) / 4, sz + (j * R) / 4);
            if (!g.ok) ok = false;
            lo = Math.min(lo, g.h);
            hi = Math.max(hi, g.h);
            if (g.tree) trees++;
          }
        if (ok && hi - lo <= 6 * M && trees <= 30) return { x: sx, z: sz };
      }
    return null;
  }

  /** The next cottage (and its field) planned for a village, where its ground's good (flat, dry, open); none if there's nowhere left. */
  private plan(v: Village): boolean {
    const cx = Math.floor(v.x / B), cz = Math.floor(v.z / B);
    for (let n = v.cottages.length; n < MAX_COTTAGES + 6; n++) {
      const { cottage, field } = villagePlot(cx, cz, n % MAX_COTTAGES);
      // (Not on, or hard by, what it has already: a cottage or field (kept from an older layout, say).)
      const overlaps = (a: { bx: number; bz: number; w: number; d: number }, b: { bx: number; bz: number; w: number; d: number }) => a.bx - 1 < b.bx + b.w && b.bx - 1 < a.bx + a.w && a.bz - 1 < b.bz + b.d && b.bz - 1 < a.bz + a.d;
      if ([...v.cottages, ...v.fields].some((o) => overlaps(o, cottage) || overlaps(o, field))) continue;
      const tops: number[] = [];
      let ok = true, floor = -Infinity;
      for (let x = cottage.bx - 1; x <= cottage.bx + cottage.w && ok; x++)
        for (let z = cottage.bz - 1; z <= cottage.bz + cottage.d && ok; z++) {
          const g = this.groundAt((x + 0.5) * B, (z + 0.5) * B);
          if (!g.ok) ok = false;
          floor = Math.max(floor, Math.ceil(g.h / B));
        }
      for (let z = field.bz; z < field.bz + field.d && ok; z++)
        for (let x = field.bx; x < field.bx + field.w && ok; x++) {
          const g = this.groundAt((x + 0.5) * B, (z + 0.5) * B);
          if (!g.ok) ok = false;
          tops.push(Math.ceil(g.h / B));
        }
      if (!ok || Math.max(...tops) - Math.min(...tops) > 2) continue;
      v.cottages.push({ ...cottage, floor: floor + 1, stage: 0, work: 0 });
      v.fields.push({ ...field, tops, sown: tops.map(() => 0), tilled: false });
      this.changed = true;
      return true;
    }
    return false;
  }

  /** Whether a village is to wall itself (it's WALL_AT, and its wall isn't done). */
  private wallDue(v: Village): boolean {
    return (v.wall ?? 0) < WALL_SECTIONS && [...this.walkers.values()].filter((p) => p.home === v.id).length >= WALL_AT;
  }

  /** A walled village's wall between two points (units), if the way crosses it other than at a gate: the village. */
  private wallBetween(a: { x: number; z: number }, b: { x: number; z: number }): Village | null {
    for (const v of this.villages.values()) {
      if (!v.wall) continue;
      const ra = Math.hypot(a.x - v.x, a.z - v.z) / M, rb = Math.hypot(b.x - v.x, b.z - v.z) / M;
      if ((ra - WALL_M) * (rb - WALL_M) > 0 && Math.abs(rb - WALL_M) > 0.6) continue;
      // (On its line already, somehow (it built where they stood): let off it, either side.)
      if (Math.abs(ra - WALL_M) <= 0.6 && Math.abs(rb - WALL_M) > Math.abs(ra - WALL_M)) continue;
      const angle = Math.atan2(b.z - v.z, b.x - v.x);
      if (inGate(angle)) continue;
      // (Only the sections built so far.)
      if (wallSection(angle) < v.wall) return v;
    }
    return null;
  }

  /**
   * The way through the nearer gate of `v`: round the wall to it on the side `p` is on (outside, a
   * point every 30° or so, a little way out: a straight line between two points outside a ring can
   * cut through it; inside, straight there), to the gate, and out the other side.
   */
  private gateFor(v: Village, p: { x: number; z: number }): { x: number; z: number }[] {
    const inside = Math.hypot(p.x - v.x, p.z - v.z) < WALL_M * M, near = (WALL_M + (inside ? -2.5 : 3)) * M, far = (WALL_M + (inside ? 3 : -2.5)) * M;
    const from = Math.atan2(p.z - v.z, p.x - v.x), turn = (g: number) => Math.atan2(Math.sin(g - from), Math.cos(g - from));
    const gate = GATES.reduce((a, g) => (Math.abs(turn(g)) < Math.abs(turn(a)) ? g : a)), sweep = turn(gate);
    const at = (a: number, r: number) => ({ x: v.x + Math.cos(a) * r, z: v.z + Math.sin(a) * r });
    const way: { x: number; z: number }[] = [];
    if (!inside) {
      const n = Math.ceil(Math.abs(sweep) / (Math.PI / 6));
      for (let i = 0; i < n; i++) way.push(at(from + (sweep * i) / n, near));
    }
    way.push(at(gate, near), at(gate, far));
    return way;
  }

  /** A field tilled (its top blocks farmland, what's over them cleared) and sown. */
  private till(f: Field, now: number): void {
    const clear: VillagePiece[] = [], place: VillagePiece[] = [];
    for (let i = 0; i < f.tops.length; i++) {
      const x = (f.bx + (i % f.w)) * B, z = (f.bz + Math.floor(i / f.w)) * B, top = f.tops[i]!;
      // (The ground's top block too: part-filled, it's no room for a whole one; made farmland.)
      for (let y = top - 1; y < top + 3; y++) clear.push({ x, y: y * B, z, size: B, material: Material.Air });
      place.push({ x, y: (top - 1) * B, z, size: B, material: Material.Farmland });
    }
    f.tilled = true;
    f.sown = f.sown.map(() => now);
    this.changed = true;
    this.write(clear, place);
  }

  /** Written into the world, after whatever's waiting to be. */
  private write(clear: readonly VillagePiece[], place: readonly VillagePiece[]): void {
    this.writing = this.writing
      .then(() => this.world.buildWorks(clear, place))
      .then(
        (results) => this.onEdits?.(results),
        (err: unknown) => this.onError?.(err),
      );
  }

  /** The ground's top at a block column (block y). */
  private top = (bx: number, bz: number) => Math.floor(this.groundAt((bx + 0.5) * B, (bz + 0.5) * B).h / B);

  /** What a village is building now: a cottage going up; else (it's WALL_AT) the next section of its wall; else nothing. */
  private job(v: Village): Job | null {
    const c = v.cottages.find((c) => c.stage < 3);
    if (c) {
      const key = `${v.id} c${c.bx},${c.bz} ${c.stage + 1}`;
      let st = this.stages.get(key);
      if (!st) {
        const { clear, place } = cottageStage(c, c.stage + 1, this.top);
        this.stages.set(key, (st = { clear, pieces: stagePieces(place) }));
      }
      const m = 1.2 * B, x0 = c.bx * B - m, x1 = (c.bx + c.w) * B + m, z0 = c.bz * B - m, z1 = (c.bz + c.d) * B + m;
      return {
        ...st,
        placed: c.placed,
        set: (n) => (c.placed = n),
        done: () => {
          this.stages.delete(key);
          c.stage++;
          c.work = 0;
          delete c.placed;
        },
        // (Just outside its footprint, the nearest there to the piece.)
        standAt: (piece) => {
          const px = piece.x + piece.size / 2, pz = piece.z + piece.size / 2;
          if (px < x0 || px > x1 || pz < z0 || pz > z1) return { x: px, z: pz };
          const out = [{ d: px - x0, x: x0, z: pz }, { d: x1 - px, x: x1, z: pz }, { d: pz - z0, x: px, z: z0 }, { d: z1 - pz, x: px, z: z1 }];
          const best = out.reduce((a, b) => (b.d < a.d ? b : a));
          return { x: best.x, z: best.z };
        },
      };
    }
    if (!this.wallDue(v)) return null;
    const section = v.wall ?? 0, key = `${v.id} w${section}`;
    let st = this.stages.get(key);
    if (!st) {
      const { clear, place } = wallStage(Math.floor(v.x / B), Math.floor(v.z / B), section, (bx, bz) => Math.ceil(this.groundAt((bx + 0.5) * B, (bz + 0.5) * B).h / B));
      this.stages.set(key, (st = { clear, pieces: stagePieces(place) }));
    }
    return {
      ...st,
      placed: v.wallPlaced,
      set: (n) => (v.wallPlaced = n),
      done: () => {
        this.stages.delete(key);
        v.wall = section + 1;
        v.wallWork = 0;
        delete v.wallPlaced;
      },
      // (Inside it, 2 m in from its line, by the piece: one standing on the line would be walled in.)
      standAt: (piece) => {
        const a = Math.atan2(piece.z + piece.size / 2 - v.z, piece.x + piece.size / 2 - v.x), r = (WALL_M - 2) * M;
        return { x: v.x + Math.cos(a) * r, z: v.z + Math.sin(a) * r };
      },
    };
  }

  /**
   * Up to `most` more of a job's pieces put in, as its village's stock has them (its site cleared
   * first): written into the world together; done, if that's all of them. How many went in.
   */
  private put(v: Village, job: Job, most: number): number {
    const stock = (v.stock ??= { ...START_STOCK }), out: VillagePiece[] = [];
    let placed = job.placed, clear: VillagePiece[] = [];
    if (placed === undefined) (clear = job.clear), (placed = 0);
    while (out.length < most && placed < job.pieces.length) {
      const piece = job.pieces[placed]!, k = stockOf(piece.material);
      if (k && stock[k] < 1) break;
      if (k) stock[k] -= 1;
      out.push(piece);
      placed++;
    }
    job.set(placed);
    if (clear.length || out.length) this.write(clear, out);
    if (placed >= job.pieces.length) job.done();
    if (clear.length || out.length) this.changed = true;
    return out.length;
  }

  /** Who's near (see OBSERVE_M): the villages watched. */
  private watch(players: readonly { x: number; z: number }[]): void {
    this.watched.clear();
    for (const v of this.villages.values()) if (players.some((p) => Math.hypot(p.x - v.x, p.z - v.z) < OBSERVE_M * M)) this.watched.add(v.id);
  }

  /** Whether a villager's walked and thinks for themselves: wanderers, those away by train, and the people of watched villages. */
  private detailed(p: Walker): boolean {
    return p.home === null || !!p.trip || this.watched.has(p.home);
  }

  /**
   * An unwatched village `dt` s on, roughly: its fields tilled once their cottages are up, ripe wheat
   * harvested (as many times as it's ripened since); its building on as CREW builders would.
   */
  private coarse(v: Village, dt: number, now: number): void {
    const cycle = CROP_STAGE_MS * RIPE;
    v.fields.forEach((f, i) => {
      if (!f.tilled) {
        if (v.cottages[i]?.stage === 3) this.till(f, now);
        return;
      }
      f.sown.forEach((s, k) => {
        const n = s ? Math.floor((now - s) / cycle) : 0;
        if (n <= 0) return;
        f.sown[k] = s + n * cycle;
        v.wheat += n;
        this.changed = true;
      });
    });
    const members = [...this.walkers.values()].filter((p) => p.home === v.id).length;
    let owed = (this.owed.get(v.id) ?? 0) + (Math.min(CREW, members) * dt) / PLACE_S;
    for (let job = this.job(v); job && owed >= 1; job = this.job(v)) {
      const n = Math.floor(owed), put = this.put(v, job, n);
      owed -= put;
      // (Out of stock: nothing owed for the time it's waited.)
      if (put < n && (job.placed ?? 0) < job.pieces.length) owed = 0;
    }
    this.owed.set(v.id, this.job(v) ? Math.min(owed, 10) : 0);
  }

  /** What a village gathers to build with, `dt` s of it (faster with tools; up to STOCK_MAX). */
  private gather(v: Village, dt: number): void {
    const s = (v.stock ??= { ...START_STOCK }), t = v.tools ?? { axes: 0, picks: 0 }, m = dt / 60;
    s.wood = Math.min(STOCK_MAX.wood, s.wood + GATHER.wood * (1 + GATHER_TOOL * t.axes) * m);
    s.planks = Math.min(STOCK_MAX.planks, s.planks + GATHER.planks * (1 + GATHER_TOOL * t.axes) * m);
    s.cobble = Math.min(STOCK_MAX.cobble, s.cobble + GATHER.cobble * (1 + GATHER_TOOL * t.picks) * m);
    this.dirty = true;
  }

  /** From `from` to `to` (ms): every village on (coarse), CATCH_UP_S at a time, the last CATCH_UP_MS of it at most. */
  private catchUp(from: number, to: number): void {
    for (let t = Math.max(from, to - CATCH_UP_MS); t < to; ) {
      const dt = Math.min(CATCH_UP_S, (to - t) / 1000);
      t += dt * 1000;
      for (const v of this.villages.values()) {
        this.coarse(v, dt, t);
        this.gather(v, dt);
        this.grow(v, t);
      }
    }
    this.changed = true;
  }

  // ---- Trading (see villageOffers): with any villager, for their village.

  /** A villager (by their entity id) and the village they live in, if they have one. */
  villagerOf(entity: number): { x: number; y: number; z: number; name: string; village: Village } | null {
    const p = this.walkers.get(entity - VILLAGER_ENTITY), v = p && p.home !== null ? this.villages.get(p.home) : undefined;
    return p && v ? { x: p.x, y: p.y, z: p.z, name: p.name, village: v } : null;
  }

  /** A village's offers now. */
  offers(v: Village): { sells: Offer[]; buys: Offer[] } {
    return villageOffers(v);
  }

  /** A player bought `lots` lots of what `v` sells (see villageOffers; checked already): its wheat used, the coins its. */
  sold(v: Village, item: number, lots: number, price: number): void {
    v.wheat -= item === Item.Bread ? lots * BREAD_WHEAT : lots * 4;
    v.coins = (v.coins ?? 0) + price;
    this.changed = true;
  }

  /** A player sold `v` `amount` of what it buys (blocks by volume; tools by count), for `price` coins of its. */
  bought(v: Village, item: number, amount: number, price: number, blockVolume: number): void {
    const stock = (v.stock ??= { ...START_STOCK }), tools = (v.tools ??= { axes: 0, picks: 0 });
    if (item === Item.IronAxe) tools.axes = Math.min(MAX_TOOLS, tools.axes + amount);
    else if (item === Item.IronPickaxe) tools.picks = Math.min(MAX_TOOLS, tools.picks + amount);
    else {
      const k = stockOf(item);
      if (k) stock[k] += amount / blockVolume;
    }
    v.coins = (v.coins ?? 0) - price;
    this.changed = true;
  }

  /** A village growing: another cottage when it's full and none's going up; a newcomer when it's prospered. */
  private grow(v: Village, now: number): void {
    const members = [...this.walkers.values()].filter((p) => p.home === v.id);
    const going = v.cottages.some((c) => c.stage < 3);
    if (!going && v.cottages.length < MAX_COTTAGES && members.length > v.cottages.length * PER_COTTAGE - 1) this.plan(v);
    if ((v.coins ?? 0) >= COINS_PER_NEWCOMER + START_COINS && members.length < MAX_COTTAGES * PER_COTTAGE) {
      v.coins! -= COINS_PER_NEWCOMER;
      const at = this.somewhere(v.x, v.z, 120, v.id * 37 + Math.floor(now / 1000));
      this.add(at.x, at.z, now, v.id);
      this.changed = true;
    }
    if (v.wheat >= WHEAT_PER_NEWCOMER * Math.max(1, members.length) && members.length < MAX_COTTAGES * PER_COTTAGE) {
      v.wheat -= WHEAT_PER_NEWCOMER * Math.max(1, members.length);
      const at = this.somewhere(v.x, v.z, 200, v.id * 31 + Math.floor(now / 1000));
      this.add(at.x, at.z, now, v.id);
      this.changed = true;
    }
  }
}

/** Villages and villagers as kept, if they look like it (what doesn't, left out). */
function kept(raw: unknown): SimSave | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<SimSave>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const villagers = (Array.isArray(r.villagers) ? r.villagers : []).filter((p): p is Villager => typeof p === 'object' && p !== null && Number.isInteger(p.id) && typeof p.name === 'string' && typeof p.look === 'string' && num(p.x) && num(p.y) && num(p.z) && num(p.yaw) && (p.home === null || Number.isInteger(p.home)));
  const villages = (Array.isArray(r.villages) ? r.villages : []).filter(
    (v): v is Village => typeof v === 'object' && v !== null && Number.isInteger(v.id) && typeof v.name === 'string' && num(v.x) && num(v.z) && Array.isArray(v.cottages) && Array.isArray(v.fields) && num(v.wheat),
  );
  return { villagers, villages, cells: (Array.isArray(r.cells) ? r.cells : []).filter((c): c is string => typeof c === 'string'), next: num(r.next) ? r.next : 1, ...(num(r.at) ? { at: r.at } : {}) };
}
