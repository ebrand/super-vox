/**
 * How players' figures move, as data (edited in the animation designer; the game poses figures by
 * it: see poseFigure). A clip is keyframes for some of the figure's joints (each a turn about x, y
 * and z, radians), moved through by its driver: time (a loop of `length` seconds), the stride (a
 * walk's or a run's cycle of two steps), a bow's draw (0..1) or a swing (0..1). Movement clips (idle,
 * walk, run, swim, fly, jump) pose the whole body; breathing is added on; action clips (dig, bow)
 * then take over the joints they have. Settings: speeds and how much they look where they look.
 * Grips: how each kind of thing is held. One library for the whole server (admins change it).
 */

import { SPRINT, WALK_SPEED } from './walking.js';

/**
 * Steps a minute walking and sprinting at full pace, when there's no figure to take them from (the
 * footsteps heard by default: see the client's footsteps.ts; in the game, the figure's own strides).
 */
export const WALK_STEPS_PER_MINUTE = 80;
export const SPRINT_STEPS_PER_MINUTE = 120;

/** The figure's joints (see the client's PlayerFigure), parents before children. */
export const FIGURE_JOINTS = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'shoulderL', 'elbowL', 'wristL', 'shoulderR', 'elbowR', 'wristR',
  'legL', 'kneeL', 'ankleL', 'legR', 'kneeR', 'ankleR',
] as const;
export type FigureJoint = (typeof FIGURE_JOINTS)[number];

/** A keyframe: how far through its clip (0..1), the joint's turn, and how much of where they look is added about x (0: none). */
export interface AnimKey {
  at: number;
  turn: [number, number, number];
  aim?: number;
}

/** A body keyframe: how far through (0..1), how far the body leans forward (-) or back about the hips (radians), and how far it's lifted (m). */
export interface BodyKey {
  at: number;
  lean: number;
  lift: number;
}

export type AnimDriver = 'time' | 'stride' | 'draw' | 'swing' | 'still';

export interface AnimClip {
  driver: AnimDriver;
  /** Driver 'time': seconds round the loop. */
  length?: number;
  /** Between keys: smooth (round a loop: time and stride clips) or straight. */
  smooth: boolean;
  joints: Partial<Record<FigureJoint, AnimKey[]>>;
  body?: BodyKey[];
  /** How much of where they look the head and chest follow (about x), and whether the head stays level as the body leans. */
  look?: { head: number; chest: number; level: boolean };
}

export const CLIP_IDS = ['idle', 'walk', 'run', 'swim', 'fly', 'jump', 'breathe', 'dig', 'bow'] as const;
export type ClipId = (typeof CLIP_IDS)[number];

export interface AnimSettings {
  /** Speeds (m/s): full walking swing by this; walking turns to running between these. */
  walkFull: number;
  runFrom: number;
  runTo: number;
  /**
   * A full stride (two steps), walking and running (m); 0: locked to the feet (as far as a planted
   * foot of the clip carries the body: see the client's lockedStride), so they don't slide.
   */
  walkStride: number;
  runStride: number;
  /** A dig's swing, over and over (s). */
  digSeconds: number;
  /** Flying: leaning forward this much (radians) for each m/s, to at most flyLeanMax. */
  flyLean: number;
  flyLeanMax: number;
}

export const GRIP_KINDS = ['tool', 'block', 'bow'] as const;
export type GripKind = (typeof GRIP_KINDS)[number];

/** How a kind of thing is held: in which hand, where (m, from the wrist), turned (radians), how big (1: a metre across). */
export interface Grip {
  hand: 'left' | 'right';
  at: [number, number, number];
  turn: [number, number, number];
  scale: number;
}

export interface AnimationLibrary {
  clips: Record<ClipId, AnimClip>;
  settings: AnimSettings;
  grips: Record<GripKind, Grip>;
}

