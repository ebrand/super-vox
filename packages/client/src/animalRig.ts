import * as THREE from 'three';

/**
 * The animals of models/animals.fbx (low-poly, one solid mesh each, no skeleton), rigged here: a
 * skeleton made for each from its shape (its feet found where it touches the ground, the legs'
 * tops at the belly between them; a neck where the head starts, a tail), each vertex weighted to
 * the bones by where it is. Then posed: walking and trotting (strides locked to the feet: a foot
 * down doesn't slide), grazing (the head down to the ground), hopping (the kangaroo).
 */
// (The file's rat is left out: 9 cm tall, its tail on the ground by its feet, too small to rig this way or to see.)
export type AnimalKind = 'horse' | 'cow' | 'pig' | 'bear' | 'cat' | 'ram' | 'kangaroo';
export const ANIMAL_KINDS: readonly AnimalKind[] = ['horse', 'cow', 'pig', 'bear', 'cat', 'ram', 'kangaroo'];

export interface AnimalSpec {
  /** Its mesh in the file. */
  mesh: string;
  /** How big (times the file's size, which is in cm). */
  scale: number;
  color: number;
  /** Four legs, or hops on two (and its tail). */
  plan: 'four' | 'hop';
  /** Where the neck starts (of its length, from the back) and the tail ends (from the back). */
  neck: number;
  tail: number;
  /** Walking and trotting (hopping) speeds (m/s). */
  walk: number;
  trot: number;
}

export const ANIMAL_SPEC: Record<AnimalKind, AnimalSpec> = {
  horse: { mesh: 'SM_LowpolyAnimal_Horse', scale: 0.01, color: 0x7a5232, plan: 'four', neck: 0.66, tail: 0.1, walk: 1.5, trot: 4 },
  cow: { mesh: 'SM_LowpolyAnimal_Cow', scale: 0.01, color: 0x5b4636, plan: 'four', neck: 0.72, tail: 0.08, walk: 1.1, trot: 3 },
  pig: { mesh: 'SM_LowpolyAnimal_Pig', scale: 0.0075, color: 0xd9a39a, plan: 'four', neck: 0.76, tail: 0.06, walk: 0.9, trot: 2.8 },
  bear: { mesh: 'SM_LowpolyAnimal_Bear', scale: 0.0085, color: 0x4a3426, plan: 'four', neck: 0.74, tail: 0.04, walk: 1.1, trot: 3.5 },
  cat: { mesh: 'SM_LowpolyAnimal_Cat', scale: 0.0045, color: 0x9a8f80, plan: 'four', neck: 0.74, tail: 0.29, walk: 0.6, trot: 2 },
  ram: { mesh: 'SM_LowpolyAnimal_Goat', scale: 0.009, color: 0xd8d0bc, plan: 'four', neck: 0.7, tail: 0.06, walk: 0.9, trot: 3 },
  kangaroo: { mesh: 'SM_LowpolyAnimal_Kangaroo', scale: 0.009, color: 0xa9774f, plan: 'hop', neck: 0.84, tail: 0.45, walk: 1.2, trot: 5 },
};

type Leg = 'frontL' | 'frontR' | 'hindL' | 'hindR';
const LEGS: readonly Leg[] = ['frontL', 'frontR', 'hindL', 'hindR'];
/** The bones: the body (everything else), the neck and the head on it, the tail, each leg's upper and lower part and its foot. */
const BONES = ['body', 'neck', 'head', 'tail', ...LEGS.flatMap((l) => [`${l}Upper`, `${l}Lower`, `${l}Foot`])] as const;
type BoneName = (typeof BONES)[number];

