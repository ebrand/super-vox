/**
 * Walking physics (metres, seconds): gravity, jumping, and landing, on top of
 * a collision function. Pure so it can be tested without a browser.
 */

export const GRAVITY = 20; // m/s^2
export const TERMINAL_SPEED = 50; // m/s
/** Launch speed for a jump about 1.25 m high: sqrt(2 * g * h). */
export const JUMP_SPEED = Math.sqrt(2 * GRAVITY * 1.3);

export interface WalkState {
  /** Vertical velocity (m/s, up is positive). */
  vy: number;
  /** Standing on something after the last step. */
  grounded: boolean;
}

/** Swimming speed up or down (m/s), and how fast a body that isn't swimming sinks. */
export const SWIM_SPEED = 3;
/** Walking pace (m/s; Minecraft's), and how much faster sprinting (Shift) is. */
export const WALK_SPEED = 4.3;
export const SPRINT = 1.5;
export const SINK_SPEED = 0.6;
/** How quickly water drag brings vertical speed to the swimming speed (per second). */
export const WATER_DRAG = 5;

export interface WalkInput {
  /** Horizontal move direction on the ground (unit or zero), metres per metre. */
  dx: number;
  dz: number;
  /** Horizontal speed (m/s). */
  speed: number;
  jump: boolean;
  /**
   * In water (the middle of the body below its surface): instead of gravity, sink slowly, or swim
   * up (`up`) or down (`down`). Horizontal speed is the caller's (slower in water).
   */
  swim?: { up: boolean; down: boolean };
}

/** Moves by `delta` (m) with collision; returns the allowed move and which axes were blocked. */
export type Mover = (delta: [number, number, number]) => { delta: [number, number, number]; blocked: [boolean, boolean, boolean] };

/**
 * Advances walking by `dt` seconds. `groundLoaded` is false while the world
 * below the player hasn't arrived yet; gravity then pauses so the player
 * cannot fall through unloaded terrain. `landed`: the speed (m/s) it just
 * hit the ground at, if it did (else 0).
 */
export function walkStep(
  state: WalkState,
  input: WalkInput,
  dt: number,
  move: Mover,
  groundLoaded: boolean,
): { delta: [number, number, number]; state: WalkState; landed: number } {
  let vy = state.vy;
  if (input.swim) {
    // Drag pulls vertical speed toward the swimming speed.
    const target = input.swim.up ? SWIM_SPEED : input.swim.down ? -SWIM_SPEED : -SINK_SPEED;
    vy += (target - vy) * Math.min(1, WATER_DRAG * dt);
    if (!groundLoaded) vy = Math.max(0, vy);
  } else {
    if (input.jump && state.grounded) vy = JUMP_SPEED;
    if (groundLoaded) vy = Math.max(-TERMINAL_SPEED, vy - GRAVITY * dt);
    else vy = Math.max(0, vy);
  }
  const r = move([input.dx * input.speed * dt, vy * dt, input.dz * input.speed * dt]);
  const blockedDown = r.blocked[1] && vy < 0;
  const blockedUp = r.blocked[1] && vy > 0;
  // A tiny downward probe keeps "grounded" true while standing still.
  return {
    delta: r.delta,
    state: { vy: blockedDown || blockedUp ? 0 : vy, grounded: blockedDown },
    // How hard it hit the ground (m/s), if it just landed (see fallDamage).
    landed: blockedDown && !state.grounded ? -vy : 0,
  };
}