/** What a figure's doing this frame (see poseFigure). */
export interface FigureState {
  /** Seconds since it was made (breathing, the swim stroke, a dig's rhythm). */
  time: number;
  /** How far along its stride (radians: a step each half turn), and how fast it's going over the ground (m/s). */
  stride: number;
  speed: number;
  airborne: boolean;
  swimming: boolean;
  flying: boolean;
  /** Mining (swinging over and over), or how far through one swing (0..1; null: not swinging). */
  mining: boolean;
  swing: number | null;
  /** A bow drawn this far (0..1), or null. */
  draw: number | null;
  /** Where it looks: up + (radians). */
  pitch: number;
}

/** Joint turns (radians, about x, y, z) for a pose; joints not named stay straight. And the whole body's lean (about x) and how far it's lifted (m). */
export interface FigurePose {
  joints: Partial<Record<FigureJoint, [number, number, number]>>;
  lean: number;
  lift: number;
}

// --- Evaluating ---

/** Catmull-Rom between b and c (a before, d after), u of the way. */
const catmull = (a: number, b: number, c: number, d: number, u: number) =>
  0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);

/** A track of keys (sorted by `at`) at t (0..1): each of `get`'s values, straight or smooth between keys (`loop`: round from the last to the first). */
function sample<K extends { at: number }>(keys: readonly K[], t: number, smooth: boolean, loop: boolean, get: (k: K) => number[]): number[] {
  const n = keys.length;
  if (n === 1 || t <= keys[0]!.at && !loop) return get(keys[0]!);
  if (t >= keys[n - 1]!.at && !loop) return get(keys[n - 1]!);
  // The key at or before t (round a loop), and the one after.
  let i = n - 1;
  for (let k = 0; k < n; k++) if (keys[k]!.at <= t) i = k;
  if (t < keys[0]!.at) i = n - 1;
  const j = loop ? (i + 1) % n : Math.min(i + 1, n - 1);
  const a0 = keys[i]!.at, a1 = j > i ? keys[j]!.at : keys[j]!.at + 1;
  const tt = t < a0 ? t + 1 : t;
  const u = a1 > a0 ? (tt - a0) / (a1 - a0) : 0;
  const B = get(keys[i]!), C = get(keys[j]!);
  if (!smooth) return B.map((b, k) => b + (C[k]! - b) * u);
  const A = get(keys[loop ? (i - 1 + n) % n : Math.max(0, i - 1)]!), D = get(keys[loop ? (j + 1) % n : Math.min(n - 1, j + 1)]!);
  return B.map((b, k) => catmull(A[k]!, b, C[k]!, D[k]!, u));
}

/** Where a clip is through (0..1) for a figure doing `s` (its swing: `swing`, its draw: `draw`). */
function through(clip: AnimClip, s: FigureState, swing: number, draw: number): number {
  const wrap = (v: number) => v - Math.floor(v);
  switch (clip.driver) {
    case 'time':
      return wrap(s.time / Math.max(0.01, clip.length ?? 1));
    case 'stride':
      return wrap(s.stride / (2 * Math.PI));
    case 'draw':
      return draw;
    case 'swing':
      return swing;
    default:
      return 0;
  }
}

/** A clip's joints and body at t, where they look `pitch` (aims added). */
function evaluate(clip: AnimClip, t: number, pitch: number): FigurePose {
  const loop = clip.driver === 'time' || clip.driver === 'stride';
  const joints: FigurePose['joints'] = {};
  for (const [name, keys] of Object.entries(clip.joints) as [FigureJoint, AnimKey[]][]) {
    if (!keys.length) continue;
    const [x, y, z, aim] = sample(keys, t, clip.smooth, loop, (k) => [...k.turn, k.aim ?? 0]);
    joints[name] = [x! + aim! * pitch, y!, z!];
  }
  const body = clip.body?.length ? sample(clip.body, t, clip.smooth, loop, (k) => [k.lean, k.lift]) : [0, 0];
  return { joints, lean: body[0]!, lift: body[1]! };
}

