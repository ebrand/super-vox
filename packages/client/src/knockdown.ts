import type { Mover } from './walking.js';
import { GRAVITY } from './walking.js';

/**
 * Being knocked down by a blast (walking, near enough; see knockdownFor): thrown back away from it,
 * tumbling end over end, bouncing and rolling along the ground till you come to rest (walls and
 * slopes stop you: you move as the player does, see Mover); a moment lying there; then getting back
 * up, a little unsteadily. Moving is locked meanwhile (looking isn't). Bigger and nearer blasts
 * throw you further and keep you down longer.
 */

/**
 * How near (in blast radii, from the middle of the body) a blast knocks you down: beyond its crater,
 * whose lobes reach about 1.5 radii (see craterShape), so ground blown from under you always does.
 */
export const KNOCKDOWN_REACH = 2;
/** The middle of the body, below the eye (m). */
export const BODY_BELOW_EYE = 0.8;
/** Getting up (s). */
const RISE = 1.0;
/** The longest the tumbling lasts (s), however it's going. */
const MOST_TUMBLING = 4;
/** Turns (radians) per metre travelled: a body rolling over. */
const SPIN_PER_METRE = 1.1;

/** A knockdown: how hard (0..1), which way you're thrown (x, z, unit), and which side you end up rolled to. */
export interface KnockdownStart {
  strength: number;
  away: { x: number; z: number };
  side: 1 | -1;
}

/**
 * Whether a blast of `radius` m, `distance` m off, knocks you down, and how: (null: not near enough).
 * `from`: where it is relative to you (m; x and z), for the way you're thrown.
 */
export function knockdownFor(distance: number, radius: number, from: { x: number; z: number }, side: 1 | -1 = Math.random() < 0.5 ? 1 : -1): KnockdownStart | null {
  const reach = radius * KNOCKDOWN_REACH;
  if (distance >= reach) return null;
  const near = 1 - distance / reach;
  // (Bigger blasts, 2.3 m to 16 m across, hit harder.)
  const big = Math.max(0, Math.min(1, (radius - 2.3) / 13.7));
  const strength = Math.min(1, 0.35 + 0.4 * near + 0.35 * big);
  const len = Math.hypot(from.x, from.z);
  const away = len > 1e-6 ? { x: -from.x / len, z: -from.z / len } : { x: 0, z: 1 };
  return { strength, away, side };
}

/**
 * The view's pose while knocked down: how far the eye drops (m), its roll and pitch (radians), its
 * tumble (radians, about the horizontal axis across the way you were thrown: `axis`), and how far
 * you moved this frame (m).
 */
export interface KnockdownPose {
  drop: number;
  roll: number;
  pitch: number;
  tumble: number;
  axis: { x: number; z: number };
  moved: [number, number, number];
}

const smooth = (t: number) => t * t * (3 - 2 * t);

type Phase = 'tumbling' | 'lying' | 'rising';

export class Knockdown {
  private k: KnockdownStart | null = null;
  private phase: Phase = 'tumbling';
  /** Time in this phase (s), and in all. */
  private t = 0;
  private total = 0;
  private v = { x: 0, y: 0, z: 0 };
  private angle = 0;
  /** At the end of tumbling: the angle to settle to (upright, a whole number of turns) from where it stopped. */
  private settleFrom = 0;
  private settleTo = 0;

  /** Knocked down (a harder one takes over from one under way; one while getting up starts afresh). */
  begin(k: KnockdownStart): void {
    if (this.k && this.k.strength >= k.strength && this.phase !== 'rising') return;
    this.k = k;
    this.phase = 'tumbling';
    this.t = this.total = 0;
    const out = 3 + 9 * k.strength, up = 3 + 5 * k.strength;
    this.v = { x: k.away.x * out, y: up, z: k.away.z * out };
  }

  /** Whether you're down (or getting up): moving is locked. */
  get active(): boolean {
    return this.k !== null;
  }

  /** Whether you're being thrown (your own walking and falling are off meanwhile: this moves you). */
  get thrown(): boolean {
    return this.k !== null && this.phase === 'tumbling';
  }

  /** How long the lying lasts (s), by how hard it was. */
  private lying(): number {
    return 0.5 + 0.8 * this.k!.strength;
  }

  /**
   * Moves on `dt` s, moving you with `move` (the player's collisions; null: not moved), and the pose
   * now (null: not knocked down, or over).
   */
  update(dt: number, move: Mover | null): KnockdownPose | null {
    const k = this.k;
    if (!k) return null;
    this.t += dt;
    this.total += dt;
    let moved: [number, number, number] = [0, 0, 0];
    if (this.phase === 'tumbling') {
      const v = this.v;
      v.y -= GRAVITY * dt;
      if (move) {
        const r = move([v.x * dt, v.y * dt, v.z * dt]);
        moved = r.delta;
        const [bx, by, bz] = r.blocked;
        if (by && v.y < -2.2) {
          // A bounce (landing hard enough): up again not quite half as fast, and slowed along the ground.
          v.y = -v.y * 0.45;
          v.x *= 0.75;
          v.z *= 0.75;
        } else if (by && v.y <= 0) {
          // On the ground: rolling to a stop.
          v.y = 0;
          const f = Math.exp(-dt * 1.4);
          v.x *= f;
          v.z *= f;
        }
        if (bx) v.x *= -0.3;
        if (bz) v.z *= -0.3;
      }
      const along = Math.hypot(moved[0], moved[2]);
      this.angle += along * SPIN_PER_METRE;
      const stopped = !move || (v.y === 0 && Math.hypot(v.x, v.z) < 0.3);
      if (stopped || this.t > MOST_TUMBLING) {
        this.phase = 'lying';
        this.t = 0;
        this.settleFrom = this.angle;
        this.settleTo = Math.round(this.angle / (2 * Math.PI)) * 2 * Math.PI;
      }
    } else if (this.phase === 'lying' && this.t >= this.lying()) {
      this.phase = 'rising';
      this.t = 0;
    } else if (this.phase === 'rising' && this.t >= RISE) {
      this.k = null;
      return null;
    }
    // The pose: down low while tumbling and lying (settling upright, rolled to one side), then up.
    const settle = this.phase === 'tumbling' ? 0 : this.phase === 'lying' ? smooth(Math.min(1, this.t / Math.min(0.5, this.lying()))) : 1;
    const tumble = this.phase === 'tumbling' ? this.angle : this.settleFrom + (this.settleTo - this.settleFrom) * settle;
    const rising = this.phase === 'rising' ? this.t / RISE : 0;
    const fallen = this.phase === 'tumbling' ? smooth(Math.min(1, this.total / 0.25)) : 1;
    const down = this.phase === 'rising' ? 1 - smooth(rising) : fallen;
    const sway = rising > 0 ? Math.sin(rising * Math.PI * 3) * 0.08 * (1 - rising) : 0;
    const lyingRoll = this.phase === 'tumbling' ? 0 : settle;
    return {
      drop: 1.2 * down,
      roll: k.side * (1.0 * k.strength * lyingRoll * down + sway),
      pitch: 0.4 * k.strength * lyingRoll * down,
      tumble,
      // (Across the way you're thrown: it turns you over backwards.)
      axis: { x: k.away.z, z: -k.away.x },
      moved,
    };
  }
}