/** An animal's rigged model, made once for its kind (every one of them shares it). */
export interface AnimalModel {
  kind: AnimalKind;
  geometry: THREE.BufferGeometry;
  /** Where each bone turns (m, in the model: it faces +z, its feet on y 0, its middle on x and z 0). */
  pivots: Map<BoneName, THREE.Vector3>;
  /** Its legs (two hopping); how long each is (m, the hip or shoulder to the middle of its foot), and the shortest. */
  legs: Leg[];
  reach: Map<Leg, number>;
  legLength: number;
  /** How far down the neck turns for its mouth to reach the ground (radians; the head tucks a little more), and how much longer it stretches (times; some necks here are short). */
  graze: number;
  stretch: number;
  height: number;
  length: number;
}

/** The meshes in the file, by name (in metres as the file is in cm... before each kind's scale). */
export function animalMeshes(group: THREE.Object3D): Map<string, THREE.BufferGeometry> {
  group.updateMatrixWorld(true);
  const out = new Map<string, THREE.BufferGeometry>();
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', (m.geometry.getAttribute('position') as THREE.BufferAttribute).clone());
    g.applyMatrix4(m.matrixWorld);
    out.set(m.name, g.index ? g.toNonIndexed() : g);
  });
  return out;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Rigs one of the file's meshes (see animalMeshes) as `kind`. */
