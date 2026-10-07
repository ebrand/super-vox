import * as THREE from 'three';
import { UNITS_PER_METER, boatHull, deltaX, designById, designVoxels, hullBox, type Boat, type Hull, type WorldConfig } from '@super-vox/shared';
import { entityBrightness } from './entities.js';
import { materialColor } from './materials.js';

/** A box's faces, lit from above as blocks are (+x, -x, +y, -y, +z, -z: BoxGeometry's order). */
const FACE_SHADE = [0.8, 0.8, 1, 0.5, 0.65, 0.65];
/** How quickly others' boats catch up with where they were last said to be (per second). */
const FOLLOW = 10;

interface Shown {
  boat: Boat;
  group: THREE.Group;
  material: THREE.MeshBasicMaterial;
  hull: Hull;
  /** Where it's drawn (units), easing toward the boat's. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  brightness: number;
  litAt: number;
}

/**
 * The world's boats (see Boat), each drawn as its design (a cube per voxel, faces shaded as
 * blocks are): its arrow (the design's front, +z) is its bow. Others' boats ease to where they
 * were last said to be; the one we're in is put where we steer it (see setOwn).
 */
export class BoatView {
  private readonly shown = new Map<number, Shown>();
  private readonly cube: THREE.BufferGeometry;
  /** The boat we're in: drawn where we say. */
  private own: { id: number; x: number; y: number; z: number; yaw: number } | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: WorldConfig,
    private readonly cameraX: () => number,
    private readonly light: (x: number, y: number, z: number) => { sky: number; block: number } | null = () => null,
    private readonly daylight: () => number = () => 1,
  ) {
    this.cube = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
    const shade = new Float32Array(this.cube.getAttribute('position').count * 3);
    for (let i = 0; i < shade.length / 3; i++) shade.fill(FACE_SHADE[Math.floor(i / 6)]!, i * 3, i * 3 + 3);
    this.cube.setAttribute('color', new THREE.BufferAttribute(shade, 3));
  }

  /** The boats as they are now (from the server): new ones appear, gone ones go. */
  setBoats(list: readonly Boat[]): void {
    const seen = new Set<number>();
    for (const b of list) {
      seen.add(b.id);
      const s = this.shown.get(b.id);
      if (s && s.boat.design === b.design) s.boat = b;
      else {
        if (s) this.drop(b.id);
        const made = this.make(b);
        if (made) this.shown.set(b.id, made);
      }
    }
    for (const id of [...this.shown.keys()]) if (!seen.has(id)) this.drop(id);
  }

  /** A boat someone's in has moved. */
  moved(id: number, x: number, y: number, z: number, yaw: number): void {
    const s = this.shown.get(id);
    if (s) s.boat = { ...s.boat, x, y, z, yaw };
  }

  /** The boat we're in, drawn here (units); null: none. */
  setOwn(own: { id: number; x: number; y: number; z: number; yaw: number } | null): void {
    this.own = own;
  }

  boat(id: number): Boat | undefined {
    return this.shown.get(id)?.boat;
  }

  hull(id: number): Hull | undefined {
    return this.shown.get(id)?.hull;
  }

