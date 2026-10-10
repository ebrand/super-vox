import {
  CAR_GAP_M,
  CAR_SPECS,
  FLATBED_CRATES,
  PASSENGER_SEATS,
  crateOf,
  cratesFor,
  type ItemId,
  COAL_SECONDS,
  COUPLE_SPEED,
  MAX_COAL,
  UNITS_PER_METER,
  accelerate,
  alongLine,
  carPose,
  couplerAt,
  moveTrain,
  trackNet,
  trainMass,
  type Car,
  type CarKind,
  type CarPos,
  type Track,
  type TrackNet,
  type Train,
} from '@super-vox/shared';

const M = UNITS_PER_METER;
/** A car's put on track this near where it's aimed (m, across; and up or down). */
const PLACE_REACH_M = 4;
/** Trains whose buffers are this near (m, past the gap between coupled cars) are touching. */
const TOUCH_M = 0.25;

/** Kept (see the store): the trains, and the next id for a train or car. */
export interface YardSave {
  trains: Train[];
  next: number;
}

/**
 * A world's trains (see trains.ts): put on its track, taken off, driven, coupled, uncoupled, and
 * moved along (step: a few times a second). Who's driving is a player's id (and the engine they're in: `cab`).
 */
export class TrainYard {
  private readonly trains = new Map<number, Train & { cab: number | null }>();
  private net: TrackNet = trackNet([]);
  private next = 1;
  /** Something about the trains changed besides where they are (a car put on or taken off, coupled, a driver in or out): tell everyone. */
  changed = false;

  constructor(raw?: unknown) {
    const saved = kept(raw);
    for (const t of saved?.trains ?? []) this.trains.set(t.id, { ...t, cab: (t as { cab?: number | null }).cab ?? null, driver: null, throttle: 0, brake: false });
    this.next = Math.max(saved?.next ?? 1, ...[...this.trains.values()].flatMap((t) => [t.id + 1, ...t.cars.map((c) => c.id + 1)]));
  }

  setTracks(tracks: readonly Track[]): void {
    this.net = trackNet(tracks);
  }

  list(): Train[] {
    return [...this.trains.values()].map(({ cab: _, ...t }) => ({ ...t, cars: t.cars.map((c) => ({ ...c, pos: { ...c.pos }, ...(c.cargo ? { cargo: c.cargo.map(([i, n]) => [i, n] as [ItemId, number]) } : {}), ...(c.seats ? { seats: [...c.seats] } : {}) })) }));
  }

  /** What's kept (drivers and passengers aren't: they're out when the world's opened again). */
  save(): YardSave {
    return { trains: this.list().map((t) => ({ ...t, driver: null, throttle: 0, brake: false, v: 0, cars: t.cars.map((c) => (c.seats ? { ...c, seats: c.seats.map(() => null) } : c)) })), next: this.next };
  }

  /** `player` in a free seat of passenger car `car` (out of anything else they were in): which; or why not. */
  sit(car: number, player: number): number | string {
    const f = this.find(car);
    if (!f) return 'that car has gone';
    const c = f.train.cars[f.index]!;
    if (!c.seats) return 'only a passenger car has seats';
    const seat = c.seats.indexOf(null);
    if (seat < 0) return 'every seat is taken';
    this.leave(player);
    c.seats[seat] = player;
    this.changed = true;
    return seat;
  }

  /**
   * A flatbed's load changed: `amount` of `item` put on (+) or taken off (-), as much as fits (or
   * is there). How much was; or why none.
   */
  load(car: number, item: ItemId, amount: number): number | string {
    const f = this.find(car);
    if (!f) return 'that car has gone';
    const c = f.train.cars[f.index]!;
    if (!c.cargo) return 'only a flatbed carries a load';
    const at = c.cargo.findIndex(([i]) => i === item), has = at >= 0 ? c.cargo[at]![1] : 0;
    let n: number;
    if (amount > 0) {
      // (As much as fits in the crates it has room for: the last of this kind's crate topped up first.)
      const others = cratesFor(c.cargo.filter(([i]) => i !== item)), room = (FLATBED_CRATES - others) * crateOf(item) - has;
      n = Math.min(amount, Math.max(0, room));
      if (n <= 0) return "it's full";
    } else {
      n = -Math.min(-amount, has);
      if (n === 0) return "there's none of that on it";
    }
    const left = has + n;
    if (at >= 0) {
      if (left > 0) c.cargo[at] = [item, left];
      else c.cargo.splice(at, 1);
    } else c.cargo.push([item, left]);
    this.changed = true;
    return Math.abs(n);
  }