export function rigAnimal(kind: AnimalKind, source: THREE.BufferGeometry): AnimalModel {
  const spec = ANIMAL_SPEC[kind];
  const g = source.clone();
  g.scale(spec.scale, spec.scale, spec.scale);
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  g.computeBoundingBox();
  const box = g.boundingBox!, H = box.max.y, L = box.max.z - box.min.z, back = box.min.z;
  const pos = g.getAttribute('position') as THREE.BufferAttribute, n = pos.count;
  const P = (i: number) => new THREE.Vector3().fromBufferAttribute(pos, i);

  // Its feet: what's on the ground, in groups along it (front and hind; tails dragging left out:
  // too few), each side its own.
  const low: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) if (pos.getY(i) < 0.06 * H) low.push(P(i));
  low.sort((a, b) => a.z - b.z);
  const groups: THREE.Vector3[][] = [];
  for (const v of low) {
    const last = groups.at(-1);
    if (last && v.z - last.at(-1)!.z < 0.08 * L) last.push(v);
    else groups.push([v]);
  }
  const big = groups.filter((gr) => gr.length >= 10);
  if (!big.length) throw new Error(`${kind}: no feet`);
  // (Hopping: its feet are the most on the ground; its tail's tip touches too.)
  const most = big.reduce((a, b) => (b.length > a.length ? b : a));
  const sets = spec.plan === 'hop' ? { hind: most } : { front: big.at(-1)!, hind: big.length > 1 ? big.at(-2)! : big[0]! };
  const feet = new Map<Leg, THREE.Vector3>();
  for (const [end, verts] of Object.entries(sets) as [string, THREE.Vector3[]][]) {
    for (const side of ['L', 'R'] as const) {
      // (Its left is +x: it faces +z.)
      const mine = verts.filter((v) => (side === 'L' ? v.x > 0 : v.x <= 0));
      const c = mine.reduce((s, v) => s.add(v), new THREE.Vector3()).divideScalar(Math.max(1, mine.length));
      feet.set(`${end}${side}` as Leg, c.setY(0));
    }
  }
  const legs = [...feet.keys()];
  /** A leg's width (m): how far its foot's vertices spread from its middle. */
  const footR = Math.max(0.02 * L, ...legs.map((l) => Math.max(...low.filter((v) => v.distanceTo(feet.get(l)!) < 0.12 * L).map((v) => Math.hypot(v.x - feet.get(l)!.x, v.z - feet.get(l)!.z)))));
  // The belly about each pair of legs (the lowest of the body there, not over a leg): the legs' top.
  const belly = (end: 'front' | 'hind') => {
    const f = feet.get(`${end}L`)!;
    let lo = Infinity;
    for (let i = 0; i < n; i++) {
      const y = pos.getY(i), x = pos.getX(i), z = pos.getZ(i);
      const overLeg = legs.some((l) => Math.hypot(x - feet.get(l)!.x, z - feet.get(l)!.z) < footR * 1.6);
      if (!overLeg && Math.abs(z - f.z) < 0.15 * L && y > 0.08 * H) lo = Math.min(lo, y);
    }
    return Number.isFinite(lo) ? lo : 0.5 * H;
  };
  const tops: Record<string, number> = { hind: belly('hind') };
  if (spec.plan === 'four') tops.front = belly('front');

  const pivots = new Map<BoneName, THREE.Vector3>();
  pivots.set('body', new THREE.Vector3(0, tops.hind!, 0));
  for (const l of legs) {
    const top = tops[l.startsWith('front') ? 'front' : 'hind']!, f = feet.get(l)!;
    // (The hip and shoulder inside the body, a little above the belly; the knee halfway down, the hock higher.)
    pivots.set(`${l}Upper`, new THREE.Vector3(f.x, top + 0.08 * H, f.z));
    pivots.set(`${l}Lower`, new THREE.Vector3(f.x, top * (l.startsWith('front') ? 0.5 : 0.62), f.z));
    // (The foot from just above it: a hoof and its pastern, a paw.)
    pivots.set(`${l}Foot`, new THREE.Vector3(f.x, Math.max(0.04 * H, 0.12 * top), f.z));
  }
  const neckZ = back + spec.neck * L, tailZ = back + spec.tail * L;
  // The neck turns where it starts, in the middle of the body there (between its chest and its
  // top); the head two thirds of the way from there to the tip of its nose.
  let neckLo = Infinity, neckHi = 0;
  const chest = tops.front ?? tops.hind!;
  for (let i = 0; i < n; i++)
    if (Math.abs(pos.getZ(i) - neckZ) < 0.05 * L && pos.getY(i) > chest) (neckLo = Math.min(neckLo, pos.getY(i))), (neckHi = Math.max(neckHi, pos.getY(i)));
  // (Low in the chest: a neck bends from well down in it.)
  const withers = new THREE.Vector3(0, Number.isFinite(neckLo) ? neckLo + 0.35 * (neckHi - neckLo) : 0.7 * H, neckZ);
  const nose = new THREE.Vector3(0, 0, -Infinity);
  for (let i = 0; i < n; i++) if (pos.getY(i) > 0.3 * H && pos.getZ(i) > nose.z) nose.set(0, pos.getY(i), pos.getZ(i));
  const along = nose.clone().sub(withers);
  pivots.set('neck', withers);
  pivots.set('head', withers.clone().addScaledVector(along, 0.66));
  let tailY = 0;
  for (let i = 0; i < n; i++) if (Math.abs(pos.getZ(i) - tailZ) < 0.06 * L) tailY = Math.max(tailY, pos.getY(i));
  pivots.set('tail', new THREE.Vector3(0, tailY * 0.9, tailZ));

  // Each vertex's bones: a leg's under the belly near its foot (the upper part above the knee, the
  // lower below, blended between), the head's ahead of the neck, the tail's behind its start.
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4);
  const index = (b: BoneName) => BONES.indexOf(b);
  for (let i = 0; i < n; i++) {
    const v = P(i), w = new Map<BoneName, number>();
    let rest = 1;
    // The tail first (behind where it starts, near the middle: one hanging behind the thighs is the tail's, not theirs).
    const sideX = Math.abs(feet.get(legs.find((l) => l.startsWith('hind'))!)!.x);
    const tail = (1 - smooth(tailZ - 0.06 * L, tailZ + 0.02 * L, v.z)) * (1 - smooth(0.45 * sideX, 0.75 * sideX, Math.abs(v.x)));
    if (tail > 0) (w.set('tail', tail), (rest -= tail));
    // Legs.
    let best: Leg | null = null, bestD = Infinity;
    for (const l of legs) {
      const f = feet.get(l)!, d = Math.hypot(v.x - f.x, v.z - f.z);
      if (d < bestD) (bestD = d), (best = l);
    }
    if (best) {
      const top = pivots.get(`${best}Upper`)!.y - 0.08 * H, knee = pivots.get(`${best}Lower`)!.y;
      const near = 1 - smooth(footR * 1.3, footR * 2.6, bestD);
      // (Into the body over a hand's breadth: the skin between stretches a little each way, not all at once.)
      const leg = rest * near * (1 - smooth(top - 0.12 * H, top + 0.02 * H, v.y));
      if (leg > 0) {
        const fetlock = pivots.get(`${best}Foot`)!.y;
        const lower = 1 - smooth(knee - 0.05 * H, knee + 0.05 * H, v.y), foot = 1 - smooth(fetlock - 0.015 * H, fetlock + 0.015 * H, v.y);
        w.set(`${best}Foot`, leg * foot);
        w.set(`${best}Lower`, leg * lower * (1 - foot));
        w.set(`${best}Upper`, leg * (1 - lower));
        rest -= leg;
      }
    }
    // The neck and head: how far along from the withers to the nose (above the chest; not the legs' parts).
    const t = v.clone().sub(withers).dot(along) / along.lengthSq();
    const neck = rest * smooth(-0.05, 0.15, t) * smooth(chest - 0.02 * H, chest + 0.06 * H, v.y);
    if (neck > 0) {
      const head = smooth(0.58, 0.72, t);
      w.set('head', neck * head);
      w.set('neck', neck * (1 - head));
      rest -= neck;
    }
    w.set('body', Math.max(0, rest));
    const top4 = [...w.entries()].filter(([, x]) => x > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top4.reduce((s, [, x]) => s + x, 0);
    top4.forEach(([b, x], k) => {
      skinIndex[i * 4 + k] = index(b);
      skinWeight[i * 4 + k] = x / sum;
    });
  }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  // Faceted, lit from above (as the figures are: baked in, the material's colour times it).
  g.computeVertexNormals();
  const nrm = g.getAttribute('normal'), col = new Float32Array(n * 3), LIGHT = new THREE.Vector3(0.4, 0.8, 0.45).normalize(), nv = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    nv.fromBufferAttribute(nrm, i);
    const s = 0.55 + 0.45 * Math.max(0, nv.dot(LIGHT)) + 0.08 * Math.max(0, nv.y);
    col.set([s, s, s], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();

  // (To its foot's middle: the hoof or paw, low, near the foot.)
  const reach = new Map<Leg, number>();
  for (const l of legs) {
    const f = feet.get(l)!, pts: number[] = [];
    for (let i = 0; i < n; i++) if (pos.getY(i) < 0.08 * H && Math.hypot(pos.getX(i) - f.x, pos.getZ(i) - f.z) < footR * 1.5) pts.push(pos.getY(i));
    reach.set(l, pivots.get(`${l}Upper`)!.y - (pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : 0));
  }
  const legLength = Math.min(...reach.values());
  const model: AnimalModel = { kind, geometry: g, pivots, legs, reach, legLength, graze: 0, stretch: 1, height: H, length: L };
  Object.assign(model, grazing(model));
  return model;
}

/** How much more the head tucks down than the neck, grazing; how far down the neck goes at most (radians). */
const TUCK = 0.4;
const NECK_DOWN = 1.15;
/**
 * How far down (radians) the neck turns, grazing, for the head's lowest point to come to the ground
 * (the head tucking down TUCK as much again), and if it can't get there, how much longer it
 * stretches (times, along its length) for it to.
 */
function grazing(model: AnimalModel): { graze: number; stretch: number } {
  const pos = model.geometry.getAttribute('position'), si = model.geometry.getAttribute('skinIndex'), sw = model.geometry.getAttribute('skinWeight');
  const neck = model.pivots.get('neck')!, poll = model.pivots.get('head')!, headI = BONES.indexOf('head');
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === headI && sw.getComponent(i, k) > 0.9) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i));
  if (!pts.length) return { graze: 0, stretch: 1 };
  const x = new THREE.Vector3(1, 0, 0);
  // (As the bones do it: the head tucked on the neck, the neck stretched along z, its own way, then turned down.)
  const lowest = (a: number, s: number) => {
    const stretch = new THREE.Vector3(1, 1, s);
    return Math.min(...pts.map((p) => p.clone().sub(poll).applyAxisAngle(x, a * TUCK).add(poll).sub(neck).multiply(stretch).applyAxisAngle(x, a).add(neck).y));
  };
  const there = 0.02 * model.height;
  const search = (lo: number, hi: number, low: (v: number) => number) => {
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (low(mid) > there) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  if (lowest(NECK_DOWN, 1) <= there) return { graze: search(0, NECK_DOWN, (a) => lowest(a, 1)), stretch: 1 };
  return { graze: NECK_DOWN, stretch: Math.min(1.8, search(1, 1.8, (s) => lowest(NECK_DOWN, s))) };
}

