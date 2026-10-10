import * as THREE from 'three';
import { CAR_SPECS, type CarKind } from '@super-vox/shared';
import { GAUGE_M } from './trackModel.js';

/**
 * Rolling stock as it's drawn: a steam engine, a flatbed and a passenger car, made of boxes and
 * cylinders, flat-shaded by vertex colour (lit from above as the figures are). Metres, in the car's
 * own frame: its front toward -z (as figures face), x across, y up from the top of the rails, its
 * middle between its bogies at the origin.
 */

type Rgb = [number, number, number];
const LIGHT = new THREE.Vector3(0.35, 1, -0.5).normalize();
const BLACK: Rgb = [0.06, 0.06, 0.07];
const IRON: Rgb = [0.2, 0.2, 0.22];
const RED: Rgb = [0.55, 0.07, 0.05];
const BRASS: Rgb = [0.62, 0.46, 0.16];
const GREEN: Rgb = [0.08, 0.24, 0.13];
const TIMBER: Rgb = [0.42, 0.29, 0.17];
const MAROON: Rgb = [0.42, 0.08, 0.1];
const CREAM: Rgb = [0.86, 0.8, 0.62];
const ROOF: Rgb = [0.28, 0.28, 0.3];
const GLASS: Rgb = [0.55, 0.62, 0.66];

/** How tall each is (m, over the rails) and how wide: for aiming at it. */
export const CAR_SIZE: Record<CarKind, { width: number; height: number }> = {
  engine: { width: 2.9, height: 4.4 },
  flatbed: { width: 2.7, height: 1.6 },
  passenger: { width: 2.9, height: 4.3 },
};

class Builder {
  readonly pos: number[] = [];
  readonly col: number[] = [];

  private face(v: THREE.Vector3[], rgb: Rgb): void {
    const n = new THREE.Vector3().subVectors(v[1]!, v[0]!).cross(new THREE.Vector3().subVectors(v[2]!, v[0]!)).normalize();
    const shade = 0.55 + 0.45 * Math.max(0, n.dot(LIGHT)) + 0.08 * Math.max(0, n.y);
    for (const k of v.length === 4 ? [0, 1, 2, 0, 2, 3] : [0, 1, 2]) {
      this.pos.push(v[k]!.x, v[k]!.y, v[k]!.z);
      this.col.push(rgb[0] * shade, rgb[1] * shade, rgb[2] * shade);
    }
  }