/** `w` of each pose, added up (joints a pose doesn't have count as straight). */
function blend(parts: { pose: FigurePose; w: number }[]): FigurePose {
  const joints: FigurePose['joints'] = {};
  let lean = 0, lift = 0;
  for (const { pose, w } of parts) {
    if (w === 0) continue;
    lean += pose.lean * w;
    lift += pose.lift * w;
    for (const [name, r] of Object.entries(pose.joints) as [FigureJoint, [number, number, number]][]) {
      const to = (joints[name] ??= [0, 0, 0]);
      for (let k = 0; k < 3; k++) to[k]! += r[k]! * w;
    }
  }
  return { joints, lean, lift };
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The pose for a figure doing `s`, by `lib`: the movement it's making (swimming, flying, in the
 * air, or standing, walking and running blended by its speed), breathing added on, the head and
 * chest following where it looks, then digging or a bow (its own joints only) on top.
 */
export function poseFigure(lib: AnimationLibrary, s: FigureState): FigurePose {
  const c = lib.clips, set = lib.settings;
  const at = (id: ClipId, swing = 0, draw = 0) => evaluate(c[id], through(c[id], s, swing, draw), s.pitch);
  let move: ClipId, pose: FigurePose;
  if (s.swimming) pose = at((move = 'swim'));
  else if (s.flying) {
    pose = at((move = 'fly'));
    pose.lean += -Math.min(set.flyLeanMax, s.speed * set.flyLean);
  } else if (s.airborne) pose = at((move = 'jump'));
  else {
    move = 'walk';
    const go = Math.min(1, s.speed / Math.max(0.01, set.walkFull)), run = smoothstep(set.runFrom, set.runTo, s.speed);
    pose = blend([
      { pose: at('idle'), w: 1 - go },
      { pose: at('walk'), w: go * (1 - run) },
      { pose: at('run'), w: go * run },
    ]);
  }
  // Breathing, added on.
  const breath = at('breathe');
  for (const [name, r] of Object.entries(breath.joints) as [FigureJoint, [number, number, number]][]) {
    const to = (pose.joints[name] ??= [0, 0, 0]);
    for (let k = 0; k < 3; k++) to[k]! += r[k]!;
  }
  // Looking where it looks.
  const look = c[move].look ?? { head: 0, chest: 0, level: false };
  const head = (pose.joints.head ??= [0, 0, 0]), chest = (pose.joints.chest ??= [0, 0, 0]);
  head[0] += s.pitch * look.head - (look.level ? pose.lean : 0);
  chest[0] += s.pitch * look.chest;
  // A bow, or else a dig or a swing, over the top.
  const chop = s.mining ? (s.time % set.digSeconds) / set.digSeconds : s.swing;
  const action = s.draw !== null ? at('bow', 0, s.draw) : chop !== null ? at('dig', chop) : null;
  if (action) Object.assign(pose.joints, action.joints);
  return pose;
}

/** One clip alone, `t` of the way through (0..1), looking `pitch` (the animation designer shows clips so). */
export function poseClip(lib: AnimationLibrary, id: ClipId, t: number, pitch = 0): FigurePose {
  return evaluate(lib.clips[id], t, pitch);
}

/**
 * How long a clip takes to play through once at its usual pace (s), to preview it: a time clip, its
 * length; a walk or a run, a stride at the game's walking or sprinting speed; a dig, its
 * swing; a bow, a draw (`drawSeconds`); a still pose, a second.
 */
export function clipSeconds(lib: AnimationLibrary, id: ClipId, drawSeconds: number, strides?: { walk: number; run: number }): number {
  const c = lib.clips[id], s = lib.settings;
  if (c.driver === 'time') return c.length ?? 1;
  // (The strides as they'll be: given, worked out from the feet; else the settings', when they're set.)
  const walk = strides?.walk ?? (s.walkStride || 1.6), run = strides?.run ?? (s.runStride || 2.6);
  if (c.driver === 'stride') return id === 'run' ? run / (WALK_SPEED * SPRINT) : walk / WALK_SPEED;
  if (c.driver === 'swing') return s.digSeconds;
  if (c.driver === 'draw') return drawSeconds;
  return 1;
}

