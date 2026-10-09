import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ANIMAL_KINDS, ANIMAL_SPEC, AnimalFigure, MAX_STRIDES, rigAll, strideOf, type AnimalKind, type AnimalModel } from './animalRig.js';

(globalThis as { self?: unknown }).self ??= globalThis; // (the loader looks for it)
const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
const data = readFileSync(new URL('./models/animals.fbx', import.meta.url));
const models = rigAll(new FBXLoader().parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, ''));

/** Where its vertices are (m, in the world), posed. */
function skinned(f: AnimalFigure): THREE.Vector3[] {
  f.root.updateMatrixWorld(true);
  f.mesh.skeleton.update();
  const n = f.model.geometry.getAttribute('position').count, out: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) out.push(f.mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(f.mesh.matrixWorld));
  return out;
}
/** The vertices mostly on a bone. */
function onBone(m: AnimalModel, bone: number): number[] {
  const si = m.geometry.getAttribute('skinIndex'), sw = m.geometry.getAttribute('skinWeight'), out: number[] = [];
  for (let i = 0; i < si.count; i++) if (si.getComponent(i, 0) === bone && sw.getComponent(i, 0) > 0.95) out.push(i);
  return out;
}
const BONE = { body: 0, head: 2, frontLFoot: 6, hindLFoot: 12 } as const;
const still = { speed: 0, distance: 0, graze: 0, time: 0 };
const WALK_LIKE = { down: 0.65, swing: 0.3, phase: { hindL: 0, frontL: 0.25, hindR: 0.5, frontR: 0.75 } };
const TROT_LIKE = { down: 0.45, swing: 0.42, phase: { hindL: 0, frontR: 0, hindR: 0.5, frontL: 0.5 } };
const HOP_LIKE = { down: 0.35, swing: 0.5, phase: { hindL: 0, hindR: 0, frontL: 0, frontR: 0 } };

describe('animals', () => {
  it('are all rigged: their size, their legs found, every vertex weighted (weights adding to 1)', () => {
    expect([...models.keys()].sort()).toEqual([...ANIMAL_KINDS].sort());
    for (const [kind, m] of models) {
      expect(m.legs.length, kind).toBe(ANIMAL_SPEC[kind].plan === 'hop' ? 2 : 4);
      const sw = m.geometry.getAttribute('skinWeight');
      for (let i = 0; i < sw.count; i++) expect(sw.getX(i) + sw.getY(i) + sw.getZ(i) + sw.getW(i)).toBeCloseTo(1, 4);
      // Each leg's lower part has vertices of its own (the legs were found).
      expect(onBone(m, ANIMAL_SPEC[kind].plan === 'hop' ? BONE.hindLFoot : BONE.frontLFoot).length, kind).toBeGreaterThan(4);
    }
    const size = (k: AnimalKind) => models.get(k)!.height;
    expect(size('horse')).toBeGreaterThan(2);
    expect(size('cat')).toBeLessThan(0.4);
  });

  it('stand on their feet, and walk and trot without their feet sliding (a foot down stays put)', () => {
    for (const [kind, m] of models) {
      const f = new AnimalFigure(m);
      f.pose(still);
      const rest = skinned(f);
      expect(Math.min(...rest.map((v) => v.y)), kind).toBeCloseTo(0, 2);
      const spec = ANIMAL_SPEC[kind];
      for (const speed of spec.plan === 'hop' ? [spec.trot] : [spec.walk, spec.trot]) {
        // Over a stride and a bit, going forward (+z) as far as it goes: where the left hind foot is.
        const foot = onBone(m, BONE.hindLFoot);
        // (Forty frames a stride, two strides.)
        const gait = speed >= spec.trot * 0.9 ? TROT_LIKE : WALK_LIKE;
        const steps = 80, stride = Math.max(strideOf(m, spec.plan === 'hop' ? HOP_LIKE : gait), speed / MAX_STRIDES) / 40;
        const at: { y: number; z: number }[] = [];
        for (let k = 0; k < steps; k++) {
          const distance = k * stride;
          f.pose({ speed, distance, graze: 0, time: k / 30 });
          f.root.position.z = distance;
          const vs = skinned(f), low = Math.min(...foot.map((i) => vs[i]!.y));
          // (Its foot's middle: as it rolls heel to toe its lowest point moves, the foot not.)
          at.push({ y: low, z: foot.reduce((s, i) => s + vs[i]!.z, 0) / foot.length });
        }
        // Never into the ground (a centimetre or so); while it's on it, it hardly moves: under a tenth of the body's speed.
        expect(Math.min(...at.map((a) => a.y)), `${kind} at ${speed} m/s: into the ground`).toBeGreaterThan(-Math.max(0.01, 0.01 * m.height));
        // (Down: as low as it stands, near enough: not every foot in the file touches y 0.)
        const down = Math.min(...foot.map((i) => rest[i]!.y)) + 0.01 * m.height, slide: number[] = [];
        for (let k = 1; k < at.length; k++) if (at[k]!.y < down && at[k - 1]!.y < down) slide.push(Math.abs(at[k]!.z - at[k - 1]!.z) / stride);
        expect(slide.length, `${kind} ${speed}`).toBeGreaterThan(steps * 0.15);
        // (Unless its legs would go faster than MAX_STRIDES: then they slip, a little, as said.)
        if (strideOf(m, spec.plan === 'hop' ? HOP_LIKE : gait) * MAX_STRIDES < speed) continue;
        slide.sort((a, b) => a - b);
        expect(slide[Math.floor(slide.length / 2)]!, `${kind} at ${speed} m/s`).toBeLessThan(0.1);
      }
    }
  });

  it('graze with the head down to the ground; the back stays where it is as the legs move', () => {
    for (const [kind, m] of models) {
      const f = new AnimalFigure(m);
      if (ANIMAL_SPEC[kind].plan === 'four') {
        f.pose({ ...still, graze: 1 });
        const vs = skinned(f), head = onBone(m, BONE.head);
        expect(Math.min(...head.map((i) => vs[i]!.y)), kind).toBeLessThan(0.06 * m.height);
      }
      // The body's own vertices: moved only by the step's small dip and tip (under a fiftieth of its length; a hop, up off the ground, more).
      if (ANIMAL_SPEC[kind].plan === 'hop') continue;
      f.pose(still);
      const a = skinned(f);
      f.pose({ speed: ANIMAL_SPEC[kind].walk, distance: strideOf(m, WALK_LIKE) * 0.3, graze: 0, time: 0 });
      const b = skinned(f);
      for (const i of onBone(m, BONE.body)) expect(a[i]!.distanceTo(b[i]!), kind).toBeLessThan(0.02 * m.length);
    }
  });
});