  /** A box: its middle, and its size (across, up, along). */
  box(x: number, y: number, z: number, w: number, h: number, l: number, rgb: Rgb): this {
    const c = (a: number, b: number, d: number) => new THREE.Vector3(x + (a * w) / 2, y + (b * h) / 2, z + (d * l) / 2);
    const faces: [number, number, number][][] = [
      [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]],
      [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]],
      [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]],
      [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]],
      [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
      [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]],
    ];
    for (const f of faces) this.face(f.map(([a, b, d]) => c(a, b, d)), rgb);
    return this;
  }

  /** A cylinder: its axis ('x' across, 'y' up, 'z' along) through (x, y, z), its radius and length. */
  cylinder(axis: 'x' | 'y' | 'z', x: number, y: number, z: number, r: number, len: number, rgb: Rgb, sides = 12): this {
    const at = (t: number, a: number) => {
      const u = Math.cos(a) * r, v = Math.sin(a) * r;
      return axis === 'x' ? new THREE.Vector3(x + t, y + u, z + v) : axis === 'y' ? new THREE.Vector3(x + u, y + t, z + v) : new THREE.Vector3(x + u, y + v, z + t);
    };
    const h = len / 2;
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
      const quad = [at(-h, a0), at(h, a0), at(h, a1), at(-h, a1)];
      // (Outward: away from the axis.)
      const mid = quad.reduce((m, p) => m.add(p), new THREE.Vector3()).divideScalar(4);
      const centre = axis === 'x' ? new THREE.Vector3(mid.x, y, z) : axis === 'y' ? new THREE.Vector3(x, mid.y, z) : new THREE.Vector3(x, y, mid.z);
      const n = new THREE.Vector3().subVectors(quad[1]!, quad[0]!).cross(new THREE.Vector3().subVectors(quad[2]!, quad[0]!));
      this.face(n.dot(mid.clone().sub(centre)) < 0 ? [...quad].reverse() : quad, rgb);
      // Ends.
      for (const [t, sign] of [[-h, -1], [h, 1]] as const) {
        const tri = [axis === 'x' ? new THREE.Vector3(x + t, y, z) : axis === 'y' ? new THREE.Vector3(x, y + t, z) : new THREE.Vector3(x, y, z + t), at(t, a0), at(t, a1)];
        const tn = new THREE.Vector3().subVectors(tri[1]!, tri[0]!).cross(new THREE.Vector3().subVectors(tri[2]!, tri[0]!));
        const axisDir = axis === 'x' ? new THREE.Vector3(sign, 0, 0) : axis === 'y' ? new THREE.Vector3(0, sign, 0) : new THREE.Vector3(0, 0, sign);
        this.face(tn.dot(axisDir) < 0 ? [tri[0]!, tri[2]!, tri[1]!] : tri, rgb);
      }
    }
    return this;
  }

  /** Wheels on both rails at z (m along), radius r. */
  wheels(z: number, r: number, rgb: Rgb = IRON): this {
    for (const side of [-1, 1]) this.cylinder('x', (side * GAUGE_M) / 2 + side * 0.04, r, z, r, 0.14, rgb, 14);
    return this.cylinder('x', 0, r, z, 0.09, GAUGE_M, BLACK, 6);
  }

  /** A bogie (two axles, 1.8 m apart) at z. */
  bogie(z: number): this {
    this.box(0, 0.55, z, 1.9, 0.3, 2.6, BLACK);
    return this.wheels(z - 0.9, 0.45).wheels(z + 0.9, 0.45);
  }

  /** Buffer beams and buffers at both ends of a car `length` long, at height y. */
  ends(length: number, y: number): this {
    for (const s of [-1, 1]) {
      const z = (s * length) / 2;
      this.box(0, y, z - s * 0.12, 2.6, 0.42, 0.24, RED);
      for (const side of [-0.85, 0.85]) this.cylinder('z', side, y, z - s * 0.02, 0.16, 0.3, IRON, 8);
    }
    return this;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

function engine(): THREE.BufferGeometry {
  const L = CAR_SPECS.engine.length, b = new Builder();
  b.box(0, 1.05, 0, 2.3, 0.4, L - 0.6, BLACK).ends(L, 1.05);
  // Driving wheels (three a side), and a small pair leading.
  for (const z of [-1.7, 0, 1.7]) b.wheels(z + 0.4, 0.8, IRON);
  b.wheels(-3.7, 0.45);
  // The boiler (its smokebox at the front), the chimney and dome, and the cab behind, its bunker last.
  b.cylinder('z', 0, 2.25, -1.6, 0.95, 5.4, GREEN, 16).cylinder('z', 0, 2.25, -4.2, 1.0, 0.9, BLACK, 16);
  b.cylinder('y', 0, 3.55, -4.0, 0.3, 1.0, BLACK, 10).cylinder('y', 0, 3.35, -1.6, 0.4, 0.6, BRASS, 10);
  // The cab: its sides and back to the waist, posts at its corners and its front either side of the boiler, open windows over (to see out of: no glass to look through), a roof.
  const cz = 2.55, cl = 2.4, waist = 2.55;
  for (const side of [-1, 1]) b.box(side * 1.32, (1.25 + waist) / 2, cz, 0.08, waist - 1.25, cl, GREEN);
  b.box(0, (1.25 + waist) / 2, cz + cl / 2 - 0.04, 2.7, waist - 1.25, 0.08, GREEN);
  for (const side of [-1, 1]) for (const end of [-1, 1]) b.box(side * 1.25, (waist + 3.84) / 2, cz + (end * cl) / 2 - end * 0.11, 0.22, 3.84 - waist, 0.22, GREEN);
  for (const side of [-1, 1]) b.box(side * 0.98, (1.25 + 2.85) / 2, cz - cl / 2 + 0.04, 0.74, 2.85 - 1.25, 0.08, GREEN);
  b.box(0, 3.92, cz, 2.95, 0.16, 2.8, ROOF);
  b.box(0, 1.75, 4.25, 2.4, 1.0, 1.1, BLACK);
  return b.geometry();
}

function flatbed(): THREE.BufferGeometry {
  const L = CAR_SPECS.flatbed.length, B = CAR_SPECS.flatbed.bogie, b = new Builder();
  b.bogie(-B).bogie(B).box(0, 0.95, 0, 2.2, 0.3, L - 0.6, BLACK).ends(L, 0.95);
  b.box(0, 1.23, 0, 2.6, 0.22, L - 0.4, TIMBER);
  // Stakes along its sides.
  for (const z of [-3.6, -1.2, 1.2, 3.6]) for (const side of [-1, 1]) b.box(side * 1.25, 1.6, z, 0.1, 0.55, 0.1, BLACK);
  return b.geometry();
}

function passenger(): THREE.BufferGeometry {
  const L = CAR_SPECS.passenger.length, B = CAR_SPECS.passenger.bogie, b = new Builder();
  b.bogie(-B).bogie(B).box(0, 0.95, 0, 2.3, 0.3, L - 0.6, BLACK).ends(L, 0.95);
  b.box(0, 2.45, 0, 2.8, 2.6, L - 0.6, MAROON).box(0, 3.85, 0, 2.95, 0.2, L - 0.4, ROOF).box(0, 4.05, 0, 2.3, 0.2, L - 0.8, ROOF);
  // Windows along both sides, a cream band under them; a door at each end.
  for (let z = -(L - 2.4) / 2; z <= (L - 2.4) / 2 + 1e-6; z += 1.3) for (const side of [-1, 1]) b.box(side * 1.41, 2.85, z, 0.02, 0.8, 0.9, GLASS);
  for (const side of [-1, 1]) b.box(side * 1.405, 2.25, 0, 0.02, 0.18, L - 0.7, CREAM);
  for (const s of [-1, 1]) b.box(0, 2.3, s * (L / 2 - 0.31), 1.0, 2.0, 0.02, IRON);
  return b.geometry();
}

const MADE = new Map<CarKind, THREE.BufferGeometry>();

/** A car's model (made once a kind: the meshes share it). */
export function carGeometry(kind: CarKind): THREE.BufferGeometry {
  let g = MADE.get(kind);
  if (!g) MADE.set(kind, (g = kind === 'engine' ? engine() : kind === 'flatbed' ? flatbed() : passenger()));
  return g;
}

/** Where the driver stands in an engine (m, its frame): in the cab. */
export const CAB_EYE = new THREE.Vector3(0.6, 3.25, 2.9);