/** Which grip a thing is held by: a bow; a block (or a designed thing: anything drawn as a cube); anything else, by its handle. */
export function gripKind(isBow: boolean, isCube: boolean): GripKind {
  return isBow ? 'bow' : isCube ? 'block' : 'tool';
}

// --- The defaults: as the figures moved before the library ---

/** Keys round a loop: `n` of them, evenly, each from f(t) (t 0..1). */
function around(n: number, f: (t: number) => [number, number, number]): AnimKey[] {
  return Array.from({ length: n }, (_, i) => ({ at: i / n, turn: f(i / n) }));
}
const still = (turn: [number, number, number]): AnimKey[] => [{ at: 0, turn }];
const TAU = 2 * Math.PI;

// The man's leg (the client's MAN: see playerFigure.ts), m, standing: (down, back) from the hip to
// the knee, the knee to the ankle; the ankle over the sole; the heel and toe behind and ahead of it.
const THIGH: Vec2 = [-0.412, 0.018], SHIN: Vec2 = [-0.41, 0.05];
const ANKLE_UP = 0.101, HEEL_BACK = 0.08, TOE_AHEAD = 0.192;
/** The hips over the ground, standing (lift 0). */
const HIP_UP = -THIGH[0] - SHIN[0] + ANKLE_UP;
type Vec2 = [number, number];
/** (y, z) turned about x, as a joint turns. */
const rotX = ([y, z]: Vec2, a: number): Vec2 => [y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
/** How far forward of straight down (radians) a (y, z) points. */
const forwardOf = ([y, z]: Vec2) => Math.atan2(-z, -y);
const shank = (knee: number): Vec2 => {
  const s = rotX(SHIN, knee);
  return [THIGH[0] + s[0], THIGH[1] + s[1]];
};
/** The knee as straight as it goes (the shin in line with the thigh), and never quite straight: bent this much at least. */
const KNEE_STRAIGHT = forwardOf(THIGH) - forwardOf(SHIN), KNEE_LEAST = KNEE_STRAIGHT - 0.12;
const REACH = Math.hypot(...shank(KNEE_LEAST));

/**
 * The thigh's turn (to the ground: forward +) and the knee's for the ankle to be `fwd` ahead of the
 * hip and `down` below it (as near as it reaches: the knee bent a little at least).
 */
function legTo(fwd: number, down: number): { thigh: number; knee: number } {
  const d = Math.hypot(fwd, down);
  let lo = KNEE_LEAST - 2.6, hi = KNEE_LEAST;
  if (d >= REACH) lo = hi;
  // (Shorter the more it bends.)
  for (let i = 0; i < 40 && lo < hi; i++) {
    const mid = (lo + hi) / 2;
    if (Math.hypot(...shank(mid)) > d) hi = mid;
    else lo = mid;
  }
  const knee = (lo + hi) / 2;
  return { thigh: Math.atan2(fwd, down) - forwardOf(shank(knee)), knee };
}

/**
 * A planted foot, `g` ahead of the hip (where its ankle'd be flat) with the hips `h` over the
 * ground: flat if the leg reaches it; else rolled just enough that it does: on its heel, toes up,
 * ahead (coming down); on its toes, heel up, behind (pushing off). Its leg, its turn (toes up +),
 * and where its ankle is (forward of the hip, up off the ground).
 */
function plant(g: number, h: number): { thigh: number; knee: number; foot: number; ankle: Vec2 } {
  const ankleAt = (roll: number): Vec2 => {
    // From the heel or toe it rolls on: (forward, up) of it, turned by the roll.
    const [f, v] = roll >= 0 ? [HEEL_BACK, ANKLE_UP] : [-TOE_AHEAD, ANKLE_UP];
    const pivot = roll >= 0 ? g - HEEL_BACK : g + TOE_AHEAD;
    return [pivot + f * Math.cos(roll) - v * Math.sin(roll), f * Math.sin(roll) + v * Math.cos(roll)];
  };
  const reach = (roll: number) => {
    const [fwd, up] = ankleAt(roll);
    return Math.hypot(fwd, h - up);
  };
  let roll = 0;
  if (reach(0) > REACH) {
    const way = g >= 0 ? 1 : -1;
    let lo = 0, hi = 1.2;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (reach(way * mid) > REACH) lo = mid;
      else hi = mid;
    }
    roll = way * hi;
  }
  const [fwd, up] = ankleAt(roll);
  return { ...legTo(fwd, h - up), foot: roll, ankle: [fwd, up] };
}

