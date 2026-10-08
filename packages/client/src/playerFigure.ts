import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { FIGURE_JOINTS, defaultAnimations, poseClip, poseFigure, type AnimationLibrary, type FigurePose as Pose, type FigureState } from '@super-vox/shared';
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
export const JOINTS = FIGURE_JOINTS as readonly Joint[];

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

export type { FigureState, FigurePose as Pose } from '@super-vox/shared';

/** The animations in play: the server's library (see setAnimations), else the defaults. */
let library: AnimationLibrary = defaultAnimations();
export function animations(): AnimationLibrary {
  return library;
}
/** The server's animation library (it sends it, and again whenever an admin changes it). */
export function setAnimations(lib: AnimationLibrary): void {
  library = lib;
}

/**
 * How far a stride (two steps) of a walk or run clip carries the body with its feet planted (m):
 * how fast the left foot goes back under the body while it's down (within 2.5 cm of as low as it
 * goes; the middle half of those moments' speeds, on average, so its coming down and lifting don't count), in metres a
 * stride. At that stride the body goes forward as fast as a planted foot goes back: no sliding.
 * Null if the clip never puts a foot down and back.
 */
export function lockedStride(lib: AnimationLibrary, clip: 'walk' | 'run', figure = scratchFigure()): number | null {
  const N = 128, ys: number[] = [], zs: number[] = [];
  const foot = figure.joints.get('ankleL')!, box = new THREE.Box3();
  for (let i = 0; i < N; i++) {
    figure.pose(poseClip(lib, clip, i / N));
    figure.root.updateMatrixWorld(true);
    box.setFromObject(foot);
    ys.push(box.min.y);
    zs.push((box.min.z + box.max.z) / 2);
  }
  const low = Math.min(...ys), speeds: number[] = [];
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    // (Back is +z: the figure faces -z. Metres a stride: a step of 1/N of one.)
    // (Down, and going back: not a foot just lifting into its swing forward, still low.)
    if (ys[i]! < low + 0.025 && ys[j]! < low + 0.025 && zs[j]! > zs[i]!) speeds.push((zs[j]! - zs[i]!) * N);
  }
  if (speeds.length < 3) return null;
  // (The middle half of them, on average: not the moments it's just coming down or lifting.)
  speeds.sort((a, b) => a - b);
  const middle = speeds.slice(Math.floor(speeds.length / 4), Math.ceil((speeds.length * 3) / 4));
  const mean = middle.reduce((t, v) => t + v, 0) / middle.length;
  return mean > 0.05 ? mean : null;
}
let scratch: PlayerFigure | null = null;
const scratchFigure = () => (scratch ??= new PlayerFigure(0xffffff));

/** The strides (m) a library's figures walk and run at: its settings', or (0) locked to their feet (see lockedStride). */
export function measureStrides(lib: AnimationLibrary): { walk: number; run: number } {
  const s = lib.settings;
  return { walk: s.walkStride || lockedStride(lib, 'walk') || 1.6, run: s.runStride || lockedStride(lib, 'run') || 2.6 };
}
const strideCache = new WeakMap<AnimationLibrary, { walk: number; run: number }>();
/** The strides the animations in play walk and run at (worked out once for each library). */
export function strides(): { walk: number; run: number } {
  let st = strideCache.get(library);
  if (!st) strideCache.set(library, (st = measureStrides(library)));
  return st;
}

/** The pose for what a figure's doing, by the animations in play (see poseFigure). */
export function poseFor(s: FigureState): Pose {
  return poseFigure(library, s);
}

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
