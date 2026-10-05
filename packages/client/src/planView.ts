import * as THREE from 'three';
import type { Plan, PlanElement } from '@super-vox/shared';

/**
 * A plan (see Plan) drawn over the close-up: each element a see-through volume at its planned
 * height, standing on the ground (from a little below its lowest point under it), with dark edges;
 * the one chosen edged in gold. Where trees (or hills) stand in front, it still shows, faintly, and
 * its edges too: a plan laid out in a forest isn't lost in it. Walls go in pieces of at most WALL_PIECE, so they step with the
 * ground as a wall would; towers are round; buildings have a pitched roof along their length.
 */
const WALL_PIECE = 4;
const COLORS = { wall: 0xc9c2b0, cap: 0x8f8572, tower: 0xb8ae98, building: 0xe2d2a8, roof: 0x9c4a3a } as const;
const CHOSEN = 0xffd34d;

/** Shaded by which way each face looks (no lights in the close-up's scene), see-through. */
function planMaterial(color: number, opacity: number, depthTest = true): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, opacity: { value: opacity } },
    transparent: true,
    depthWrite: false,
    depthTest,
    // (Both sides: seen from inside a tower, or under a roof, it's still there.)
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying float vLight;
      void main() {
        vec3 n = normalize(mat3(modelMatrix) * normal);
        vLight = 0.62 + 0.3 * max(dot(n, normalize(vec3(0.4, 0.8, 0.3))), 0.0) + 0.08 * n.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform vec3 color;
      uniform float opacity;
      varying float vLight;
      void main() {
        #include <logdepthbuf_fragment>
        gl_FragColor = vec4(color * vLight, opacity);
        #include <colorspace_fragment>
      }
    `,
  });
}

/** The ground's lowest and highest points (metres) at `points`; 0 where it's unknown. */
function groundSpan(groundAt: (x: number, z: number) => number | null, points: [number, number][]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const [x, z] of points) {
    const g = groundAt(x, z);
    if (g === null) continue;
    lo = Math.min(lo, g);
    hi = Math.max(hi, g);
  }
  return lo === Infinity ? [0, 0] : [lo, hi];
}

/** Meshes (and their edges) for one element, into `out`. */
/**
 * What a design makes of an element it tops: its height, its footprint (m), and (towers) its bottom
 * layer as metre columns over that footprint (see designBase): what's built below it.
 */
export interface PlanCap {
  height: number;
  width: number;
  depth: number;
  base?: { width: number; depth: number; columns: Uint8Array } | null;
}

function elementMeshes(e: PlanElement, groundAt: (x: number, z: number) => number | null, out: THREE.Group, materials: Record<string, THREE.Material>, edgeMaterial: THREE.Material, capped: PlanCap | null): void {
  const cap = capped?.height ?? null;
  const add = (geom: THREE.BufferGeometry, part: 'wall' | 'cap' | 'tower' | 'building' | 'roof') => {
    const mesh = new THREE.Mesh(geom, materials[part]!);
    mesh.renderOrder = 6;
    // (And faintly over everything, in its colour: through trees in front.)
    const ghost = new THREE.Mesh(geom, materials[`${part}Ghost`]!);
    ghost.renderOrder = 5;
    out.add(ghost, mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 30), edgeMaterial);
    edges.renderOrder = 7;
    out.add(edges);
  };
  if (e.kind === 'wall') {
    const dx = e.x1 - e.x0, dz = e.z1 - e.z0, len = Math.hypot(dx, dz), ux = dx / len, uz = dz / len;
    const n = Math.max(1, Math.ceil(len / WALL_PIECE)), piece = len / n, yaw = Math.atan2(dx, dz);
    for (let i = 0; i < n; i++) {
      const a = i * piece, b = a + piece, mid = (a + b) / 2;
      const [lo, hi] = groundSpan(groundAt, [[e.x0 + ux * a, e.z0 + uz * a], [e.x0 + ux * mid, e.z0 + uz * mid], [e.x0 + ux * b, e.z0 + uz * b]]);
      const bottom = lo - 0.5, top = hi + e.height;
      // (The ends a little longer, by half the thickness, so walls meet at corners.)
      const extra = (i === 0 ? e.thickness / 2 : 0) + (i === n - 1 ? e.thickness / 2 : 0), shift = (i === n - 1 ? e.thickness / 4 : 0) - (i === 0 ? e.thickness / 4 : 0);
      // (Made of a design: that's its top, `cap` high, drawn darker; solid wall below it.)
      const capped = cap ? Math.min(cap, top - bottom) : 0, body = top - capped;
      const box = (y0: number, y1: number) =>
        new THREE.BoxGeometry(e.thickness, y1 - y0, piece + extra)
          .rotateY(yaw)
          .translate(e.x0 + ux * (mid + shift), (y0 + y1) / 2, e.z0 + uz * (mid + shift));
      add(box(bottom, body), 'wall');
      if (capped > 0) add(box(body, top), 'cap');
    }
  } else if (e.kind === 'tower') {
    const ring: [number, number][] = [[e.x, e.z]];
    for (let k = 0; k < 8; k++) ring.push([e.x + Math.sin((k * Math.PI) / 4) * e.radius, e.z + Math.cos((k * Math.PI) / 4) * e.radius]);
    if (capped) for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) ring.push([e.x + (sx * capped.width) / 2, e.z + (sz * capped.depth) / 2]);
    const [lo] = groundSpan(groundAt, ring), centre = groundAt(e.x, e.z) ?? lo;
    const bottom = lo - 0.5, top = centre + e.height;
    if (!capped) add(new THREE.CylinderGeometry(e.radius, e.radius, top - bottom, 24).translate(e.x, (top + bottom) / 2, e.z), 'tower');
    else {
      // Made of a design: its top the design (darker); below it, straight down, what its bottom
      // layer is (a ring: a round tower that thick; solid: solid), in runs of metre columns.
      const capTop = Math.min(capped.height, top - bottom), body = top - capTop;
      const base = capped.base ?? { width: Math.ceil(capped.width), depth: Math.ceil(capped.depth), columns: new Uint8Array(Math.ceil(capped.width) * Math.ceil(capped.depth)).fill(1) };
      const x0 = e.x - base.width / 2, z0 = e.z - base.depth / 2;
      for (let j = 0; j < base.depth; j++)
        for (let i = 0; i < base.width; ) {
          if (!base.columns[i + base.width * j]) {
            i++;
            continue;
          }
          let n = 1;
          while (i + n < base.width && base.columns[i + n + base.width * j]) n++;
          const run = (y0: number, y1: number) => new THREE.BoxGeometry(n, y1 - y0, 1).translate(x0 + i + n / 2, (y0 + y1) / 2, z0 + j + 0.5);
          add(run(bottom, body), 'tower');
          if (capTop > 0) add(run(body, top), 'cap');
          i += n;
        }
    }
  } else {
    const corners: [number, number][] = [[e.x0, e.z0], [e.x1, e.z0], [e.x1, e.z1], [e.x0, e.z1], [(e.x0 + e.x1) / 2, (e.z0 + e.z1) / 2]];
    const [lo, hi] = groundSpan(groundAt, corners);
    const w = e.x1 - e.x0, d = e.z1 - e.z0, bottom = lo - 0.5, eaves = hi + e.height;
    add(new THREE.BoxGeometry(w, eaves - bottom, d).translate(e.x0 + w / 2, (eaves + bottom) / 2, e.z0 + d / 2), 'building');
    // The roof: a ridge along the longer side, rising a third of the shorter.
    const along = w >= d, span = along ? d : w, rise = span / 3;
    const roof = new THREE.BufferGeometry();
    const L = along ? w : d;
    // (Built along z, centred; turned and placed after.)
    // prettier-ignore
    const v = [
      -span / 2, 0, -L / 2,  span / 2, 0, -L / 2,  0, rise, -L / 2,
      -span / 2, 0, L / 2,  0, rise, L / 2,  span / 2, 0, L / 2,
      -span / 2, 0, -L / 2,  0, rise, -L / 2,  0, rise, L / 2,   -span / 2, 0, -L / 2,  0, rise, L / 2,  -span / 2, 0, L / 2,
      span / 2, 0, -L / 2,  span / 2, 0, L / 2,  0, rise, L / 2,   span / 2, 0, -L / 2,  0, rise, L / 2,  0, rise, -L / 2,
    ];
    roof.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    roof.computeVertexNormals();
    if (along) roof.rotateY(Math.PI / 2);
    roof.translate(e.x0 + w / 2, eaves, e.z0 + d / 2);
    add(roof, 'roof');
  }
}

/** A plan's meshes over the close-up: `chosen`, the element (by id) edged in gold. */
export function planGroup(plan: Plan, groundAt: (x: number, z: number) => number | null, chosen: string | null, capOf: (e: PlanElement) => PlanCap | null = () => null): THREE.Group {
  const group = new THREE.Group();
  group.name = 'plan';
  const materials: Record<string, THREE.Material> = {
    wall: planMaterial(COLORS.wall, 0.78),
    tower: planMaterial(COLORS.tower, 0.78),
    building: planMaterial(COLORS.building, 0.72),
    roof: planMaterial(COLORS.roof, 0.85),
    cap: planMaterial(COLORS.cap, 0.85),
    capGhost: planMaterial(COLORS.cap, 0.25, false),
    wallGhost: planMaterial(COLORS.wall, 0.2, false),
    towerGhost: planMaterial(COLORS.tower, 0.2, false),
    buildingGhost: planMaterial(COLORS.building, 0.18, false),
    roofGhost: planMaterial(COLORS.roof, 0.3, false),
  };
  // (Edges over everything, so a plan's lines show through what's in front.)
  const edges = new THREE.LineBasicMaterial({ color: 0xf2ead8, transparent: true, opacity: 0.6, depthWrite: false, depthTest: false });
  const gold = new THREE.LineBasicMaterial({ color: CHOSEN, depthTest: false });
  for (const e of plan.elements) elementMeshes(e, groundAt, group, materials, e.id === chosen ? gold : edges, e.kind === 'building' ? null : capOf(e));
  return group;
}

/** Frees a plan group's geometry and materials. */
export function disposePlanGroup(group: THREE.Group): void {
  const materials = new Set<THREE.Material>();
  group.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
      o.geometry.dispose();
      materials.add(o.material as THREE.Material);
    }
  });
  for (const m of materials) m.dispose();
  group.removeFromParent();
}
