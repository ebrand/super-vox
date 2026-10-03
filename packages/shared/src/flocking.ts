/**
 * Flocking, two ways. Flock (boids): each member steers by its neighbours — apart from those too
 * close (separation), the way they're heading (alignment), toward the middle of them (cohesion) —
 * and toward a target, keeping above the ground: a loose crowd (starlings, fish). Skein: birds in a
 * V behind a leader, as they migrate (the terraformer's birds). Plain numbers, no drawing: the game
 * can use either (birds, fish, bats).
 *
 * Units are whatever the caller's are (metres, say): settings scale with them.
 */

export interface FlockSettings {
  /** How far a member sees neighbours. */
  neighbourRadius: number;
  /** Closer than this, a neighbour pushes it away. */
  separationRadius: number;
  /** How hard each rule steers (accelerations per unit of the rule's pull). */
  separation: number;
  alignment: number;
  cohesion: number;
  /** How hard it makes for the target. */
  seek: number;
  /** Speeds it keeps between (units a second). */
  minSpeed: number;
  maxSpeed: number;
  /** The most it can change its velocity in a second (units a second, a second). */
  maxAccel: number;
  /** Height it keeps above the ground (see step's `ground`), and how hard it climbs back to it. */
  clearance: number;
  lift: number;
}

/** Settings for birds whose wingspan is `span` units: they keep a few spans apart, at a steady speed. */
export function birdSettings(span: number): FlockSettings {
  return {
    neighbourRadius: span * 12,
    separationRadius: span * 2.5,
    separation: 3,
    alignment: 1,
    cohesion: 0.6,
    seek: 0.8,
    minSpeed: span * 6,
    maxSpeed: span * 12,
    maxAccel: span * 18,
    clearance: span * 20,
    lift: 2,
  };
}

/** A seeded random in [0, 1) (mulberry32), so flocks can be made again the same. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Flock {
  /** Positions and velocities, x y z for each member. */
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  /** Where the flock is making for (null: nowhere: it keeps on as it goes). */
  target: [number, number, number] | null = null;

  /**
   * `count` members around `at`, spread over `spread` units, all heading `heading` (a vector:
   * its length is ignored; each starts at about the middle of the speeds, a little off it).
   */
  constructor(
    readonly count: number,
    readonly settings: FlockSettings,
    at: readonly [number, number, number],
    heading: readonly [number, number, number],
    spread: number,
    random: () => number = Math.random,
  ) {
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    const h = Math.hypot(...heading) || 1;
    const speed = (settings.minSpeed + settings.maxSpeed) / 2;
    for (let i = 0; i < count; i++) {
      for (let a = 0; a < 3; a++) {
        const jitter = a === 1 ? 0.3 : 1; // (flatter than it's wide)
        this.pos[i * 3 + a] = at[a]! + (random() - 0.5) * spread * jitter;
        this.vel[i * 3 + a] = (heading[a]! / h) * speed * (0.9 + random() * 0.2) + (random() - 0.5) * speed * 0.1;
      }
    }
  }

  /** The middle of the flock. */
  centre(): [number, number, number] {
    const c: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < this.count; i++) for (let a = 0; a < 3; a++) c[a] = c[a]! + this.pos[i * 3 + a]!;
    return c.map((v) => v / Math.max(1, this.count)) as [number, number, number];
  }

  /**
   * Moves the flock on `dt` seconds. `ground` gives the ground's height under (x, z) (null: none
   * known there): members below `clearance` over it climb.
   */
  step(dt: number, ground: ((x: number, z: number) => number | null) | null = null): void {
    const s = this.settings, n = this.count, p = this.pos, v = this.vel;
    const r2 = s.neighbourRadius ** 2, sep2 = s.separationRadius ** 2;
    const acc = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const ix = i * 3;
      let seen = 0;
      const sep = [0, 0, 0], align = [0, 0, 0], mid = [0, 0, 0];
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const jx = j * 3;
        const dx = p[jx]! - p[ix]!, dy = p[jx + 1]! - p[ix + 1]!, dz = p[jx + 2]! - p[ix + 2]!;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        seen++;
        for (let a = 0; a < 3; a++) {
          align[a]! += v[jx + a]!;
          mid[a]! += p[jx + a]!;
        }
        // Too close: away from it, the harder the closer.
        if (d2 < sep2 && d2 > 1e-9) {
          const d = Math.sqrt(d2), push = (s.separationRadius - d) / s.separationRadius / d;
          sep[0]! -= dx * push;
          sep[1]! -= dy * push;
          sep[2]! -= dz * push;
        }
      }
      const want = [0, 0, 0];
      for (let a = 0; a < 3; a++) want[a]! += sep[a]! * s.separation * s.maxSpeed;
      if (seen) {
        for (let a = 0; a < 3; a++) {
          // Toward their average velocity, and toward their middle (as a speed: units a second).
          want[a]! += (align[a]! / seen - v[ix + a]!) * s.alignment;
          want[a]! += (mid[a]! / seen - p[ix + a]!) * s.cohesion;
        }
      }
      if (this.target) {
        const tx = this.target[0] - p[ix]!, ty = this.target[1] - p[ix + 1]!, tz = this.target[2] - p[ix + 2]!;
        const d = Math.hypot(tx, ty, tz) || 1;
        // Toward the target at full speed: the velocity it wants, less the one it has.
        want[0]! += ((tx / d) * s.maxSpeed - v[ix]!) * s.seek;
        want[1]! += ((ty / d) * s.maxSpeed - v[ix + 1]!) * s.seek;
        want[2]! += ((tz / d) * s.maxSpeed - v[ix + 2]!) * s.seek;
      }
      const g = ground?.(p[ix]!, p[ix + 2]!) ?? null;
      if (g !== null) {
        const low = g + s.clearance - p[ix + 1]!;
        if (low > 0) want[1]! += low * s.lift;
      }
      // No faster turn than it can make.
      const a = Math.hypot(want[0]!, want[1]!, want[2]!);
      const k = a > s.maxAccel ? s.maxAccel / a : 1;
      for (let c = 0; c < 3; c++) acc[ix + c] = want[c]! * k;
    }
    for (let i = 0; i < n; i++) {
      const ix = i * 3;
      for (let a = 0; a < 3; a++) v[ix + a]! += acc[ix + a]! * dt;
      const sp = Math.hypot(v[ix]!, v[ix + 1]!, v[ix + 2]!);
      const want = Math.min(s.maxSpeed, Math.max(s.minSpeed, sp));
      if (sp > 1e-9 && want !== sp) for (let a = 0; a < 3; a++) v[ix + a]! *= want / sp;
      for (let a = 0; a < 3; a++) p[ix + a]! += v[ix + a]! * dt;
    }
  }
}

