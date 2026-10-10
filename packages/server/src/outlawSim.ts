import {
  BLOCK_SIZE,
  CAMP_APART_M,
  CAMP_JOIN_M,
  CAMP_MAX,
  OUTLAW_FAR_M,
  OUTLAW_FOUNDERS,
  OUTLAW_MEET_M,
  OUTLAW_NEAR_M,
  MOBS,
  UNITS_PER_METER,
  avatarText,
  campName,
  campStage,
  defaultAvatar,
  outlawName,
  pickDesign,
  type Avatar,
  type Camp,
  type Outlaw,
  type VillagePiece,
} from '@super-vox/shared';
import type { EditResult } from './world.js';

const M = UNITS_PER_METER, B = BLOCK_SIZE;
/** Loners come to land this big a square (m) the first time a player's this near its middle (m), this many. */
const CELL_M = 2000;
const NEAR_CELL_M = 1800;
const PER_CELL = 2;
/** Choices made this often (s); kept this often (s). */
const THINK_S = 1;
const SAVE_S = 30;
/** How fast they go (m/s) far from players (where they're records). */
const WALK = MOBS.outlaw.walk;
/** A loner drifts toward the nearest other within this far (m). */
const DRIFT_M = 1500;
/** A camp's lean-to goes up this long (ms) after its fire pit. */
const LEAN_TO_MS = 3 * 60_000;
/** A band goes off about once in ROAM_EVERY_S s (if there are two or more), for ROAM_MS, within ROAM_M (to a village, half the time, if there's one within ROAM_VILLAGE_M). */
const ROAM_EVERY_S = 600;
const ROAM_MS = 5 * 60_000;
const ROAM_M = 250;
const ROAM_VILLAGE_M = 500;
/** A camp with room gets a newcomer about once in this long (s). */
const RECRUIT_EVERY_S = 900;
/** A record heals this much a second. */
const HEAL = 0.05;
/** One in this many outlaws has a bow. */
const ARCHERS = 0.3;

/** What the simulation needs of the world: its ground and size, building, where players have built, and what else is where (villages, trading posts). */
export interface OutlawWorld {
  config: { widthUnits: number; depthUnits: number };
  terrainAt(x: number, z: number): { h: number; water: boolean; tree: boolean; land: boolean };
  buildWorks(clear: readonly VillagePiece[], place: readonly VillagePiece[]): Promise<EditResult[]>;
  editedNear(x: number, z: number, r: number): boolean;
  /** Villages and trading posts (units): camps keep away from them. */
  settlements(): { x: number; z: number; village: boolean }[];
  saveOutlaws?(s: unknown): void;
}

/** What it needs of the world's creatures (see MobManager): outlaws made creatures near players, and taken back. */
export interface OutlawMobs {
  addOutlaw(o: Outlaw, home: { x: number; z: number } | null, now: number): { id: number };
  remove(id: number): void;
  get(id: number): { x: number; y: number; z: number; health: number; home?: { x: number; z: number } | null } | undefined;
}

/** An outlaw as the simulation has them: a creature now (its mob id), or where they're going. */
interface Rec extends Outlaw {
  mob: number | null;
  tx: number;
  tz: number;
}

interface Save {
  outlaws: Outlaw[];
  camps: Camp[];
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
 * A world's outlaws (see outlaws.ts): loners brought to land near players, away from villages;
 * drifting toward each other; setting up camps where a couple meet; taking in loners; going off as
 * a band now and then. Near a player, each is a creature (MobManager: there they fight); further,
 * a record, moved roughly. Stepped ten times a second, its choices once a second.
 */
export class OutlawSim {
  private readonly outlaws = new Map<number, Rec>();
  private readonly camps = new Map<number, Camp>();
  private readonly cells = new Set<string>();
  private next = 1;
  private thinkIn = 0;
  private saveIn = SAVE_S;
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();
  /** Told what building changes in the world (to send on); and of a write that failed. */
  onEdits: ((r: EditResult[]) => void) | null = null;
  onError: ((err: unknown) => void) | null = null;
  /** An outlaw killed (as a creature): who, and where. */
  onDeath: ((o: Outlaw, at: { x: number; y: number; z: number }) => void) | null = null;

  constructor(
    private readonly world: OutlawWorld,
    raw?: unknown,
    private readonly random: () => number = Math.random,
  ) {
    const saved = kept(raw);
    if (!saved) return;
    for (const o of saved.outlaws) this.outlaws.set(o.id, { ...o, mob: null, tx: o.x, tz: o.z });
    for (const c of saved.camps) this.camps.set(c.id, c);
    for (const c of saved.cells) this.cells.add(c);
    this.next = saved.next;
  }

