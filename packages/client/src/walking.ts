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

export interface WalkInput {
  /** Horizontal move direction on the ground (unit or zero), metres per metre. */
  dx: number;
  dz: number;
  /** Horizontal speed (m/s). */
  speed: number;
  jump: boolean;
}

/** Moves by `delta` (m) with collision; returns the allowed move and which axes were blocked. */
export type Mover = (delta: [number, number, number]) => { delta: [number, number, number]; blocked: [boolean, boolean, boolean] };

/**
 * Advances walking by `dt` seconds. `groundLoaded` is false while the world
 * below the player hasn't arrived yet; gravity then pauses so the player
 * cannot fall through unloaded terrain.
 */
export function walkStep(
  state: WalkState,
  input: WalkInput,
  dt: number,
  move: Mover,
  groundLoaded: boolean,
): { delta: [number, number, number]; state: WalkState } {
  let vy = state.vy;
  if (input.jump && state.grounded) vy = JUMP_SPEED;
  if (groundLoaded) vy = Math.max(-TERMINAL_SPEED, vy - GRAVITY * dt);
  else vy = Math.max(0, vy);
  const r = move([input.dx * input.speed * dt, vy * dt, input.dz * input.speed * dt]);
  const blockedDown = r.blocked[1] && vy < 0;
  const blockedUp = r.blocked[1] && vy > 0;
  // A tiny downward probe keeps "grounded" true while standing still.
  return {
    delta: r.delta,
    state: { vy: blockedDown || blockedUp ? 0 : vy, grounded: blockedDown },
  };
}
