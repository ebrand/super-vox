import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import manObj from './models/low-poly-man.obj?raw';

/**
 * A player as others see them: the low-poly mannequin (models/low-poly-man.obj: its rigid pieces,
 * each hung on a joint of a skeleton: hips, spine, chest, neck, head; shoulders, elbows, wrists;
 * hips, knees, ankles), posed every frame by what they're doing (see poseFor): standing, walking
 * and running (strides as fast as they go), jumping and falling, swimming, flying, digging and
 * swinging, and drawing a bow (the arm holding it out where they look, the other drawing back to
 * the cheek). Facing -z, its feet at the origin, FIGURE_HEIGHT tall.
 */

export const FIGURE_HEIGHT = 1.8;

/** The skeleton: each joint and the joint it hangs on. */
const SKELETON = {
  hips: {},
  spine: { parent: 'hips' },
  chest: { parent: 'spine' },
  neck: { parent: 'chest' },
  head: { parent: 'neck' },
  shoulderL: { parent: 'chest' },
  elbowL: { parent: 'shoulderL' },
  wristL: { parent: 'elbowL' },
  shoulderR: { parent: 'chest' },
  elbowR: { parent: 'shoulderR' },
  wristR: { parent: 'elbowR' },
  legL: { parent: 'hips' },
  kneeL: { parent: 'legL' },
  ankleL: { parent: 'kneeL' },
  legR: { parent: 'hips' },
  kneeR: { parent: 'legR' },
  ankleR: { parent: 'kneeR' },
} as const satisfies Record<string, { parent?: string }>;

export type Joint = keyof typeof SKELETON;
export const JOINTS = Object.keys(SKELETON) as Joint[];

/**
 * A model of a figure: its OBJ, which of its pieces (by name) each joint carries (null: not drawn,
 * such as a ground plane), and the ball each limb turns about (its middle is the joint), if it has
 * one. Which way it faces in the file (its toes): +z turned round to face -z.
 */
export interface FigureModelSpec {
  obj: string;
  parts: Record<string, Joint | null>;
  balls: Partial<Record<Joint, string>>;
  facesPlusZ: boolean;
}

/** The man (models/low-poly-man.obj): in the file he faces +z, his left side at +x. */
export const MAN: FigureModelSpec = {
  obj: manObj,
  parts: {
    Cube: 'chest', 'Cube.001': 'spine', 'Cube.002': 'hips', 'Cube.005': 'neck', 'Cube.006': 'head',
    Icosphere: 'shoulderL', 'Cube.003': 'shoulderL', 'Icosphere.002': 'elbowL', 'Cube.004': 'elbowL', 'Cube.015_Cube.016': 'wristL', 'Cube.016_Cube.017': 'wristL',
    'Icosphere.001': 'shoulderR', 'Cube.007': 'shoulderR', 'Icosphere.003': 'elbowR', 'Cube.008': 'elbowR', 'Cube.017_Cube.018': 'wristR', 'Cube.018_Cube.019': 'wristR',
    'Cube.011': 'legL', 'Icosphere.005': 'kneeL', 'Cube.012': 'kneeL', 'Cube.013_Cube.015': 'ankleL',
    'Cube.009': 'legR', 'Icosphere.004': 'kneeR', 'Cube.010_Cube.012': 'kneeR', 'Cube.014': 'ankleR',
    Plane: null,
  },
  balls: { shoulderL: 'Icosphere', elbowL: 'Icosphere.002', kneeL: 'Icosphere.005', shoulderR: 'Icosphere.001', elbowR: 'Icosphere.003', kneeR: 'Icosphere.004' },
  facesPlusZ: true,
};

/** A figure's pieces, ready to hang: each joint's geometry (m, from the joint) and where the joint is (m, standing straight, from the feet). */
export interface FigureModel {
  parts: Map<Joint, THREE.BufferGeometry>;
  pivots: Map<Joint, THREE.Vector3>;
}

/** Shading per face (lit from above, a little in front and to one side), as the held items are shaded. */
const LIGHT = new THREE.Vector3(0.35, 1, -0.5).normalize();

