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
 * Steps a minute walking and sprinting at full pace (the footsteps heard: see the client's
 * footsteps.ts); the strides the legs take by default, to keep time with them (a stride is two steps).
 */
export const WALK_STEPS_PER_MINUTE = 80;
export const SPRINT_STEPS_PER_MINUTE = 120;
const WALK_STRIDE = (2 * WALK_SPEED * 60) / WALK_STEPS_PER_MINUTE;
const SPRINT_STRIDE = (2 * WALK_SPEED * SPRINT * 60) / SPRINT_STEPS_PER_MINUTE;

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
  /** A full stride (two steps), walking and running (m). */
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
export function clipSeconds(lib: AnimationLibrary, id: ClipId, drawSeconds: number): number {
  const c = lib.clips[id], s = lib.settings;
  if (c.driver === 'time') return c.length ?? 1;
  if (c.driver === 'stride') return id === 'run' ? s.runStride / (WALK_SPEED * SPRINT) : s.walkStride / WALK_SPEED;
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

/** A walk (0) or a run (1): legs swing (knees bending on the way back), arms the other way, a step's bob. */
function stride(run: number): AnimClip {
  const swing = 0.45 + 0.35 * run, knee = 0.15 + 0.9 * run, N = 16;
  const sin = (t: number) => Math.sin(t * TAU), cos = (t: number) => Math.cos(t * TAU);
  return {
    driver: 'stride',
    smooth: true,
    joints: {
      legL: around(N, (t) => [swing * sin(t), 0, 0]),
      legR: around(N, (t) => [-swing * sin(t), 0, 0]),
      kneeL: around(N, (t) => [-knee * Math.max(0, -cos(t)) - 0.15, 0, 0]),
      kneeR: around(N, (t) => [-knee * Math.max(0, cos(t)) - 0.15, 0, 0]),
      ankleL: around(N, (t) => [0.2 * Math.max(0, cos(t)), 0, 0]),
      ankleR: around(N, (t) => [0.2 * Math.max(0, -cos(t)), 0, 0]),
      shoulderL: around(N, (t) => [-swing * 0.8 * sin(t), 0, -0.08]),
      shoulderR: around(N, (t) => [swing * 0.8 * sin(t), 0, 0.08]),
      elbowL: still([0.25 + 0.9 * run, 0, 0]),
      elbowR: still([0.25 + 0.9 * run, 0, 0]),
    },
    body: Array.from({ length: N }, (_, i) => ({ at: i / N, lean: -0.22 * run, lift: -(0.02 + 0.03 * run) * Math.abs(cos(i / N)) })),
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
    settings: { walkFull: 1.5, runFrom: 4.6, runTo: 5.6, walkStride: Math.round(WALK_STRIDE * 100) / 100, runStride: Math.round(SPRINT_STRIDE * 100) / 100, digSeconds: 0.32, flyLean: 0.03, flyLeanMax: 0.5 },
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