/** What it's doing, to pose it. */
export interface AnimalState {
  /** How fast it's going (m/s) and how far it's gone (m, all told: its feet keep time with it). */
  speed: number;
  distance: number;
  /** How far its head's down (0..1: grazing) and time (s, for the idle movements). */
  graze: number;
  time: number;
}

/** A gait: how much of a stride each foot's down, its legs' swing (radians each way), and when (of the stride) each foot comes down. */
interface Gait {
  down: number;
  swing: number;
  phase: Record<Leg, number>;
}
// Walking: a foot at a time (hind, front, the other hind, front); trotting: diagonal pairs together.
const WALK: Gait = { down: 0.65, swing: 0.3, phase: { hindL: 0, frontL: 0.25, hindR: 0.5, frontR: 0.75 } };
const TROT: Gait = { down: 0.45, swing: 0.42, phase: { hindL: 0, frontR: 0, hindR: 0.5, frontL: 0.5 } };
const HOP: Gait = { down: 0.35, swing: 0.5, phase: { hindL: 0, hindR: 0, frontL: 0, frontR: 0 } };

/** Strides a second, at most. */
export const MAX_STRIDES = 8;

/** How far a stride goes (m): the feet down go back as far as the body goes forward (the shortest leg swinging as far as the gait says; the rest, as far back on the ground, a little less). */
export function strideOf(model: AnimalModel, gait: Gait): number {
  return (2 * model.legLength * Math.sin(gait.swing)) / gait.down;
}
/** How far (radians, each way) a leg swings for its foot to go as far as the shortest one's. */
function swingOf(model: AnimalModel, gait: Gait, leg: Leg): number {
  return Math.asin(Math.min(1, (model.legLength * Math.sin(gait.swing)) / model.reach.get(leg)!));
}