  list(): Camp[] {
    return [...this.camps.values()];
  }

  /** Whether the camps have changed since players were last told (see told). */
  changed = false;

  /** The camps as players are told them: with how many keep about each. */
  told(): (Camp & { people: number })[] {
    return this.list().map((c) => ({ ...c, people: this.membersOf(c) }));
  }

  /** The outlaws (as records: where they last were). */
  people(): Outlaw[] {
    return [...this.outlaws.values()].map(({ mob: _m, tx: _x, tz: _z, ...o }) => o);
  }

  /** The outlaw a creature is, if it's one. */
  ofMob(id: number): Outlaw | null {
    for (const o of this.outlaws.values()) if (o.mob === id) return o;
    return null;
  }

  save(): Save {
    return { outlaws: this.people(), camps: this.list(), cells: [...this.cells], next: this.next };
  }

  persist(): void {
    this.saveIn = SAVE_S;
    this.dirty = false;
    this.world.saveOutlaws?.(this.save());
  }

  /** Done once what's been asked to be written into the world has been. */
  written(): Promise<void> {
    return this.writing;
  }

  step(dt: number, now: number, players: readonly { x: number; z: number }[], mobs: OutlawMobs): void {
    const near = (o: { x: number; z: number }, r: number) => players.some((p) => Math.hypot(p.x - o.x, p.z - o.z) < r * M);
    // Creatures near players; records further off (a creature gone without being taken back: killed).
    for (const o of this.outlaws.values()) {
      if (o.mob !== null) {
        const m = mobs.get(o.mob);
        if (!m) {
          this.outlaws.delete(o.id);
          this.dirty = true;
          if (o.camp !== null) this.changed = true;
          this.onDeath?.(o, { x: o.x, y: o.y, z: o.z });
          continue;
        }
        Object.assign(o, { x: m.x, y: m.y, z: m.z, health: m.health });
        if (!near(o, OUTLAW_FAR_M)) {
          mobs.remove(o.mob);
          o.mob = null;
          o.tx = o.x;
          o.tz = o.z;
        } else if (m.home !== undefined) m.home = this.homeOf(o);
        this.dirty = true;
      } else if (near(o, OUTLAW_NEAR_M)) o.mob = mobs.addOutlaw(o, this.homeOf(o), now).id;
    }
    this.thinkIn -= dt;
    if (this.thinkIn <= 0) {
      this.thinkIn = THINK_S;
      this.bring(players);
      for (const o of this.outlaws.values()) if (o.mob === null) this.wander(o, THINK_S, now);
      this.found(now);
      for (const c of this.camps.values()) this.keep(c, now);
    }
    this.saveIn -= dt;
    if (this.dirty && this.saveIn <= 0) this.persist();
  }

  /** Where an outlaw keeps about: their band's roaming, or their camp; a loner, nowhere. */
  private homeOf(o: Outlaw): { x: number; z: number } | null {
    const c = o.camp !== null ? this.camps.get(o.camp) : undefined;
    return c ? (c.roam ? { x: c.roam.x, z: c.roam.z } : { x: c.x, z: c.z }) : null;
  }

  private ground(x: number, z: number): { h: number; ok: boolean; tree: boolean } {
    const t = this.world.terrainAt(x, z);
    return { h: t.h, ok: t.land && !t.water, tree: t.tree };
  }

  private inside = (x: number, z: number) => x > 0 && z > 0 && x < this.world.config.widthUnits && z < this.world.config.depthUnits;

  /** Somewhere on land within `r` m of (x, z) (units), if it can find it. */
  private somewhere(x: number, z: number, r: number, seed: number): { x: number; z: number } {
    for (let i = 0; i < 8; i++) {
      const a = rand(seed + i * 13) * Math.PI * 2, d = (0.3 + 0.7 * rand(seed + i * 29)) * r * M;
      const tx = x + Math.cos(a) * d, tz = z + Math.sin(a) * d;
      if (this.inside(tx, tz) && this.ground(tx, tz).ok) return { x: tx, z: tz };
    }
    return { x, z };
  }

  private add(x: number, z: number, camp: number | null): Rec {
    const id = this.next++, r = (k: number) => rand(id * 7919 + k);
    const name = outlawName(id - 1);
    const look: Avatar = { ...defaultAvatar(name), figure: r(1) < 0.7 ? 'man' : 'woman', shirt: ['#2b2b2b', '#4a2f2f', '#3b3f2a', '#2f3a44'][Math.floor(r(2) * 4)]!, trousers: ['#1f1f1f', '#3a2e22'][Math.floor(r(3) * 2)]! };
    const o: Rec = { id, name, look: avatarText(look), x, y: this.ground(x, z).h, z, health: MOBS.outlaw.health, camp, archer: this.random() < ARCHERS, mob: null, tx: x, tz: z };
    this.outlaws.set(id, o);
    this.dirty = true;
    return o;
  }