/**
 * A figure's model from its spec: its pieces turned to face -z, standing on y = 0, FIGURE_HEIGHT tall;
 * each joint's pieces as one geometry (flat-shaded faces, their shading in vertex colours), from
 * the joint: a ball's middle (shoulders, elbows, knees); a hip at its thigh's top; a wrist or an
 * ankle at the bottom of the forearm or shin it hangs on; the body's joints at the bottom of their
 * piece (the hips: its middle). Throws if a piece isn't named in the spec.
 */
export function figureModel(spec: FigureModelSpec): FigureModel {
  const group = new OBJLoader().parse(spec.obj);
  const pieces: { name: string; joint: Joint; geometry: THREE.BufferGeometry }[] = [];
  const all = new THREE.Box3();
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const joint = spec.parts[o.name];
    if (joint === undefined) throw new Error(`figure model: what's "${o.name}"?`);
    if (joint === null) return;
    const g = (o.geometry as THREE.BufferGeometry).clone();
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    if (spec.facesPlusZ) g.rotateY(Math.PI);
    g.computeBoundingBox();
    all.union(g.boundingBox!);
    pieces.push({ name: o.name, joint, geometry: g });
  });
  // Standing on the ground, FIGURE_HEIGHT tall, its middle over the origin.
  const scale = FIGURE_HEIGHT / (all.max.y - all.min.y), centre = all.getCenter(new THREE.Vector3());
  for (const p of pieces) {
    p.geometry.translate(-centre.x, -all.min.y, -centre.z);
    p.geometry.scale(scale, scale, scale);
    p.geometry.computeBoundingBox();
  }
  const box = (name: string) => pieces.find((p) => p.name === name)!.geometry.boundingBox!;
  // A joint's main piece: its biggest that isn't its ball.
  const main = (j: Joint) => {
    const mine = pieces.filter((p) => p.joint === j && p.name !== spec.balls[j]);
    if (!mine.length) throw new Error(`figure model: nothing hangs on ${j}`);
    const size = (p: (typeof mine)[number]) => p.geometry.boundingBox!.getSize(new THREE.Vector3()).toArray().reduce((a, b) => a * b, 1);
    return mine.reduce((a, b) => (size(b) > size(a) ? b : a)).geometry.boundingBox!;
  };
  const bottom = (b: THREE.Box3) => new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2);
  const top = (b: THREE.Box3) => new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2);
  const pivots = new Map<Joint, THREE.Vector3>();
  for (const j of JOINTS) {
    const ball = spec.balls[j];
    let at: THREE.Vector3;
    if (ball) at = box(ball).getCenter(new THREE.Vector3());
    else if (j === 'hips') at = main(j).getCenter(new THREE.Vector3());
    else if (j === 'legL' || j === 'legR') at = top(main(j));
    else if (j === 'wristL' || j === 'wristR' || j === 'ankleL' || j === 'ankleR') at = bottom(main(SKELETON[j].parent));
    else at = bottom(main(j));
    pivots.set(j, at);
  }
  // Each joint's pieces as one, from the joint, flat-shaded.
  const parts = new Map<Joint, THREE.BufferGeometry>();
  for (const j of JOINTS) {
    const mine = pieces.filter((p) => p.joint === j).map((p) => (p.geometry.index ? p.geometry.toNonIndexed() : p.geometry));
    const pos: number[] = [];
    for (const g of mine) pos.push(...Array.from(g.getAttribute('position').array as ArrayLike<number>));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const pv = pivots.get(j)!;
    g.translate(-pv.x, -pv.y, -pv.z);
    g.computeVertexNormals();
    const n = g.getAttribute('normal'), col = new Float32Array(n.count * 3), v = new THREE.Vector3();
    for (let i = 0; i < n.count; i++) {
      v.fromBufferAttribute(n, i);
      const shade = 0.55 + 0.45 * Math.max(0, v.dot(LIGHT)) + 0.08 * Math.max(0, v.y);
      col.set([shade, shade, shade], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeBoundingSphere();
    parts.set(j, g);
  }
  return { parts, pivots };
}

/** The man's model, made once (every figure shares it). */
let man: FigureModel | null = null;
function manModel(): FigureModel {
  man ??= figureModel(MAN);
  return man;
}

/** What a player's doing this frame (see poseFor). */
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
export interface Pose {
  joints: Partial<Record<Joint, [number, number, number]>>;
  lean: number;
  lift: number;
}

/** How fast walking turns to running (m/s), and how long a dig's swing takes (s). */
const RUN_FROM = 4.6;
const DIG_S = 0.32;

/**
 * The pose for what a player's doing. Turning about x tips a part's lower end forward (a leg
 * forward, an arm raised in front); a knee or elbow bends back with negative x (knee) or forward
 * with positive x (elbow); about z, an arm out to the side (left: -, right: +).
 */
export function poseFor(s: FigureState): Pose {
  const j: Pose['joints'] = {};
  const set = (k: Joint, x: number, y = 0, z = 0) => (j[k] = [x, y, z]);
  let lean = 0, lift = 0;
  const breath = Math.sin(s.time * 1.6) * 0.02;
  // Arms hang a little out; a breath lifts the chest.
  set('shoulderL', 0, 0, -0.08 - breath);
  set('shoulderR', 0, 0, 0.08 + breath);
  set('chest', -breath);
  if (s.swimming) {
    // Swimming: lying forward, legs fluttering, arms sweeping round in a stroke.
    lean = -1.25;
    const f = Math.sin(s.time * 9) * 0.35, stroke = s.time * 2.6;
    set('legL', f);
    set('legR', -f);
    set('kneeL', -0.3 - Math.max(0, f));
    set('kneeR', -0.3 - Math.max(0, -f));
    set('shoulderL', 2.6 + Math.sin(stroke) * 0.6, 0, -0.6 - Math.cos(stroke) * 0.5);
    set('shoulderR', 2.6 + Math.sin(stroke) * 0.6, 0, 0.6 + Math.cos(stroke) * 0.5);
    set('elbowL', 0.4);
    set('elbowR', 0.4);
    set('head', 0.9 + s.pitch * 0.3);
  } else if (s.flying) {
    // Flying: legs together, a little back; arms a little out; leaning into it the faster it goes.
    lean = -Math.min(0.5, s.speed * 0.03);
    set('legL', -0.15);
    set('legR', -0.1);
    set('kneeL', -0.25);
    set('kneeR', -0.2);
    set('shoulderL', 0.1, 0, -0.35);
    set('shoulderR', 0.1, 0, 0.35);
    set('head', s.pitch * 0.6 - lean);
  } else if (s.airborne) {
    // Jumping or falling: knees up, arms out for balance.
    set('legL', 0.55);
    set('legR', 0.25);
    set('kneeL', -0.9);
    set('kneeR', -0.6);
    set('shoulderL', 0.3, 0, -0.55);
    set('shoulderR', 0.3, 0, 0.55);
    set('head', s.pitch * 0.6);
  } else {
    // Standing, walking, running: legs swing (knees bending on the way back), arms the other way.
    const go = Math.min(1, s.speed / 1.5), run = smooth(RUN_FROM, RUN_FROM + 1, s.speed);
    const swing = go * (0.45 + 0.35 * run), sinS = Math.sin(s.stride), cosS = Math.cos(s.stride);
    set('legL', swing * sinS);
    set('legR', -swing * sinS);
    set('kneeL', -go * (0.15 + 0.9 * run) * Math.max(0, -cosS) - go * 0.15);
    set('kneeR', -go * (0.15 + 0.9 * run) * Math.max(0, cosS) - go * 0.15);
    set('ankleL', go * 0.2 * Math.max(0, cosS));
    set('ankleR', go * 0.2 * Math.max(0, -cosS));
    set('shoulderL', -swing * 0.8 * sinS, 0, -0.08 - breath);
    set('shoulderR', swing * 0.8 * sinS, 0, 0.08 + breath);
    set('elbowL', go * (0.25 + 0.9 * run));
    set('elbowR', go * (0.25 + 0.9 * run));
    lean = -0.22 * run;
    // A step's bob: lowest as the feet pass.
    lift = -go * (0.02 + 0.03 * run) * Math.abs(cosS);
    set('head', s.pitch * 0.6 - lean);
    set('chest', -breath + s.pitch * 0.15);
  }
  // Digging (over and over) or a swing: the right arm up over the shoulder and chopping down, the body turning into it.
  const chop = s.mining ? (s.time % DIG_S) / DIG_S : s.swing;
  if (chop !== null && s.draw === null) {
    const u = chop < 0.35 ? chop / 0.35 : 1 - (chop - 0.35) / 0.65;
    set('shoulderR', 0.4 + 2.3 * u, 0, 0.15);
    set('elbowR', 0.6 - 0.5 * u);
    set('spine', 0, -0.25 * u, 0);
  }
  // A bow: the left arm holding it out where it looks; the right drawing the string back to the chin.
  if (s.draw !== null) {
    // (The body turned a little, its left shoulder toward the shot; the bow arm and the head turned
    // back as much, so they point along it.)
    const twist = -0.35, d = s.draw, lerp = (a: number, b: number) => a + (b - a) * d;
    set('spine', 0, twist, 0);
    set('shoulderL', Math.PI / 2 + s.pitch, -twist, 0);
    set('elbowL', 0);
    // The drawing arm: from out in front at the string, round until the hand's at the cheek.
    set('shoulderR', lerp(Math.PI / 2 + s.pitch, 1.2), lerp(0.35, 0.6), lerp(0, -1.0));
    set('elbowR', lerp(0.3, 1.6));
    set('head', s.pitch * 0.8, -twist, 0);
  }
  return { joints: j, lean, lift };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A figure: its joints (each a group, its pieces in it), coloured `color` (shaded by the material's colour). */
export class PlayerFigure {
  readonly root = new THREE.Group();
  readonly joints = new Map<Joint, THREE.Group>();
  readonly material: THREE.MeshBasicMaterial;
  /** The whole body, leant and lifted as the pose says (inside root, which faces where they face). */
  private readonly body = new THREE.Group();
  /** Where the hips turn (m): the body leans about them. */
  private readonly hip: THREE.Vector3;

  constructor(color: THREE.ColorRepresentation, model: FigureModel = manModel()) {
    this.material = new THREE.MeshBasicMaterial({ vertexColors: true, color });
    this.root.add(this.body);
    for (const name of JOINTS) {
      const spec: { parent?: Joint } = SKELETON[name];
      const at = model.pivots.get(name)!, from = spec.parent ? model.pivots.get(spec.parent)! : new THREE.Vector3();
      const joint = new THREE.Group();
      joint.name = name;
      joint.position.copy(at).sub(from);
      const mesh = new THREE.Mesh(model.parts.get(name)!, this.material);
      mesh.name = `${name} part`;
      joint.add(mesh);
      this.joints.set(name, joint);
      (spec.parent ? this.joints.get(spec.parent)! : this.body).add(joint);
    }
    this.hip = model.pivots.get('hips')!.clone();
  }

  /** The hand a thing is held in (its wrist: right, or left for a bow). */
  hand(side: 'left' | 'right'): THREE.Group {
    return this.joints.get(side === 'left' ? 'wristL' : 'wristR')!;
  }

  /** Puts it in the pose (see poseFor). */
  pose(p: Pose): void {
    for (const [name, joint] of this.joints) {
      const r = p.joints[name];
      joint.rotation.set(r?.[0] ?? 0, r?.[1] ?? 0, r?.[2] ?? 0, 'YXZ');
    }
    // (Leaning about the hips, so it doesn't swing its feet out: they stay where they are.)
    const { y, z } = this.hip, c = Math.cos(p.lean), sn = Math.sin(p.lean);
    this.body.rotation.x = p.lean;
    this.body.position.set(0, y - (y * c - z * sn) + p.lift, z - (y * sn + z * c));
  }

  dispose(): void {
    this.material.dispose();
  }
}

/** A player's colour, from their name: soft, each its own hue (the same everywhere they're seen). */
export function playerColor(name: string): THREE.Color {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  const hue = ((h >>> 0) % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.32, 0.6, THREE.SRGBColorSpace);
}
