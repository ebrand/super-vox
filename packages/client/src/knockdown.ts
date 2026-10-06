/**
 * Being knocked down by a blast (walking, near enough; see knockdownFor): thrown off your feet,
 * away from it, the view falling to the ground and rolling to one side; a moment lying there; then
 * getting back up, a little unsteadily. Moving is locked meanwhile (looking isn't). Bigger and
 * nearer blasts throw you further and keep you down longer.
 */

/** How near (in blast radii) a blast knocks you down. */
export const KNOCKDOWN_REACH = 1.5;
/** How long falling and getting up take (s). */
const FALL = 0.35;
const RISE = 1.0;

/** A knockdown: how hard (0..1), how long in all (s), which way you're thrown (x, z, unit), and which side you roll to. */
export interface KnockdownStart {
  strength: number;
  duration: number;
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
  return { strength, duration: FALL + RISE + 0.6 + 2.4 * strength, away, side };
}

/** The view's pose while knocked down: how far the eye drops (m), roll and pitch (radians), and how far to be shoved this frame (m). */
export interface KnockdownPose {
  drop: number;
  roll: number;
  pitch: number;
  shove: { x: number; z: number };
}

const smooth = (t: number) => t * t * (3 - 2 * t);

export class Knockdown {
  private start: KnockdownStart | null = null;
  private t = 0;

  /** Knocked down (a harder one takes over from one under way). */
  begin(k: KnockdownStart): void {
    if (this.start && this.start.strength >= k.strength && this.t < this.start.duration - RISE) return;
    this.start = k;
    this.t = 0;
  }

  /** Whether you're down (or getting up): moving is locked. */
  get active(): boolean {
    return this.start !== null;
  }

  /** Moves on `dt` s; the pose now (null: not knocked down). */
  update(dt: number): KnockdownPose | null {
    const k = this.start;
    if (!k) return null;
    const before = this.t;
    this.t += dt;
    if (this.t >= k.duration) {
      this.start = null;
      return null;
    }
    // Down: falling over FALL s, lying, then getting up over the last RISE s.
    const down = this.t < FALL ? smooth(this.t / FALL) : this.t > k.duration - RISE ? 1 - smooth((this.t - (k.duration - RISE)) / RISE) : 1;
    const rising = this.t > k.duration - RISE ? (this.t - (k.duration - RISE)) / RISE : 0;
    // (Unsteady getting up: a sway that dies as you stand.)
    const sway = rising > 0 ? Math.sin(rising * Math.PI * 3) * 0.08 * (1 - rising) : 0;
    // Thrown over the fall: up to 3 m for the hardest.
    const thrown = (t: number) => smooth(Math.min(1, t / FALL)) * 3 * k.strength;
    const d = thrown(this.t) - thrown(before);
    return {
      drop: 1.25 * down,
      roll: k.side * (1.1 * k.strength * down + sway),
      pitch: 0.45 * k.strength * down,
      shove: { x: k.away.x * d, z: k.away.z * d },
    };
  }
}