/**
 * A walk (0) or a run (1), from a foot coming down (the left, ahead): each foot goes back steadily
 * while it's down (the walk: most of the stride, both feet down at the change; the run: a quarter,
 * both off the ground between), then swings forward quickly, its knee bent and toes up; the arms the
 * other way. The planted leg's worked out (see plant) for the hips to go up and down only a little:
 * its knee bends to take it, the foot flat, or rolling onto the heel or the toes at the ends. A walk's
 * hips are highest over the planted foot, a run's lowest (it lands and springs up, into the air). The
 * swinging leg's worked out for its foot to go forward over the ground (never through it).
 * Even back-going feet: a stride locked to them doesn't slide (see the client's lockedStride).
 */
function stride(run: number): AnimClip {
  const N = 32, lean = -0.22 * run;
  /** How long a foot's down (of a stride); how far ahead and behind the hip it is then (m). */
  const down = run ? 0.25 : 0.6, reach = run ? 0.4 : 0.38;
  /** The hips (m): a walk's, over the planted foot, with the knee bent this much (radians), and how much lower at the change; a run's, landing, how much lower in the middle of the step, higher in the air. */
  const midBend = 0.25, walkBob = 0.045, runLow = 0.07, runDip = 0.03, runRise = 0.03;
  /** How high the swinging foot's lifted (m, halfway). */
  const clear = run ? 0.3 : 0.08;
  const swingOf = (u: number) => (u - down) / (1 - down);
  const ease = (a: number, b: number, f: number) => a + (b - a) * (1 - Math.cos(Math.PI * f)) / 2;
  const L = (t: number) => t, R = (t: number) => (t + 0.5) % 1;
  /** The hips over the ground (m), t of the way through the stride (the same each step: every half). */
  const hips = (t: number) => {
    const s = (t % 0.5) / 0.5;
    if (!run) {
      // Lowest in the middle of both feet being down.
      const top = Math.hypot(...shank(KNEE_STRAIGHT - midBend)) + ANKLE_UP, low = (down - 0.5) / 2 / 0.5;
      return top - (walkBob * (1 + Math.cos(2 * Math.PI * (s - low)))) / 2;
    }
    const land = HIP_UP - runLow;
    const d = down / 0.5;
    return s < d ? land - runDip * Math.sin((Math.PI * s) / d) : land + runRise * Math.sin((Math.PI * (s - d)) / (1 - d));
  };
  /** A leg u of the way through its stride from coming down, the hips at hips(t): the thigh (to the ground), knee, foot (to the ground). */
  const atDown = (u: number, t: number) => plant(reach * (1 - (2 * u) / down), hips(t));
  const first = atDown(0, 0), last = atDown(down, down);
  const legAt = (u: number, t: number) => {
    if (u < down) return atDown(u, t);
    // From where it lifted to where it comes down, up off the ground between, toes up.
    const f = swingOf(u), [b, a] = [last.ankle, first.ankle];
    const up = b[1] + (a[1] - b[1]) * f + clear * Math.sin(Math.PI * f);
    return { ...legTo(ease(b[0], a[0], f), hips(t) - up), foot: ease(last.foot, first.foot, f) + 0.2 * Math.sin(Math.PI * f) };
  };
  // (The body leans: the leg turns from it as much the other way, to be as it is to the ground; the foot from the shin.)
  const joints = (u: (t: number) => number) => {
    const at = (t: number) => legAt(u(t), t);
    return {
      leg: around(N, (t) => [at(t).thigh - lean, 0, 0]),
      knee: around(N, (t) => [at(t).knee, 0, 0]),
      ankle: around(N, (t) => {
        const l = at(t);
        return [l.foot - l.thigh - l.knee, 0, 0];
      }),
    };
  };
  const left = joints(L), right = joints(R);
  /** The arms swing against the legs: back as its leg goes forward, forward as it goes back. */
  const arm = (u: number) => {
    const slant = run ? 0.5 : 0.45;
    return -0.8 * (u < down ? slant - (2 * slant * u) / down : ease(-slant, slant, swingOf(u)));
  };
  return {
    driver: 'stride',
    smooth: true,
    joints: {
      legL: left.leg,
      legR: right.leg,
      kneeL: left.knee,
      kneeR: right.knee,
      ankleL: left.ankle,
      ankleR: right.ankle,
      shoulderL: around(N, (t) => [arm(L(t)), 0, -0.08]),
      shoulderR: around(N, (t) => [arm(R(t)), 0, 0.08]),
      elbowL: still([0.25 + 0.9 * run, 0, 0]),
      elbowR: still([0.25 + 0.9 * run, 0, 0]),
    },
    body: Array.from({ length: N }, (_, i) => ({ at: i / N, lean, lift: hips(i / N) - HIP_UP })),
    look: { head: 0.6, chest: 0.15, level: true },
  };
}