/**
 * The shapes a skein flies in: a V (two even arms); a J (one arm twice the other); an echelon (one
 * arm, a diagonal line off to one side); a line (single file behind the leader).
 */
export type SkeinShape = 'v' | 'j' | 'echelon' | 'line';
export const SKEIN_SHAPES: readonly SkeinShape[] = ['v', 'j', 'echelon', 'line'];

export interface SkeinSettings {
  shape: SkeinShape;
  /** Distance between neighbours along each arm of the V. */
  spacing: number;
  /** The V's half-angle: how wide its arms spread (radians, from straight back). */
  spread: number;
  /** The leader's speed (units a second); followers go up to `catchUp` times it to keep their places. */
  speed: number;
  catchUp: number;
  /** How fast the leader can turn (radians a second), and climb or sink (units a second). */
  turnRate: number;
  climbRate: number;
  /** How hard a follower steers for its place (per second). */
  pull: number;
  /** Each follower drifts about its place by up to this much (units), at its own pace. */
  wobble: number;
}

/** Settings for a skein of birds `span` units across, flying at `speed`. */
export function skeinSettings(span: number, speed: number): SkeinSettings {
  return { shape: 'v', spacing: span * 2.2, spread: 0.6, speed, catchUp: 1.6, turnRate: 0.35, climbRate: speed * 0.15, pull: 1.6, wobble: span * 0.9 };
}

/**
 * A skein: birds in a V, as they fly when migrating. The leader (member 0) makes for a goal,
 * turning and climbing no faster than it can; each other member keeps its own place behind it,
 * alternately left and right, further back and out the further along its arm (its place turning
 * with the leader), drifting about it at its own pace and catching up when it falls behind.
 */
export class Skein {
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  /** The leader's heading (radians about the vertical: 0 along +z, increasing toward +x). */
  heading: number;
  /** Each follower's drift: its own pace and phase, side to side and up and down. */
  private readonly drift: Float32Array;
  /** Each member's place in the shape: how far along its arm (0: the leader), and which side (-1, 1; 0: straight behind). */
  private readonly rank: Int16Array;
  private readonly side: Int8Array;
  private time = 0;

