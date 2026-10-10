import {
  BLOCK_SIZE,
  DRIFT_M,
  FOUNDERS,
  FOUND_M,
  JOIN_VILLAGE_M,
  MAX_COTTAGES,
  Material,
  PER_COTTAGE,
  RIPE,
  STAGE_S,
  UNITS_PER_METER,
  VILLAGER_SPEED,
  VILLAGE_RADIUS_M,
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
}

type Mode = 'wander' | 'join' | 'work' | 'field' | 'idle' | 'home';

/** A villager as the simulation has them: where they're going, and what they're doing. */
interface Walker extends Villager {
  tx: number;
  tz: number;
  mode: Mode;
  /** Time spent at what they're doing (s). */
  busy: number;
  /** A corner of a building on the way (units), gone round first. */
  via?: { x: number; z: number } | null;
  /** Blocked just now (water, steep ground): somewhere off to the side first. */
  stuck?: boolean;
}

/** Kept (see save). */
interface SimSave {
  villagers: Villager[];
  villages: Village[];
  cells: string[];
  next: number;
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
  /** A stage being built or a field tilled now (one at a time). */
  private building = false;
  /** Told what building changes in the world (to send on). */
  onEdits: ((r: EditResult[]) => void) | null = null;
  /** Ground looked up, by 4 m square (it doesn't change: it's the ground as generated). */
  private readonly ground = new Map<string, { h: number; ok: boolean; tree: boolean }>();

  constructor(
    private readonly world: VillageWorld & { saveVillages?(s: unknown): void },
    raw?: unknown,
  ) {
    const saved = kept(raw);
    if (!saved) return;
    for (const v of saved.villages) this.villages.set(v.id, v);
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
      if (Math.abs(p.x - x) < r && Math.abs(p.z - z) < r) out.push({ id: 1_000_000 + p.id, kind: 'villager', x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), yaw: p.yaw, name: p.name, look: p.look });
    return out;
  }

  /** What's kept. */
  save(): SimSave {
    return { villagers: [...this.walkers.values()].map(({ tx: _x, tz: _z, mode: _m, busy: _b, ...v }) => v), villages: this.list(), cells: [...this.cells], next: this.next };
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
    for (const p of this.walkers.values()) this.walk(p, dt);
    this.thinkIn -= dt;
    if (this.thinkIn <= 0) {
      this.thinkIn = THINK_S;
      this.bring(players, now);
      for (const p of this.walkers.values()) this.think(p, now, night);
      for (const v of this.villages.values()) this.grow(v, now);
      this.found(now);
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
    const to = p.via ?? { x: p.tx, z: p.tz };
    const dx = to.x - p.x, dz = to.z - p.z, d = Math.hypot(dx, dz);
    if (d < 0.3 * M) {
      if (p.via) p.via = null;
      return;
    }
    const step = Math.min(d, VILLAGER_SPEED * M * dt), nx = p.x + (dx / d) * step, nz = p.z + (dz / d) * step;
    const here = this.groundAt(p.x, p.z), there = this.groundAt(nx, nz);
    // (Inside one already, somehow: let out.)
    const building = this.buildingAt(p.x, p.z) ? null : this.buildingAt(nx, nz);
    if (building && !p.via) {
      p.via = this.corner(building, p, { x: p.tx, z: p.tz });
      return;
    }
    if (!there.ok || Math.abs(there.h - here.h) > 1.6 * M || building || nx < 0 || nz < 0 || nx >= this.world.config.widthUnits || nz >= this.world.config.depthUnits) {
      // (Blocked: stay, and somewhere else is chosen: off to the side, first.)
      p.tx = p.x;
      p.tz = p.z;
      p.via = null;
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
    // (Reached straight: the way there doesn't cross the footprint, checked a metre at a time.)
    const clear = (a: { x: number; z: number }, b: { x: number; z: number }) => {
      const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / M);
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
    const field = v.fields.find((f) => (!f.tilled && v.cottages[v.fields.indexOf(f)]?.stage === 3) || f.sown.some((s) => cropStage(s, now) >= RIPE));
    const builder = this.rankIn(p, v) < 2;
    if (site && (builder || !field)) {
      const at = this.doorstep(site);
      p.mode = 'work';
      if (Math.hypot(at.x - p.x, at.z - p.z) > 6 * M) {
        p.tx = at.x + (rand(seed) - 0.5) * 4 * M;
        p.tz = at.z + (rand(seed + 1) - 0.5) * 4 * M;
      } else if (!this.building) {
        site.work += THINK_S;
        if (site.work >= STAGE_S) void this.raise(v, site);
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
        if (!this.building) void this.till(field, now);
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
    // Nothing to do: about the village.
    p.mode = 'idle';
    if (this.arrived(p) && rand(seed) < 0.3) {
      const to = this.somewhere(v.x, v.z, VILLAGE_RADIUS_M * 0.7, seed);
      p.tx = to.x;
      p.tz = to.z;
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
      const v: Village = { id: this.next++, name: villageName(this.villages.size), x: site.x, y: this.groundAt(site.x, site.z).h, z: site.z, founded: now, cottages: [], fields: [], wheat: 0 };
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
      if (v.cottages.some((c) => c.bx === cottage.bx && c.bz === cottage.bz)) continue;
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

  /** A cottage's next stage raised: written into the world, then it's done. */
  private async raise(v: Village, c: Cottage): Promise<void> {
    this.building = true;
    try {
      const stage = c.stage + 1;
      const { clear, place } = cottageStage(c, stage, (bx, bz) => Math.floor(this.groundAt((bx + 0.5) * B, (bz + 0.5) * B).h / B));
      const results = await this.world.buildWorks(clear, place);
      c.stage = stage;
      c.work = 0;
      this.changed = true;
      this.onEdits?.(results);
      void v;
    } finally {
      this.building = false;
    }
  }

  /** A field tilled (its top blocks farmland, what's over them cleared) and sown. */
  private async till(f: Field, now: number): Promise<void> {
    this.building = true;
    try {
      const clear: VillagePiece[] = [], place: VillagePiece[] = [];
      for (let i = 0; i < f.tops.length; i++) {
        const x = (f.bx + (i % f.w)) * B, z = (f.bz + Math.floor(i / f.w)) * B, top = f.tops[i]!;
        // (The ground's top block too: part-filled, it's no room for a whole one; made farmland.)
        for (let y = top - 1; y < top + 3; y++) clear.push({ x, y: y * B, z, size: B, material: Material.Air });
        place.push({ x, y: (top - 1) * B, z, size: B, material: Material.Farmland });
      }
      const results = await this.world.buildWorks(clear, place);
      f.tilled = true;
      f.sown = f.sown.map(() => now);
      this.changed = true;
      this.onEdits?.(results);
    } finally {
      this.building = false;
    }
  }

  /** A village growing: another cottage when it's full and none's going up; a newcomer when it's prospered. */
  private grow(v: Village, now: number): void {
    const members = [...this.walkers.values()].filter((p) => p.home === v.id);
    const going = v.cottages.some((c) => c.stage < 3);
    if (!going && v.cottages.length < MAX_COTTAGES && members.length > v.cottages.length * PER_COTTAGE - 1) this.plan(v);
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
  return { villagers, villages, cells: (Array.isArray(r.cells) ? r.cells : []).filter((c): c is string => typeof c === 'string'), next: num(r.next) ? r.next : 1 };
}