export function defaultAnimations(): AnimationLibrary {
  const stroke = 2 * Math.PI / 2.6, N = 32;
  return {
    clips: {
      idle: { driver: 'still', smooth: false, joints: { shoulderL: still([0, 0, -0.08]), shoulderR: still([0, 0, 0.08]) }, look: { head: 0.6, chest: 0.15, level: true } },
      walk: stride(0),
      run: stride(1),
      // Lying forward, legs fluttering (four beats to a stroke), arms sweeping round.
      swim: {
        driver: 'time',
        length: stroke,
        smooth: true,
        joints: {
          legL: around(N, (t) => [Math.sin(t * TAU * 4) * 0.35, 0, 0]),
          legR: around(N, (t) => [-Math.sin(t * TAU * 4) * 0.35, 0, 0]),
          kneeL: around(N, (t) => [-0.3 - Math.max(0, Math.sin(t * TAU * 4) * 0.35), 0, 0]),
          kneeR: around(N, (t) => [-0.3 - Math.max(0, -Math.sin(t * TAU * 4) * 0.35), 0, 0]),
          shoulderL: around(N, (t) => [2.6 + Math.sin(t * TAU) * 0.6, 0, -0.6 - Math.cos(t * TAU) * 0.5]),
          shoulderR: around(N, (t) => [2.6 + Math.sin(t * TAU) * 0.6, 0, 0.6 + Math.cos(t * TAU) * 0.5]),
          elbowL: still([0.4, 0, 0]),
          elbowR: still([0.4, 0, 0]),
          head: still([0.9, 0, 0]),
        },
        body: [{ at: 0, lean: -1.25, lift: 0 }],
        look: { head: 0.3, chest: 0, level: false },
      },
      fly: {
        driver: 'still',
        smooth: false,
        joints: { legL: still([-0.15, 0, 0]), legR: still([-0.1, 0, 0]), kneeL: still([-0.25, 0, 0]), kneeR: still([-0.2, 0, 0]), shoulderL: still([0.1, 0, -0.35]), shoulderR: still([0.1, 0, 0.35]) },
        look: { head: 0.6, chest: 0, level: true },
      },
      jump: {
        driver: 'still',
        smooth: false,
        joints: { legL: still([0.55, 0, 0]), legR: still([0.25, 0, 0]), kneeL: still([-0.9, 0, 0]), kneeR: still([-0.6, 0, 0]), shoulderL: still([0.3, 0, -0.55]), shoulderR: still([0.3, 0, 0.55]) },
        look: { head: 0.6, chest: 0, level: false },
      },
      breathe: {
        driver: 'time',
        length: (2 * Math.PI) / 1.6,
        smooth: true,
        joints: { chest: around(8, (t) => [-0.02 * Math.sin(t * TAU), 0, 0]), shoulderL: around(8, (t) => [0, 0, -0.02 * Math.sin(t * TAU)]), shoulderR: around(8, (t) => [0, 0, 0.02 * Math.sin(t * TAU)]) },
      },
      // The right arm up over the shoulder and chopping down, the body turning into it.
      dig: {
        driver: 'swing',
        smooth: false,
        joints: {
          shoulderR: [{ at: 0, turn: [0.4, 0, 0.15] }, { at: 0.35, turn: [2.7, 0, 0.15] }, { at: 1, turn: [0.4, 0, 0.15] }],
          elbowR: [{ at: 0, turn: [0.6, 0, 0] }, { at: 0.35, turn: [0.1, 0, 0] }, { at: 1, turn: [0.6, 0, 0] }],
          spine: [{ at: 0, turn: [0, 0, 0] }, { at: 0.35, turn: [0, -0.25, 0] }, { at: 1, turn: [0, 0, 0] }],
        },
      },
      // The body a little side-on (left shoulder to the shot); the bow arm and head turned back along
      // it, aimed where it looks; the drawing hand from the string round to the cheek.
      bow: {
        driver: 'draw',
        smooth: false,
        joints: {
          spine: still([0, -0.35, 0]),
          shoulderL: [{ at: 0, turn: [Math.PI / 2, 0.35, 0], aim: 1 }],
          elbowL: still([0, 0, 0]),
          shoulderR: [{ at: 0, turn: [Math.PI / 2, 0.35, 0], aim: 1 }, { at: 1, turn: [1.2, 0.6, -1.0], aim: 0 }],
          elbowR: [{ at: 0, turn: [0.3, 0, 0] }, { at: 1, turn: [1.6, 0, 0] }],
          head: [{ at: 0, turn: [0, 0.35, 0], aim: 0.8 }],
        },
      },
    },
    settings: { walkFull: 1.2, runFrom: 2.2, runTo: 3.2, walkStride: 0, runStride: 0, digSeconds: 0.32, flyLean: 0.03, flyLeanMax: 0.5 },
    grips: {
      tool: { hand: 'right', at: [0, 0.06, -0.17], turn: [0, Math.PI / 2, 0], scale: 0.5 },
      block: { hand: 'right', at: [0, -0.15, -0.04], turn: [0, 0, 0], scale: 0.2 },
      bow: { hand: 'left', at: [0, 0.06, -0.17], turn: [0, Math.PI / 2, 0], scale: 0.5 },
    },
  };
}