  /** The train a car's in, and where in it. */
  private find(car: number): { train: Train & { cab: number | null }; index: number } | null {
    for (const train of this.trains.values()) {
      const index = train.cars.findIndex((c) => c.id === car);
      if (index >= 0) return { train, index };
    }
    return null;
  }

  /** Where a car is (units), for reach. */
  carAt(car: number): { x: number; y: number; z: number } | null {
    const f = this.find(car);
    return f ? carPose(this.net, f.train.cars[f.index]!) : null;
  }

  /**
   * A car of `kind` put on the track nearest (x, y, z) (units), facing the way `heading` looks
   * along it (as near as the track goes); or why not (no track there, too near its end, or no room).
   */
  place(kind: CarKind, x: number, y: number, z: number, heading: number): Car | string {
    let best: CarPos | null = null, bestD = PLACE_REACH_M * M;
    for (const t of this.net.tracks.values())
      for (const p of t.points) {
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < bestD && Math.abs(p.y - y) < PLACE_REACH_M * M) {
          bestD = d;
          // (Its forward the way that's looked, near enough.)
          const along = -Math.sin(p.heading) * -Math.sin(heading) + -Math.cos(p.heading) * -Math.cos(heading);
          best = { track: t.id, s: p.s, dir: along >= 0 ? 1 : -1 };
        }
      }
    if (!best) return 'a car goes on track: aim at it';
    const half = (CAR_SPECS[kind].length * M) / 2;
    if (alongLine(this.net, best, half).moved < half - 1 || alongLine(this.net, best, -half).moved < half - 1) return "too near the end of the line: there isn't room";
    const car: Car = { id: this.next++, kind, pos: best, flip: false, ...(kind === 'engine' ? { fuel: 0 } : kind === 'flatbed' ? { cargo: [] } : { seats: Array<number | null>(PASSENGER_SEATS).fill(null) }) };
    // (Not on another: their middles further apart than their halves and the gap.)
    const here = carPose(this.net, car)!;
    for (const t of this.trains.values())
      for (const c of t.cars) {
        const p = carPose(this.net, c);
        if (p && Math.hypot(p.x - here.x, p.y - here.y, p.z - here.z) < ((CAR_SPECS[kind].length + CAR_SPECS[c.kind].length) / 2 + CAR_GAP_M - 0.1) * M) return 'no room: another car is there';
      }
    this.trains.set(this.next, { id: this.next++, cars: [car], v: 0, driver: null, throttle: 0, brake: false, cab: null });
    this.changed = true;
    return car;
  }

  /** A car taken off (its kind: to give back); or why not (it's moving, being driven, or coupled between others). */
  take(car: number): CarKind | string {
    const f = this.find(car);
    if (!f) return 'that car has gone';
    const { train, index } = f;
    if (Math.abs(train.v) > 0.2) return "it's moving";
    if (train.cab === car && train.driver !== null) return 'someone is driving it';
    if (index !== 0 && index !== train.cars.length - 1) return 'uncouple it first (shift-right-click it, and the car behind it)';
    const c = train.cars[index]!;
    if (c.cargo?.length) return 'unload it first';
    if (c.seats?.some((p) => p !== null)) return 'someone is sitting in it';
    const [taken] = train.cars.splice(index, 1);
    if (!train.cars.length) this.trains.delete(train.id);
    else if (train.cab === car) (train.cab = null), (train.driver = null);
    this.changed = true;
    return taken!.kind;
  }

  /** `player` driving the engine `car` (out of any other they were in); or why not. */
  board(car: number, player: number): true | string {
    const f = this.find(car);
    if (!f) return 'that car has gone';
    const c = f.train.cars[f.index]!;
    if (c.kind !== 'engine') return 'only an engine is driven (seats come later)';
    if (f.train.driver !== null && f.train.driver !== player) return 'someone is driving this train';
    this.leave(player);
    f.train.driver = player;
    f.train.cab = car;
    f.train.throttle = 0;
    f.train.brake = false;
    this.changed = true;
    return true;
  }

  /** Coal (`lumps` of it) put in an engine: how many it took (it holds MAX_COAL's worth); or why not. */
  fuel(car: number, lumps: number): number | string {
    const f = this.find(car);
    if (!f) return 'that car has gone';
    const c = f.train.cars[f.index]!;
    if (c.kind !== 'engine') return 'coal goes in an engine';
    const room = Math.floor((MAX_COAL * COAL_SECONDS - (c.fuel ?? 0)) / COAL_SECONDS);
    const took = Math.max(0, Math.min(lumps, room));
    if (!took) return "it's full of coal";
    c.fuel = (c.fuel ?? 0) + took * COAL_SECONDS;
    this.changed = true;
    return took;
  }

  /**
   * A car uncoupled from the one ahead of it in its train (the front car: from the one behind): two
   * trains, the driver in the one with their engine. Or why not.
   */
  uncouple(car: number): true | string {
    const f = this.find(car);
    if (!f) return 'that car has gone';
    const { train } = f;
    if (train.cars.length < 2) return "it isn't coupled to anything";
    const at = f.index === 0 ? 1 : f.index;
    const back = train.cars.splice(at);
    const other: Train & { cab: number | null } = { id: this.next++, cars: back, v: train.v, driver: null, throttle: 0, brake: false, cab: null };
    if (train.cab !== null && back.some((c) => c.id === train.cab)) {
      Object.assign(other, { driver: train.driver, throttle: train.throttle, brake: train.brake, cab: train.cab });
      Object.assign(train, { driver: null, throttle: 0, brake: false, cab: null });
    }
    this.trains.set(other.id, other);
    this.changed = true;
    return true;
  }

  /** What the driver `player` does: the throttle (-1..1, the way their engine faces) and brake; or out. False if they're not driving. */
  drive(player: number, throttle: number, brake: boolean, leave: boolean): boolean {
    if (leave) return this.leave(player), true;
    const t = this.driven(player);
    if (!t) return false;
    t.throttle = Math.max(-1, Math.min(1, throttle));
    t.brake = brake;
    return true;
  }

  private driven(player: number): (Train & { cab: number | null }) | null {
    for (const t of this.trains.values()) if (t.driver === player) return t;
    return null;
  }

  /** `player` out of what they're driving or sitting in (gone, or got out). */
  leave(player: number): void {
    for (const t of this.trains.values())
      for (const c of t.cars)
        if (c.seats?.includes(player)) {
          c.seats = c.seats.map((p) => (p === player ? null : p));
          this.changed = true;
        }
    const t = this.driven(player);
    if (!t) return;
    Object.assign(t, { driver: null, throttle: 0, brake: false, cab: null });
    this.changed = true;
  }

  /** Whether `player`'s in a seat. */
  seated(player: number): boolean {
    for (const t of this.trains.values()) for (const c of t.cars) if (c.seats?.includes(player)) return true;
    return false;
  }

  /** Whether any train's moving or being driven (stepping does something). */
  get busy(): boolean {
    for (const t of this.trains.values()) if (t.v !== 0 || t.driver !== null) return true;
    return false;
  }

  /**
   * Every train moved on `dt` s (see accelerate; `burn`: engines use coal), then those touching
   * coupled (slowly enough: else both stopped). Whether any moved.
   */
  step(dt: number, burn: boolean): boolean {
    let moved = false;
    for (const t of [...this.trains.values()]) {
      if (!this.trains.has(t.id) || (t.v === 0 && t.driver === null)) continue;
      const fuelBefore = t.cars.reduce((f, c) => f + Math.ceil((c.fuel ?? 0) / COAL_SECONDS), 0);
      const wasMoving = t.v !== 0;
      t.v = accelerate(this.net, t, dt, burn);
      // (Stopped: everyone told, or they'd see it go on.)
      if (wasMoving && t.v === 0) this.changed = true;
      if (t.cars.reduce((f, c) => f + Math.ceil((c.fuel ?? 0) / COAL_SECONDS), 0) !== fuelBefore) this.changed = true;
      if (t.v === 0) continue;
      const lead = t.v > 0 ? 1 : -1, end = lead > 0 ? t.cars[0]! : t.cars.at(-1)!;
      const others = [...this.trains.values()].filter((o) => o !== t);
      const before = others.map((o) => this.touch(end, lead, o));
      const want = t.v * dt * M, went = moveTrain(this.net, t, want);
      if (went > 0) moved = true;
      // (At the end of the line: stopped against its buffers.)
      if (went < Math.abs(want) - 1e-6) (t.v = 0), (this.changed = true);
      for (let i = 0; i < others.length; i++) {
        const o = others[i]!, now = this.touch(end, lead, o), was = before[i];
        if (!now || !was || now.d > (CAR_GAP_M + TOUCH_M) * M || now.d >= was.d) continue;
        // Meeting: coupled if slowly enough (how fast they closed, m/s), else both stopped dead.
        const closing = (was.d - now.d) / M / dt;
        if (closing <= COUPLE_SPEED && !(t.driver !== null && o.driver !== null)) this.couple(t, lead, o, now.end);
        else {
          t.v = 0;
          o.v = 0;
          this.changed = true;
        }
        break;
      }
    }
    return moved;
  }

  /** The nearer of `other`'s end couplers to car `car`'s coupler at its `end`, and how far (units). */
  private touch(car: Car, end: 1 | -1, other: Train): { d: number; end: 1 | -1 } | null {
    const a = couplerAt(this.net, car, end);
    if (!a) return null;
    let best: { d: number; end: 1 | -1 } | null = null;
    for (const [c, e] of [[other.cars[0]!, 1], [other.cars.at(-1)!, -1]] as const) {
      const b = couplerAt(this.net, c, e);
      if (!b) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      if (!best || d < best.d) best = { d, end: e };
    }
    return best;
  }

  /** Train `b` coupled to `a` (a's end `endA` to b's `endB`): one train, a's way forward; going as fast as both did (their momentum shared). */
  private couple(a: Train & { cab: number | null }, endA: 1 | -1, b: Train & { cab: number | null }, endB: 1 | -1): void {
    let cars = b.cars, vb = b.v;
    // (Facing the same way as a, b's front to a's back or b's back to a's front.)
    if (endA === endB) {
      cars = [...cars].reverse().map((c) => ({ ...c, pos: { ...c.pos, dir: (-c.pos.dir) as 1 | -1 }, flip: !c.flip }));
      vb = -vb;
    }
    const ma = trainMass(a), mb = trainMass(b);
    a.v = (ma * a.v + mb * vb) / (ma + mb);
    a.cars = endA > 0 ? [...cars, ...a.cars] : [...a.cars, ...cars];
    if (a.driver === null && b.driver !== null) {
      a.driver = b.driver;
      a.cab = b.cab;
      // (The throttle's the way its engine faces: that's the same, whichever way round b's cars are listed.)
      a.throttle = b.throttle;
      a.brake = b.brake;
    }
    this.trains.delete(b.id);
    this.changed = true;
  }
}