  constructor(
    readonly count: number,
    readonly settings: SkeinSettings,
    at: readonly [number, number, number],
    heading: number,
    random: () => number = Math.random,
  ) {
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.drift = new Float32Array(count * 4);
    this.rank = new Int16Array(count);
    this.side = new Int8Array(count);
    // Places along the arms, by the shape: each arm's members numbered out from the leader.
    const along = { [-1]: 0, [0]: 0, [1]: 0 } as Record<number, number>;
    for (let i = 1; i < count; i++) {
      const side = settings.shape === 'line' ? 0 : settings.shape === 'echelon' ? 1 : settings.shape === 'j' ? (i % 3 === 0 ? -1 : 1) : i % 2 ? -1 : 1;
      this.side[i] = side;
      this.rank[i] = ++along[side]!;
    }
    this.heading = heading;
    for (let i = 0; i < count; i++) {
      this.drift.set([0.15 + random() * 0.25, random() * 6.283, 0.1 + random() * 0.2, random() * 6.283], i * 4);
      // Each in its place to begin with, give or take (it settles in as it flies).
      const slot = this.slot(i, at);
      for (let a = 0; a < 3; a++) this.pos[i * 3 + a] = slot[a]! + (random() - 0.5) * settings.spacing;
      this.vel[i * 3] = Math.sin(heading) * settings.speed;
      this.vel[i * 3 + 2] = Math.cos(heading) * settings.speed;
    }
  }

  /** Where member `i`'s place is behind a leader at `lead` (member 0's is the leader's own). */
  slot(i: number, lead: readonly number[]): [number, number, number] {
    if (i === 0) return [lead[0]!, lead[1]!, lead[2]!];
    const s = this.settings, rank = this.rank[i]!, side = this.side[i]!;
    // (Single file: straight back; otherwise back and out along the arm at the shape's angle.)
    const back = (side ? Math.cos(s.spread) : 1) * s.spacing * rank, out = Math.sin(s.spread) * s.spacing * rank * side;
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    // Behind (against the heading) and out to its side (across it); a little lower along the arm.
    return [lead[0]! - fx * back + fz * out, lead[1]! - rank * s.spacing * 0.05, lead[2]! - fz * back - fx * out];
  }

  /** Moves the skein on `dt` seconds, the leader making for `goal`. */
  step(dt: number, goal: readonly [number, number, number]): void {
    const s = this.settings, p = this.pos, v = this.vel;
    this.time += dt;
    // The leader: turns toward the goal (no faster than it can), climbs or sinks toward its height.
    const want = Math.atan2(goal[0] - p[0]!, goal[2] - p[2]!);
    let turn = want - this.heading;
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    this.heading += Math.max(-s.turnRate * dt, Math.min(s.turnRate * dt, turn));
    const climb = Math.max(-s.climbRate, Math.min(s.climbRate, goal[1] - p[1]!));
    v[0] = Math.sin(this.heading) * s.speed;
    v[1] = climb;
    v[2] = Math.cos(this.heading) * s.speed;
    for (let a = 0; a < 3; a++) p[a]! += v[a]! * dt;
    // The others: for their places (drifting about them), at what speed it takes.
    const lead = [p[0]!, p[1]!, p[2]!];
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    for (let i = 1; i < this.count; i++) {
      const ix = i * 3, d = this.drift.subarray(i * 4, i * 4 + 4);
      const slot = this.slot(i, lead);
      const side = Math.sin(this.time * d[0]! * 6.283 + d[1]!) * s.wobble;
      const up = Math.sin(this.time * d[2]! * 6.283 + d[3]!) * s.wobble * 0.5;
      slot[0] += fz * side;
      slot[1] += up;
      slot[2] -= fx * side;
      // The leader's velocity, plus a pull toward the place; no faster than catching up allows.
      const tv = [v[0]! + (slot[0] - p[ix]!) * s.pull, v[1]! + (slot[1] - p[ix + 1]!) * s.pull, v[2]! + (slot[2] - p[ix + 2]!) * s.pull];
      const sp = Math.hypot(tv[0]!, tv[1]!, tv[2]!), most = s.speed * s.catchUp;
      const k = sp > most ? most / sp : 1;
      // (Eased in: a bird changes its velocity over a moment, not at once.)
      const ease = Math.min(1, dt * 4);
      for (let a = 0; a < 3; a++) {
        v[ix + a]! += (tv[a]! * k - v[ix + a]!) * ease;
        p[ix + a]! += v[ix + a]! * dt;
      }
    }
  }
}