/** A posed animal: its own bones over its kind's model. */
export class AnimalFigure {
  readonly root = new THREE.Group();
  readonly mesh: THREE.SkinnedMesh;
  readonly material: THREE.MeshBasicMaterial;
  private readonly bones = new Map<BoneName, THREE.Bone>();
  /** How much it's trotting (0..1: blended as it speeds up), for its speed. */
  private trot = 0;

  constructor(readonly model: AnimalModel) {
    const spec = ANIMAL_SPEC[model.kind];
    this.material = new THREE.MeshBasicMaterial({ vertexColors: true, color: spec.color });
    const body = new THREE.Bone();
    body.position.copy(model.pivots.get('body')!);
    this.bones.set('body', body);
    for (const b of BONES) {
      if (b === 'body') continue;
      const bone = new THREE.Bone(), at = model.pivots.get(b);
      bone.name = b;
      // (A leg's foot on its lower part, that on its upper; the head on the neck; the rest on the body. Bones the model hasn't (a hopper's front legs) sit at the body's.)
      const parentName: BoneName = b.endsWith('Lower') ? (b.replace('Lower', 'Upper') as BoneName) : b.endsWith('Foot') ? (b.replace('Foot', 'Lower') as BoneName) : b === 'head' ? 'neck' : 'body';
      const parent = this.bones.get(parentName)!, parentAt = model.pivots.get(parentName);
      if (at) bone.position.copy(at).sub(parentAt ?? new THREE.Vector3());
      parent.add(bone);
      this.bones.set(b, bone);
    }
    this.mesh = new THREE.SkinnedMesh(model.geometry, this.material);
    this.mesh.add(body);
    body.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(BONES.map((b) => this.bones.get(b)!)));
    this.mesh.frustumCulled = false;
    this.root.add(this.mesh);
  }

  /** The stride it's going at `speed` (m), blending walking into trotting. */
  private gaitFor(speed: number): { gait: Gait; trot: number } {
    const spec = ANIMAL_SPEC[this.model.kind];
    if (spec.plan === 'hop') return { gait: HOP, trot: 1 };
    const trot = smooth(spec.walk * 1.2, spec.trot * 0.8, speed);
    return { gait: trot > 0.5 ? TROT : WALK, trot };
  }

  pose(s: AnimalState): void {
    const m = this.model, b = this.bones;
    const pivotBody = m.pivots.get('body')!;
    for (const bone of b.values()) bone.rotation.set(0, 0, 0);
    b.get('neck')!.scale.set(1, 1, 1);
    b.get('body')!.position.copy(pivotBody);
    const moving = smooth(0.05, 0.3, s.speed);
    const { gait, trot } = this.gaitFor(s.speed);
    this.trot += (trot - this.trot) * 0.1;
    // (Little legs, fast: no more than so many strides a second, the feet slipping a little beyond.)
    const stride = Math.max(strideOf(m, gait), s.speed / MAX_STRIDES);
    // Where it is in its stride (0..1), by how far it's gone: each foot down goes back with the ground.
    const cycle = (((s.distance / stride) % 1) + 1) % 1;
    const hop = ANIMAL_SPEC[m.kind].plan === 'hop';
    let lift = 0;
    /** How far the hips (hind) and shoulders (front) come down to keep the feet down on the ground (m): a slanted leg's shorter. */
    const drop = { front: Infinity, hind: Infinity }, clear = { front: Infinity, hind: Infinity };
    for (const leg of m.legs) {
      const u = (((cycle - gait.phase[leg]) % 1) + 1) % 1, swing = swingOf(m, gait, leg);
      let fwd: number, fold: number;
      if (u < gait.down) {
        fwd = swing * (1 - (2 * u) / gait.down);
        fold = 0;
        // (The least of the feet down: one more slanted than another floats a little, rather than sinking.)
        const end = leg.startsWith('front') ? 'front' : 'hind', l = m.reach.get(leg)!;
        drop[end] = Math.min(drop[end], l * (1 - Math.cos(fwd * moving)));
      } else {
        const f = (u - gait.down) / (1 - gait.down);
        fwd = -swing + 2 * swing * (1 - Math.cos(Math.PI * f)) / 2;
        // (Folding up at once, off the ground, then out straight to come down.)
        // (A front knee folds well up; a hock less: a hind leg doesn't kick out back.)
        fold = (hop ? 0.9 : leg.startsWith('front') ? 1 : 0.7) * Math.sin(Math.PI * Math.pow(f, 0.6));
        // (The body's not to come down so far this foot touches the ground before it lands: how high
        // it'd be (each part of the leg as slanted as it is to the ground), less a little to clear it.)
        const end = leg.startsWith('front') ? 'front' : 'hind';
        const upper = m.pivots.get(`${leg}Upper`)!.y - m.pivots.get(`${leg}Lower`)!.y, lower = m.pivots.get(`${leg}Lower`)!.y - m.pivots.get(`${leg}Foot`)!.y;
        const high = upper * (1 - Math.cos(fwd * moving)) + lower * (1 - Math.cos((fold - fwd) * moving));
        clear[end] = Math.min(clear[end], high - 0.04 * m.reach.get(leg)! * Math.sin(Math.PI * f) * moving);
      }
      // (It faces +z: turning a leg about x by -a puts its foot forward; the lower part folds back, +.)
      b.get(`${leg}Upper`)!.rotation.x = -fwd * moving;
      b.get(`${leg}Lower`)!.rotation.x = fold * moving;
      // (The foot level with the ground, down or lifted: it turns back as far as the leg above has.)
      b.get(`${leg}Foot`)!.rotation.x = (fwd - fold) * moving;
      if (hop && u >= gait.down) lift = Math.sin((Math.PI * (u - gait.down)) / (1 - gait.down));
    }
    const body = b.get('body')!;
    if (hop) {
      // Up into the air and down again, tail up to balance, leaning forward as it goes (about its
      // middle: the hips held where they'd be), down as far as its feet need on the ground.
      const h = Math.min(Number.isFinite(drop.hind) ? drop.hind : 0, clear.hind), tip = Math.tan(0.15 * moving);
      body.rotation.x = Math.atan(tip);
      body.position.y += lift * moving * Math.min(0.5, 0.12 * s.speed) * m.legLength - (h - m.pivots.get('hindLUpper')!.z * tip);
      b.get('tail')!.rotation.x = -0.3 * lift * moving;
    } else {
      // Down (front, back, tipping) as far as the feet down need, the head nodding with the steps.
      // (A foot down at the end of its step floats a little rather than one swinging forward dragging.)
      const f = Math.min(Number.isFinite(drop.front) ? drop.front : 0, clear.front), h = Math.min(Number.isFinite(drop.hind) ? drop.hind : 0, clear.hind);
      // (Turning about the body's middle, z 0: the shoulders, ahead of it, go down as the hips come up.)
      const front = m.pivots.get('frontLUpper')!.z, hind = m.pivots.get('hindLUpper')!.z;
      const tip = (f - h) / (front - hind);
      body.rotation.x = Math.atan(tip);
      body.position.y -= h - hind * tip;
      b.get('tail')!.rotation.y = 0.15 * Math.sin(2 * Math.PI * cycle) * moving + 0.1 * Math.sin(s.time * 1.3) * (1 - moving);
    }
    // (The legs hang from the body: as it tips, they turn back as far, to be as slanted to the ground as said.)
    for (const leg of m.legs) b.get(`${leg}Upper`)!.rotation.x -= body.rotation.x;
    const neck = b.get('neck')!;
    neck.rotation.x = s.graze * m.graze + (hop ? 0 : 0.05 * Math.sin(4 * Math.PI * cycle) * moving);
    neck.scale.set(1, 1, 1 + (m.stretch - 1) * s.graze);
    const head = b.get('head')!;
    head.rotation.x = s.graze * m.graze * TUCK;
    // Looking about now and then, standing.
    head.rotation.y = 0.25 * Math.sin(s.time * 0.37) * Math.sin(s.time * 0.11) * (1 - moving) * (1 - s.graze);
  }

  dispose(): void {
    this.material.dispose();
    this.mesh.skeleton.dispose();
  }
}

let loading: Promise<Map<AnimalKind, AnimalModel>> | null = null;
/** The animals' models, loaded (the file, the loader: only once something wants them) and rigged once. */
export function animalModels(): Promise<Map<AnimalKind, AnimalModel>> {
  loading ??= (async () => {
    const [{ FBXLoader }, { default: url }] = await Promise.all([import('three/addons/loaders/FBXLoader.js'), import('./models/animals.fbx?url')]);
    const data = await (await fetch(url)).arrayBuffer();
    return rigAll(new FBXLoader().parse(data, ''));
  })();
  return loading;
}

/** Every kind rigged, from the loaded file. */
export function rigAll(file: THREE.Object3D): Map<AnimalKind, AnimalModel> {
  const meshes = animalMeshes(file), out = new Map<AnimalKind, AnimalModel>();
  for (const kind of ANIMAL_KINDS) {
    const g = meshes.get(ANIMAL_SPEC[kind].mesh);
    if (g) out.set(kind, rigAnimal(kind, g));
  }
  return out;
}
