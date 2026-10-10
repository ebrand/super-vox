import * as THREE from 'three';
import { CAR_SPECS, type CarKind } from '@super-vox/shared';
import { GAUGE_M } from './trackModel.js';

/**
 * Rolling stock as it's drawn: a steam engine, a flatbed and a passenger car, made of boxes and
 * cylinders, flat-shaded by vertex colour (lit from above as the figures are). Metres, in the car's
 * own frame: its front toward -z (as figures face), x across, y up from the top of the rails, its
 * middle between its bogies at the origin.
 */

export type Rgb = [number, number, number];
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
const SEAT: Rgb = [0.13, 0.27, 0.32];
const CRATE: Rgb = [0.6, 0.44, 0.25];
const DARK_CRATE: Rgb = [0.3, 0.2, 0.1];

/** How tall each is (m, over the rails) and how wide: for aiming at it. */
export const CAR_SIZE: Record<CarKind, { width: number; height: number }> = {
  engine: { width: 2.9, height: 4.4 },
  flatbed: { width: 2.7, height: 3.6 },
  passenger: { width: 2.9, height: 4.3 },
};

export class Builder {
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

/** A passenger car's seats: four rows a side, facing ahead (along -z). */
const SEAT_ROWS = [-3.9, -1.3, 1.3, 3.9];
const SEAT_X = 0.7, SEAT_Y = 1.75;

function passenger(): THREE.BufferGeometry {
  const L = CAR_SPECS.passenger.length, B = CAR_SPECS.passenger.bogie, b = new Builder();
  b.bogie(-B).bogie(B).box(0, 0.95, 0, 2.3, 0.3, L - 0.6, BLACK).ends(L, 0.95);
  // Its body: walls of panels (seen from inside too: each its own box) round open windows, a floor, its ends, a roof.
  const end = (L - 0.6) / 2, floor = 1.3, sill = 2.45, head = 3.25, eaves = 3.78;
  b.box(0, floor - 0.08, 0, 2.7, 0.16, L - 0.6, TIMBER);
  const windows: number[] = [];
  for (let z = -(L - 2.4) / 2; z <= (L - 2.4) / 2 + 1e-6; z += 1.3) windows.push(z);
  for (const side of [-1, 1]) {
    const x = side * 1.36;
    b.box(x, (floor + sill) / 2, 0, 0.08, sill - floor, L - 0.6, MAROON).box(x, (head + eaves) / 2, 0, 0.08, eaves - head, L - 0.6, MAROON);
    // (Between the windows: pillars; and from the end windows to the ends.)
    const edges = [-end, ...windows.flatMap((z) => [z - 0.45, z + 0.45]), end];
    for (let i = 0; i < edges.length; i += 2) if (edges[i + 1]! - edges[i]! > 1e-6) b.box(x, (sill + head) / 2, (edges[i]! + edges[i + 1]!) / 2, 0.08, head - sill, edges[i + 1]! - edges[i]!, MAROON);
    b.box(side * 1.405, 2.25, 0, 0.02, 0.18, L - 0.7, CREAM);
  }
  for (const s of [-1, 1]) {
    b.box(0, (floor + eaves) / 2, s * (end - 0.04), 2.7, eaves - floor, 0.08, MAROON);
    b.box(0, 2.3, s * (end + 0.01), 1.0, 2.0, 0.02, IRON);
  }
  b.box(0, 3.85, 0, 2.95, 0.2, L - 0.4, ROOF).box(0, 4.05, 0, 2.3, 0.2, L - 0.8, ROOF);
  // Benches, two a row.
  for (const z of SEAT_ROWS)
    for (const side of [-1, 1]) {
      b.box(side * SEAT_X, SEAT_Y - 0.2, z, 1.0, 0.5, 0.6, BLACK);
      b.box(side * SEAT_X, SEAT_Y + 0.08, z, 1.0, 0.12, 0.62, SEAT);
      b.box(side * SEAT_X, SEAT_Y + 0.34, z + 0.33, 1.0, 0.56, 0.12, SEAT);
    }
  return b.geometry();
}

/** Where each seat's sitter's eye is (m, the car's frame), in seat order (row by row, left then right). */
export const SEAT_EYES: THREE.Vector3[] = SEAT_ROWS.flatMap((z) => [-1, 1].map((side) => new THREE.Vector3(side * SEAT_X, SEAT_Y + 0.8, z + 0.05)));

const CRATES = new Map<number, THREE.BufferGeometry>();
/** A flatbed's crates, `n` of them (two by six on its deck, then a second layer: see FLATBED_CRATES). */
export function crateGeometry(n: number): THREE.BufferGeometry {
  let g = CRATES.get(n);
  if (g) return g;
  const b = new Builder(), deck = 1.34, size = 1.1;
  for (let i = 0; i < n; i++) {
    const layer = Math.floor(i / 12), j = i % 12, x = (j % 2 ? 1 : -1) * 0.62, z = -3.125 + Math.floor(j / 2) * 1.25, y = deck + size / 2 + layer * size;
    // (Each a little different: boards of a slightly different wood.)
    const k = 0.9 + ((i * 37) % 7) * 0.03;
    b.box(x, y, z, size, size - 0.02, 1.15, [CRATE[0] * k, CRATE[1] * k, CRATE[2] * k]);
    b.box(x, y, z, size + 0.02, 0.12, 1.17, DARK_CRATE).box(x, y + size / 2 - 0.08, z, size + 0.02, 0.06, 1.17, DARK_CRATE);
  }
  CRATES.set(n, (g = b.geometry()));
  return g;
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
