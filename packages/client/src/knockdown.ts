import type { Mover } from './walking.js';
import { GRAVITY } from './walking.js';

/**
 * Being knocked down by a blast (walking, near enough; see knockdownFor): hit and flung back away
 * from it, your head snapping back (the sky in view), slammed down at each bounce, then skidding
 * along on your back till you stop (walls and slopes stop you: you move as the player does, see
 * Mover); a moment lying there, rolled to one side; then getting back up, a little unsteadily. Moving is locked meanwhile (looking isn't). Bigger and nearer blasts
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
/** How far back your head's thrown (radians, looking up toward the sky): for the weakest and the hardest. */
const HEAD_BACK = [0.6, 1.0] as const;
/** In the air, tipping further back (radians per metre flown), at most this much more. */
const AIR_TIP = 0.25;
const AIR_TIP_MOST = 0.35;

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
  /** How far back the head is (radians), the tip it's easing to, and the jolt of the last hit (radians, dying fast). */
  private angle = 0;
  private tip = 0;
  private jolt = 0;
  /** At the end of being thrown: the angle the head settles from (to level). */
  private settleFrom = 0;

  /** Knocked down (a harder one takes over from one under way; one while getting up starts afresh). */
  begin(k: KnockdownStart): void {
    if (this.k && this.k.strength >= k.strength && this.phase !== 'rising') return;
    this.k = k;
    this.phase = 'tumbling';
    this.t = this.total = 0;
    // (The hit itself: a jolt, the head snapping back past where it settles.)
    this.jolt = 0.25 + 0.2 * k.strength;
    this.tip = 0;
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
          // A bounce (landing hard enough): slammed down (a jolt, by how hard), up again a third as
          // fast, hardly slowed along the ground (a body skids).
          this.jolt = Math.max(this.jolt, Math.min(0.3, -v.y * 0.04));
          v.y = -v.y * 0.35;
          v.x *= 0.88;
          v.z *= 0.88;
        } else if (by && v.y <= 0) {
          // On the ground: skidding to a stop.
          v.y = 0;
          const f = Math.exp(-dt * 1.5);
          v.x *= f;
          v.z *= f;
        }
        if (bx) v.x *= -0.3;
        if (bz) v.z *= -0.3;
      }
      // The head: thrown back (further, the harder), tipping further back while flying, easing
      // back toward lying flat once on the ground; each hit a jolt on top.
      const airborne = v.y !== 0;
      const along = Math.hypot(moved[0], moved[2]);
      this.tip = airborne ? Math.min(AIR_TIP_MOST * k.strength, this.tip + along * AIR_TIP) : this.tip * Math.exp(-dt * 2);
      const back = HEAD_BACK[0] + (HEAD_BACK[1] - HEAD_BACK[0]) * k.strength + this.tip;
      this.angle += (back - this.angle) * (1 - Math.exp(-dt * 9));
      this.jolt *= Math.exp(-dt * 9);
      const stopped = !move || (v.y === 0 && Math.hypot(v.x, v.z) < 0.3);
      if (stopped || this.t > MOST_TUMBLING) {
        this.phase = 'lying';
        this.t = 0;
        this.settleFrom = this.angle;
      }
    } else if (this.phase === 'lying' && this.t >= this.lying()) {
      this.phase = 'rising';
      this.t = 0;
    } else if (this.phase === 'rising' && this.t >= RISE) {
      this.k = null;
      return null;
    }
    // The pose: down low while thrown and lying (the head coming level, rolled to one side), then up.
    const settle = this.phase === 'tumbling' ? 0 : this.phase === 'lying' ? smooth(Math.min(1, this.t / Math.min(0.6, this.lying()))) : 1;
    // (Skidding: the ground juddering under you, by how fast.)
    const skid = this.phase === 'tumbling' && this.v.y === 0 ? (Math.random() - 0.5) * 0.04 * Math.min(1, Math.hypot(this.v.x, this.v.z) / 4) : 0;
    const tumble = this.phase === 'tumbling' ? this.angle + this.jolt + skid : this.settleFrom * (1 - settle);
    const rising = this.phase === 'rising' ? this.t / RISE : 0;
    const fallen = this.phase === 'tumbling' ? smooth(Math.min(1, this.total / 0.25)) : 1;
    const down = this.phase === 'rising' ? 1 - smooth(rising) : fallen;
    const sway = rising > 0 ? Math.sin(rising * Math.PI * 3) * 0.08 * (1 - rising) : 0;
    const lyingRoll = this.phase === 'tumbling' ? 0 : settle;
    return {
      // (A hit slams you lower for a moment.)
      drop: 1.2 * down + (this.phase === 'tumbling' ? 0.25 * this.jolt : 0),
      roll: k.side * (1.0 * k.strength * lyingRoll * down + sway),
      pitch: 0.4 * k.strength * lyingRoll * down,
      tumble,
      // (Across the way you're thrown: it tips you over backwards.)
      axis: { x: k.away.z, z: -k.away.x },
      moved,
    };
  }
}