  /** Clear of villages, trading posts and other camps (within CAMP_APART_M), and of what players have built. */
  private clearOf(x: number, z: number): boolean {
    const R = CAMP_APART_M * M;
    if (this.world.settlements().some((s) => Math.hypot(s.x - x, s.z - z) < R)) return false;
    if ([...this.camps.values()].some((c) => Math.hypot(c.x - x, c.z - z) < R)) return false;
    return !this.world.editedNear(x, z, 30 * M);
  }

  /** Loners to land near players that's not had any yet (PER_CELL to each CELL_M square), away from villages and posts. */
  private bring(players: readonly { x: number; z: number }[]): void {
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
            const x = (cx + rand(cx * 104723 + cz * 7907 + i * 41)) * C, z = (cz + rand(cx * 32452843 + cz * 15485863 + i * 23)) * C;
            if (!this.inside(x, z) || !this.ground(x, z).ok) continue;
            if (this.world.settlements().some((s) => Math.hypot(s.x - x, s.z - z) < 300 * M)) continue;
            // (Not on top of a player either.)
            if (players.some((p) => Math.hypot(p.x - x, p.z - z) < OUTLAW_FAR_M * M)) continue;
            this.add(x, z, null);
            made++;
          }
        }
  }

  /** A record on, `dt` s of walking: loners toward the nearest other loner (or anywhere), the camp's to its fire (or where their band's gone). */
  private wander(o: Rec, dt: number, now: number): void {
    o.health = Math.min(MOBS.outlaw.health, o.health + HEAL * dt);
    const home = this.homeOf(o), seed = o.id * 31 + Math.floor(now / 1000);
    if (Math.hypot(o.tx - o.x, o.tz - o.z) < 1 * M) {
      if (home) {
        const to = this.somewhere(home.x, home.z, 8, seed);
        o.tx = to.x;
        o.tz = to.z;
      } else if (rand(seed) < 0.2) {
        let best: Rec | null = null, bd = DRIFT_M * M;
        for (const p of this.outlaws.values()) {
          if (p === o || p.camp !== null) continue;
          const d = Math.hypot(p.x - o.x, p.z - o.z);
          if (d < bd) (bd = d), (best = p);
        }
        const to = best ? this.somewhere(best.x, best.z, 10, seed) : this.somewhere(o.x, o.z, 300, seed);
        o.tx = to.x;
        o.tz = to.z;
      }
    }
    // Loners join a camp near with room.
    if (o.camp === null) {
      const c = [...this.camps.values()].find((c) => Math.hypot(c.x - o.x, c.z - o.z) < CAMP_JOIN_M * M && this.membersOf(c) < CAMP_MAX);
      if (c) {
        o.camp = c.id;
        this.dirty = true;
        this.changed = true;
      }
    }
    const dx = o.tx - o.x, dz = o.tz - o.z, d = Math.hypot(dx, dz);
    if (d < 1) return;
    const step = Math.min(d, WALK * M * dt), nx = o.x + (dx / d) * step, nz = o.z + (dz / d) * step, g = this.ground(nx, nz);
    // (Not into water: somewhere else next time.)
    if (!g.ok) {
      o.tx = o.x;
      o.tz = o.z;
      return;
    }
    o.x = nx;
    o.z = nz;
    o.y = g.h;
    this.dirty = true;
  }

  private membersOf(c: Camp): number {
    let n = 0;
    for (const o of this.outlaws.values()) if (o.camp === c.id) n++;
    return n;
  }

  /** Loners meeting (OUTLAW_FOUNDERS within OUTLAW_MEET_M) set up a camp near them, where there's open land clear of everyone else. */
  private found(now: number): void {
    const loners = [...this.outlaws.values()].filter((o) => o.camp === null);
    for (const o of loners) {
      if (o.camp !== null) continue;
      const group = loners.filter((p) => p.camp === null && Math.hypot(p.x - o.x, p.z - o.z) < OUTLAW_MEET_M * M);
      if (group.length < OUTLAW_FOUNDERS) continue;
      const site = this.site(o.x, o.z);
      if (!site) continue;
      const c: Camp = { id: this.next++, name: campName(this.camps.size), x: site.x, y: this.ground(site.x, site.z).h, z: site.z, stage: 0, founded: now, roam: null };
      this.camps.set(c.id, c);
      this.changed = true;
      for (const p of group.slice(0, CAMP_MAX)) p.camp = c.id;
      this.build(c, 1);
      this.dirty = true;
    }
  }

  /** Somewhere near (x, z) (units, within 200 m) for a camp: land, flat (within 2 m over 6 m round), few trees, clear of everyone else. */
  private site(x: number, z: number): { x: number; z: number } | null {
    for (let ring = 0; ring <= 6; ring++)
      for (let k = 0; k < Math.max(1, ring * 6); k++) {
        const a = (k / Math.max(1, ring * 6)) * Math.PI * 2, sx = x + Math.cos(a) * ring * 30 * M, sz = z + Math.sin(a) * ring * 30 * M;
        if (!this.inside(sx - 10 * M, sz - 10 * M) || !this.inside(sx + 10 * M, sz + 10 * M) || !this.clearOf(sx, sz)) continue;
        let lo = Infinity, hi = -Infinity, trees = 0, ok = true;
        for (let i = -2; i <= 2 && ok; i++)
          for (let j = -2; j <= 2 && ok; j++) {
            const g = this.ground(sx + i * 3 * M, sz + j * 3 * M);
            if (!g.ok) ok = false;
            lo = Math.min(lo, g.h);
            hi = Math.max(hi, g.h);
            if (g.tree) trees++;
          }
        if (ok && hi - lo <= 2 * M && trees <= 3) return { x: Math.floor(sx / B) * B + B / 2, z: Math.floor(sz / B) * B + B / 2 };
      }
    return null;
  }

  /** A camp's stage `stage` written into the world. */
  private build(c: Camp, stage: number): void {
    const top = (bx: number, bz: number) => Math.ceil(this.ground((bx + 0.5) * B, (bz + 0.5) * B).h / B);
    // (Of the designs standing in for the piece, if there are any: one of them, by the camp.)
    const design = pickDesign(stage === 1 ? 'campfire' : 'lean-to', c.id);
    const { clear, place } = campStage(Math.floor(c.x / B), Math.floor(c.z / B), stage, top, design);
    c.stage = stage;
    this.changed = true;
    this.writing = this.writing.then(() => this.world.buildWorks(clear, place)).then(
      (r) => this.onEdits?.(r),
      (err: unknown) => this.onError?.(err),
    );
  }

  /** A camp kept up: its lean-to built in time; its band off now and then (and back); a newcomer now and then while it has room. */
  private keep(c: Camp, now: number): void {
    if (c.stage < 2 && now - c.founded >= LEAN_TO_MS) {
      this.build(c, 2);
      this.dirty = true;
    }
    const members = this.membersOf(c);
    if (c.roam && now > c.roam.until) {
      c.roam = null;
      this.dirty = true;
    } else if (!c.roam && members >= 2 && this.random() < THINK_S / ROAM_EVERY_S) {
      const villages = this.world.settlements().filter((s) => s.village && Math.hypot(s.x - c.x, s.z - c.z) < ROAM_VILLAGE_M * M);
      const v = villages.length && this.random() < 0.5 ? villages[Math.floor(this.random() * villages.length)]! : null;
      const to = v ? { x: v.x, z: v.z } : this.somewhere(c.x, c.z, ROAM_M, Math.floor(now / 1000) + c.id);
      c.roam = { ...to, until: now + ROAM_MS };
      this.dirty = true;
    }
    if (members < CAMP_MAX && this.random() < THINK_S / RECRUIT_EVERY_S) {
      const at = this.somewhere(c.x, c.z, 250, Math.floor(now / 1000) * 3 + c.id);
      if (Math.hypot(at.x - c.x, at.z - c.z) > 100 * M) this.add(at.x, at.z, null);
    }
  }
}

/** Outlaws and camps as kept, if they look like it (what doesn't, left out). */
function kept(raw: unknown): Save | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<Save>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const outlaws = (Array.isArray(r.outlaws) ? r.outlaws : []).filter(
    (o): o is Outlaw => typeof o === 'object' && o !== null && Number.isInteger(o.id) && typeof o.name === 'string' && typeof o.look === 'string' && num(o.x) && num(o.y) && num(o.z) && num(o.health) && (o.camp === null || Number.isInteger(o.camp)) && typeof o.archer === 'boolean',
  );
  const camps = (Array.isArray(r.camps) ? r.camps : []).filter((c): c is Camp => typeof c === 'object' && c !== null && Number.isInteger(c.id) && typeof c.name === 'string' && num(c.x) && num(c.z) && num(c.stage) && num(c.founded));
  for (const c of camps) c.roam ??= null;
  return { outlaws, camps, cells: (Array.isArray(r.cells) ? r.cells : []).filter((c): c is string => typeof c === 'string'), next: num(r.next) ? r.next : 1 };
}