// --- Reading one (from the file, or an admin's save) ---

const num = (v: unknown, lo = -1e3, hi = 1e3): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const triple = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((x) => num(x, -20, 20));

function parseKeys(v: unknown): AnimKey[] | string {
  if (!Array.isArray(v) || v.length === 0 || v.length > 256) return 'keys: 1 to 256 of them';
  const out: AnimKey[] = [];
  for (const k of v as Record<string, unknown>[]) {
    if (!k || !num(k.at, 0, 1) || !triple(k.turn) || (k.aim !== undefined && !num(k.aim, -4, 4))) return 'a key needs at (0..1) and turn [x, y, z]';
    out.push({ at: k.at, turn: [...k.turn], ...(k.aim !== undefined && k.aim !== 0 ? { aim: k.aim } : {}) });
  }
  return out.sort((a, b) => a.at - b.at);
}

function parseClip(v: unknown, id: string): AnimClip | string {
  if (!v || typeof v !== 'object') return `${id}: not a clip`;
  const c = v as Record<string, unknown>;
  if (!['time', 'stride', 'draw', 'swing', 'still'].includes(c.driver as string)) return `${id}: no such driver`;
  if (c.driver === 'time' && !num(c.length, 0.05, 600)) return `${id}: a time clip needs a length (s)`;
  const joints: AnimClip['joints'] = {};
  for (const [name, keys] of Object.entries((c.joints as Record<string, unknown>) ?? {})) {
    if (!(FIGURE_JOINTS as readonly string[]).includes(name)) return `${id}: no joint ${name}`;
    const k = parseKeys(keys);
    if (typeof k === 'string') return `${id} ${name}: ${k}`;
    joints[name as FigureJoint] = k;
  }
  let body: BodyKey[] | undefined;
  if (c.body !== undefined) {
    if (!Array.isArray(c.body) || c.body.length > 256) return `${id}: body keys`;
    body = [];
    for (const k of c.body as Record<string, unknown>[]) {
      if (!k || !num(k.at, 0, 1) || !num(k.lean, -3.2, 3.2) || !num(k.lift, -2, 2)) return `${id}: a body key needs at, lean and lift`;
      body.push({ at: k.at, lean: k.lean, lift: k.lift });
    }
    body.sort((a, b) => a.at - b.at);
  }
  const l = c.look as Record<string, unknown> | undefined;
  if (l !== undefined && (!l || !num(l.head, -2, 2) || !num(l.chest, -2, 2) || typeof l.level !== 'boolean')) return `${id}: look needs head, chest, level`;
  return {
    driver: c.driver as AnimDriver,
    ...(c.driver === 'time' ? { length: c.length as number } : {}),
    smooth: c.smooth === true,
    joints,
    ...(body ? { body } : {}),
    ...(l ? { look: { head: l.head as number, chest: l.chest as number, level: l.level as boolean } } : {}),
  };
}

