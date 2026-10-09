import * as THREE from 'three';
import { UNITS_PER_METER, type TrackPoint } from '@super-vox/shared';

/**
 * Laid track as it's drawn (see the shared rail.ts): two steel rails at standard gauge on wooden
 * sleepers, along the track's points (on its bed: the rails' foot at each point's height), in
 * pieces of SECTION_M or so (each its own mesh: those out of sight aren't drawn). Flat-shaded
 * by vertex colour, lit from above as the figures are; metres.
 */
export const GAUGE_M = 1.435;
const RAIL = { w: 0.07, h: 0.14 };
const SLEEPER = { w: 2.5, h: 0.14, d: 0.24, every: 0.6 };
const SECTION_M = 64;
const STEEL: [number, number, number] = [0.42, 0.42, 0.45];
const TIMBER: [number, number, number] = [0.33, 0.24, 0.17];
const LIGHT = new THREE.Vector3(0.35, 1, -0.5).normalize();

/** One section of track: its points (metres, in order). */
function sectionGeometry(pts: readonly { x: number; y: number; z: number; heading: number; s: number }[]): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [];
  /** A box: its corners, from a centre, along (f), across (r) and up, half-sizes. */
  const box = (c: THREE.Vector3, f: THREE.Vector3, r: THREE.Vector3, half: [number, number, number], rgb: [number, number, number]) => {
    const up = new THREE.Vector3(0, 1, 0);
    const corner = (a: number, b: number, h: number) => c.clone().addScaledVector(r, a * half[0]).addScaledVector(up, h * half[1]).addScaledVector(f, b * half[2]);
    const faces: [number, number, number][][] = [
      [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], // top
      [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]], // bottom
      [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]], // right
      [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], // left
      [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]], // ahead
      [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], // behind
    ];
    for (const face of faces) {
      // (Corners as [across, along, up]: the box's own.)
      let v = face.map(([a, b, h]) => corner(a, b, h));
      let n = new THREE.Vector3().subVectors(v[1]!, v[0]!).cross(new THREE.Vector3().subVectors(v[2]!, v[0]!)).normalize();
      // (Facing out, from the box's middle: else turned round.)
      const mid = v.reduce((m, p) => m.add(p), new THREE.Vector3()).divideScalar(4);
      if (n.dot(mid.sub(c)) < 0) {
        v = [...v].reverse();
        n = n.negate();
      }
      const shade = 0.55 + 0.45 * Math.max(0, n.dot(LIGHT)) + 0.08 * Math.max(0, n.y);
      for (const k of [0, 1, 2, 0, 2, 3]) {
        pos.push(v[k]!.x, v[k]!.y, v[k]!.z);
        col.push(rgb[0] * shade, rgb[1] * shade, rgb[2] * shade);
      }
    }
  };
  const along = (h: number) => new THREE.Vector3(-Math.sin(h), 0, -Math.cos(h));
  const across = (h: number) => new THREE.Vector3(Math.cos(h), 0, -Math.sin(h));
  // Rails: a length between each two points, each side.
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const mid = new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2 + SLEEPER.h + RAIL.h / 2, (a.z + b.z) / 2);
    const f = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z), len = f.length();
    if (len < 1e-6) continue;
    f.divideScalar(len);
    const r = new THREE.Vector3(f.z, 0, -f.x).normalize().negate();
    for (const side of [-1, 1]) box(mid.clone().addScaledVector(r, (side * GAUGE_M) / 2), f, r, [RAIL.w / 2, RAIL.h / 2, len / 2 + 0.01], STEEL);
  }
  // Sleepers: every so far along.
  const first = Math.ceil(pts[0]!.s / SLEEPER.every) * SLEEPER.every;
  for (let s = first, i = 1; s <= pts.at(-1)!.s; s += SLEEPER.every) {
    while (i < pts.length - 1 && pts[i]!.s < s) i++;
    const a = pts[i - 1]!, b = pts[i]!, t = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
    const h = a.heading + Math.atan2(Math.sin(b.heading - a.heading), Math.cos(b.heading - a.heading)) * t;
    const c = new THREE.Vector3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t + SLEEPER.h / 2, a.z + (b.z - a.z) * t);
    box(c, along(h), across(h), [SLEEPER.w / 2, SLEEPER.h / 2, SLEEPER.d / 2], TIMBER);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

/** A laid track's model (its points: units, as laid), in sections; `material` shared (its colour: how lit). */
export function trackModel(points: readonly TrackPoint[], material: THREE.Material): THREE.Group {
  const M = UNITS_PER_METER, group = new THREE.Group();
  const pts = points.map((p) => ({ x: p.x / M, y: p.y / M, z: p.z / M, heading: p.heading, s: p.s / M }));
  for (let start = 0; start < pts.length - 1; ) {
    const end = Math.min(pts.length - 1, start + Math.round(SECTION_M));
    group.add(new THREE.Mesh(sectionGeometry(pts.slice(start, end + 1)), material));
    start = end;
  }
  return group;
}