  /** Places them for this frame (`dt`: seconds since the last). */
  frame(dt: number, now = performance.now()): void {
    const camX = this.cameraX(), k = 1 - Math.exp(-FOLLOW * Math.min(dt, 0.25));
    for (const [id, s] of this.shown) {
      const to = this.own?.id === id ? this.own : s.boat;
      // (Ours exactly where we steer it; far off, or a long way from where it's drawn: straight there.)
      const jump = this.own?.id === id || Math.abs(deltaX(this.world, s.x, to.x)) + Math.abs(to.z - s.z) > 8 * UNITS_PER_METER;
      const f = jump ? 1 : k;
      s.x += deltaX(this.world, s.x, to.x) * f;
      s.y += (to.y - s.y) * f;
      s.z += (to.z - s.z) * f;
      s.yaw += (Math.atan2(Math.sin(to.yaw - s.yaw), Math.cos(to.yaw - s.yaw))) * f;
      const x = camX + deltaX(this.world, camX, s.x);
      s.group.position.set(x / UNITS_PER_METER, s.y / UNITS_PER_METER, s.z / UNITS_PER_METER);
      // (Its bow is the design's front, +z: turned half round to point along -z at yaw 0.)
      s.group.rotation.y = s.yaw + Math.PI;
      if (now - s.litAt > 250) {
        s.litAt = now;
        const l = this.light(s.x, s.y + 8, s.z);
        s.brightness = l ? entityBrightness(l.sky, l.block, this.daylight()) : 1;
        s.material.color.setScalar(s.brightness);
      }
    }
  }

  /** The nearest boat a ray (units) hits within `maxDist` units, and how far along. */
  pick(origin: readonly number[], dir: readonly number[], maxDist: number): { id: number; dist: number } | null {
    const camX = this.cameraX();
    let best: { id: number; dist: number } | null = null;
    for (const [id, s] of this.shown) {
      if (this.own?.id === id) continue;
      const x = camX + deltaX(this.world, camX, s.x);
      const box = hullBox(s.hull, x, s.z, s.yaw, s.y, s.y + s.hull.height);
      const d = rayAabb(origin, dir, box.min, box.max);
      if (d !== null && d <= maxDist && (!best || d < best.dist)) best = { id, dist: d };
    }
    return best;
  }

  get count(): number {
    return this.shown.size;
  }

  dispose(): void {
    for (const id of [...this.shown.keys()]) this.drop(id);
    this.cube.dispose();
  }

  private make(b: Boat): Shown | null {
    const design = designById(b.design);
    if (!design) return null;
    const hull = boatHull(design);
    const voxels = designVoxels(design, 0, 'n');
    const material = new THREE.MeshBasicMaterial({ vertexColors: true });
    const mesh = new THREE.InstancedMesh(this.cube, material, Math.max(1, voxels.length));
    const m = new THREE.Matrix4(), c = new THREE.Color();
    const cx = hull.x0 + hull.halfW, cz = hull.z0 + hull.halfL;
    voxels.forEach((v, i) => {
      const s = v.size / UNITS_PER_METER;
      m.makeScale(s, s, s).setPosition((v.x + v.size / 2 - cx) / UNITS_PER_METER, (v.y + v.size / 2 - hull.y0) / UNITS_PER_METER, (v.z + v.size / 2 - cz) / UNITS_PER_METER);
      mesh.setMatrixAt(i, m);
      const [r, g, bl] = materialColor(v.material);
      mesh.setColorAt(i, c.setRGB(r, g, bl, THREE.LinearSRGBColorSpace));
    });
    mesh.count = voxels.length;
    mesh.frustumCulled = false;
    const group = new THREE.Group();
    group.name = `boat ${b.id}`;
    group.add(mesh);
    this.scene.add(group);
    return { boat: b, group, material, hull, x: b.x, y: b.y, z: b.z, yaw: b.yaw, brightness: 1, litAt: -Infinity };
  }

  private drop(id: number): void {
    const s = this.shown.get(id);
    if (!s) return;
    this.scene.remove(s.group);
    s.material.dispose();
    for (const o of s.group.children) if (o instanceof THREE.InstancedMesh) o.dispose();
    this.shown.delete(id);
  }
}

/** Where a ray first meets a box (distance along it), or null if it misses. */
function rayAabb(o: readonly number[], d: readonly number[], min: readonly number[], max: readonly number[]): number | null {
  let t0 = 0, t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    const oa = o[a]!, da = d[a]!;
    if (Math.abs(da) < 1e-12) {
      if (oa < min[a]! || oa > max[a]!) return null;
      continue;
    }
    let ta = (min[a]! - oa) / da, tb = (max[a]! - oa) / da;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}