/** A library from untrusted data (a file, a save): every clip, setting and grip it has checked; anything it lacks, the default. Or why it won't do. */
export function parseAnimationLibrary(raw: unknown): AnimationLibrary | string {
  const d = defaultAnimations();
  if (!raw || typeof raw !== 'object') return 'not an animation library';
  const r = raw as Record<string, unknown>;
  const clips = { ...d.clips };
  for (const [id, v] of Object.entries((r.clips as Record<string, unknown>) ?? {})) {
    if (!(CLIP_IDS as readonly string[]).includes(id)) return `no clip called ${id}`;
    const clip = parseClip(v, id);
    if (typeof clip === 'string') return clip;
    clips[id as ClipId] = clip;
  }
  const settings = { ...d.settings };
  for (const [k, v] of Object.entries((r.settings as Record<string, unknown>) ?? {})) {
    if (!(k in settings)) return `no setting called ${k}`;
    if (!num(v, 0, 100)) return `${k}: 0..100`;
    (settings as Record<string, number>)[k] = v;
  }
  if (settings.runTo <= settings.runFrom) return 'running must start before it is full (runFrom < runTo)';
  const grips = { ...d.grips };
  for (const [k, v] of Object.entries((r.grips as Record<string, unknown>) ?? {})) {
    if (!(GRIP_KINDS as readonly string[]).includes(k)) return `no grip called ${k}`;
    const g = v as Record<string, unknown>;
    if (!g || (g.hand !== 'left' && g.hand !== 'right') || !triple(g.at) || !triple(g.turn) || !num(g.scale, 0.01, 4)) return `${k}: a grip needs hand, at, turn, scale`;
    grips[k as GripKind] = { hand: g.hand, at: [...g.at], turn: [...g.turn], scale: g.scale };
  }
  return { clips, settings, grips };
}