/** Trains as kept (see save), if they look like it: those that don't, left out. */
function kept(raw: unknown): YardSave | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { trains?: unknown; next?: unknown };
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const car = (c: unknown): c is Car => {
    const o = c as Car;
    return typeof o === 'object' && o !== null && Number.isInteger(o.id) && o.kind in CAR_SPECS && typeof o.flip === 'boolean' && typeof o.pos === 'object' && o.pos !== null && Number.isInteger(o.pos.track) && num(o.pos.s) && (o.pos.dir === 1 || o.pos.dir === -1) && (o.fuel === undefined || num(o.fuel)) && (o.cargo === undefined || (Array.isArray(o.cargo) && o.cargo.every((e) => Array.isArray(e) && Number.isInteger(e[0]) && num(e[1]) && e[1] > 0))) && (o.seats === undefined || Array.isArray(o.seats));
  };
  const trains = (Array.isArray(r.trains) ? r.trains : []).filter((t): t is Train => {
    const o = t as Train;
    return typeof o === 'object' && o !== null && Number.isInteger(o.id) && Array.isArray(o.cars) && o.cars.length > 0 && o.cars.every(car);
  });
  const cars = (t: Train) => t.cars.map((c) => (c.kind === 'passenger' ? { ...c, seats: Array<number | null>(PASSENGER_SEATS).fill(null) } : c.kind === 'flatbed' ? { ...c, cargo: c.cargo ?? [] } : c));
  return { trains: trains.map((t) => ({ id: t.id, cars: cars(t), v: 0, driver: null, throttle: 0, brake: false })), next: Number.isInteger(r.next) ? (r.next as number) : 1 };
}
