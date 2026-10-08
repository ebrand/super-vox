import * as THREE from 'three';
import { CHUNK_SIZE, Material, UNITS_PER_METER } from '@super-vox/shared';
import { ATMOSPHERE_GLSL } from './atmosphere.js';
import { GRASS_TOP_FIELDS } from './grassTops.js';
import { TINTED } from './materials.js';
import { GRASS_WIND_GLSL, VOXEL_SHADING_GLSL } from './voxelMaterial.js';

/** How far from the eye blades grow (m); they shrink away over the last third of it. */
export const GRASS_RANGE = 24;
/** Each blade stands on a patch of grass top this many units across (1/4 m). */
const PATCH = 4;
/** Chunks given blades (made, or let go) a frame at most: walking on, no hitch. */
const BUILDS_PER_FRAME = 2;
/** Blades drawn in each tuft. */
const BLADES = 6;

interface Tops {
  origin: { x: number; y: number; z: number };
  data: Uint16Array;
}

/**
 * Grass blades near the eye: on the open tops of grass and dry grass (see grassTops), in its
 * patches (see grassPatch), a tuft to a 1/4 m patch: a flat quad turned to face the eye, 3 to 7
 * sixteenths tall, with BLADES thin blades drawn on it (in texels 1/64 m square; the rest of it not
 * drawn), bending in the wind (the gusts the grass shader draws: see grassGust), the top most. Lit
 * and tinted as the ground (sharing its material's uniforms). Each chunk's tufts are one instanced
 * mesh, made when the chunk comes within GRASS_RANGE and let go when it's left behind; farther,
 * the grass shader alone.
 */
export class GrassField {
  private readonly tops = new Map<string, Tops>();
  private readonly shown = new Map<string, THREE.Mesh>();
  private readonly blade: THREE.BufferGeometry;
  readonly material: THREE.ShaderMaterial;

  constructor(
    private readonly scene: THREE.Scene,
    /** The terrain's material (see createVoxelMaterial): its uniforms are shared, so the blades are lit, tinted and blown as the ground is. */
    ground: THREE.ShaderMaterial,
  ) {
    this.blade = bladeGeometry();
    const palette = ground.uniforms.palette!.value as THREE.Vector3[];
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...ground.uniforms,
        greenColor: { value: palette[Material.Grass]!.clone() },
        dryColor: { value: palette[Material.DryGrass]!.clone() },
        greenTinted: { value: TINTED.has(Material.Grass) ? 1 : 0 },
        dryTinted: { value: TINTED.has(Material.DryGrass) ? 1 : 0 },
        bladeRange: { value: GRASS_RANGE },
      },
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute vec4 aPatch;
        attribute vec3 lit;
        uniform float bladeRange;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying vec2 vUv;
        varying float vTexels;
        varying float vSeed;
        varying vec3 vLit;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        ${GRASS_WIND_GLSL}
        void main() {
          // The patch: its corner (chunk-local units), and its size across x and z (whole units, 1..4).
          float pw = floor(aPatch.w / 8.0), pd = mod(aPatch.w, 8.0);
          vec3 corner = (modelMatrix * vec4(aPatch.xyz, 1.0)).xyz;
          vec2 key = floor(corner.xz * ${UNITS_PER_METER}.0 + 0.5);
          float r1 = cellHash(key), r2 = cellHash(key + 71.0), r3 = cellHash(key + 143.0), r4 = cellHash(key + 211.0);
          // A tuft at the patch's middle (a little off it), as tall as it is (none on part of a small patch: as many to a metre); shrinking away far off.
          vec3 foot = (modelMatrix * vec4(aPatch.xyz + vec3(pw * (0.3 + 0.4 * r1), 0.0, pd * (0.3 + 0.4 * r2)), 1.0)).xyz;
          float h = (3.0 + floor(r3 * 5.0)) * step(r4, pw * pd / ${PATCH * PATCH}.0);
          h *= 1.0 - smoothstep(bladeRange * 0.66, bladeRange, distance(foot, cameraPosition));
          // Only in the grass's patches (fewer toward their edges: thinned, not stubs).
          h *= step(cellHash(key + 307.0), grassPatch(foot.xz));
          // Turned to face the eye (about the upright: it stands up), a patch wide (m); none: folded to a point.
          vec2 toEye = cameraPosition.xz - foot.xz;
          vec2 f = length(toEye) > 1e-4 ? normalize(toEye) : vec2(0.0, 1.0);
          vec2 right = vec2(-f.y, f.x);
          float wide = ${PATCH}.0 / ${UNITS_PER_METER}.0 * step(0.05, h), tall = h / ${UNITS_PER_METER}.0;
          vec3 p = foot + vec3(right.x * position.x * wide, position.y * tall, right.y * position.x * wide);
          // Bent downwind at the top, harder in a gust; and a little flutter of its own.
          float speed = length(grassWind);
          vec2 dir = speed > 0.01 ? grassWind / speed : vec2(1.0, 0.0);
          float gust = grassGust(foot.xz);
          float bend = tall * (0.1 + 0.35 * gust) * clamp(speed / 8.0, 0.15, 1.0)
            + 0.015 * sin(grassTime * 6.283 * floor(40.0 + 30.0 * r1) / 100.0 + r2 * 6.283);
          p.xz += dir * bend * position.y;
          vWorld = p;
          // Lit as the ground is, leaning a little toward the eye.
          vNormal = normalize(vec3(f.x * 0.4, 1.0, f.y * 0.4));
          vUv = vec2(position.x + 0.5, position.y);
          vTexels = h * 4.0;
          vSeed = r3 * 97.0 + r1 * 13.0;
          vLit = lit;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        ${ATMOSPHERE_GLSL}
        ${VOXEL_SHADING_GLSL}
        uniform vec3 greenColor;
        uniform vec3 dryColor;
        uniform float greenTinted;
        uniform float dryTinted;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying vec2 vUv;
        varying float vTexels;
        varying float vSeed;
        varying vec3 vLit;
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          // Its blades, drawn in texels 1/64 m square (16 across the tuft): each from a place along
          // its foot, leaning, up to its own height, thinning to a point; the rest isn't drawn.
          vec2 t = floor(vec2(vUv.x * 16.0, vUv.y * vTexels)) + 0.5;
          float u = t.x / 16.0, v = t.y / max(vTexels, 1.0);
          float shade = -1.0;
          for (int i = 0; i < ${BLADES}; i++) {
            float k = vSeed + float(i) * 7.13;
            float x0 = 0.12 + 0.76 * cellHash(vec2(k, 1.0)), top = 0.45 + 0.55 * cellHash(vec2(k, 2.0));
            float lean = (cellHash(vec2(k, 3.0)) - 0.5) * 0.5;
            float hw = mix(1.2, 0.5, v / top) / 16.0;
            if (v < top && abs(u - (x0 + lean * v * v)) < hw) shade = 0.85 + 0.3 * cellHash(vec2(k, 4.0));
          }
          if (shade < 0.0) discard;
          bool dry = vLit.z > 0.5;
          vec3 base = groundColor(dry ? dryColor : greenColor, dry ? dryTinted : greenTinted, vWorld) * shade;
          // Darker at the foot (in among the others), lighter at the tip.
          vec3 rgb = litColor(base * mix(0.9, 1.12, v), vNormal, mix(0.6, 1.0, v), vLit.x, vLit.y, 0.0, vWorld);
          gl_FragColor = vec4(applyHaze(rgb, vWorld), 1.0);
          #include <colorspace_fragment>
        }
      `,
    });
  }

  /** A chunk's grass tops (see grassTops; null: none, or it's gone), its origin in units. */
  setTops(key: string, origin: { x: number; y: number; z: number } | null, data: Uint16Array | null): void {
    this.drop(key);
    if (origin && data) this.tops.set(key, { origin, data });
    else this.tops.delete(key);
  }

  /** How many chunks have blades now, and how many blades (for tests and the HUD). */
  get stats(): { chunks: number; patches: number } {
    let patches = 0;
    for (const m of this.shown.values()) patches += (m.geometry as THREE.InstancedBufferGeometry).instanceCount;
    return { chunks: this.shown.size, patches };
  }

  /** Each frame: blades for the chunks near `eye` (m), none for the rest. */
  update(eye: THREE.Vector3): void {
    let built = 0;
    const C = CHUNK_SIZE / UNITS_PER_METER;
    for (const [key, t] of this.tops) {
      // (How far the eye is from the chunk's box, m.)
      const o = [t.origin.x / UNITS_PER_METER, t.origin.y / UNITS_PER_METER, t.origin.z / UNITS_PER_METER];
      const d = Math.hypot(...[eye.x, eye.y, eye.z].map((e, a) => Math.max(0, o[a]! - e, e - (o[a]! + C))));
      const near = d < GRASS_RANGE, far = d > GRASS_RANGE + 4;
      if (near && !this.shown.has(key) && built < BUILDS_PER_FRAME) {
        built++;
        const mesh = this.build(t);
        if (mesh) {
          mesh.name = `grass ${key}`;
          this.scene.add(mesh);
          this.shown.set(key, mesh);
        }
      } else if (far) this.drop(key);
    }
  }

  dispose(): void {
    for (const key of [...this.shown.keys()]) this.drop(key);
    this.tops.clear();
    this.blade.dispose();
    this.material.dispose();
  }

  private drop(key: string): void {
    const m = this.shown.get(key);
    if (!m) return;
    m.removeFromParent();
    m.geometry.dispose();
    this.shown.delete(key);
  }

  /** A chunk's blades: a patch for each 1/4 m of each grass top (the last ones of a top smaller). */
  private build(t: Tops): THREE.Mesh | null {
    const d = t.data, F = GRASS_TOP_FIELDS;
    const patches: number[] = [], lit: number[] = [];
    for (let i = 0; i < d.length; i += F) {
      const [x, y, z, dx, dz, sky, block, dry] = [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!, d[i + 4]!, d[i + 5]!, d[i + 6]!, d[i + 7]!];
      for (let px = x; px < x + dx; px += PATCH)
        for (let pz = z; pz < z + dz; pz += PATCH) {
          patches.push(px, y, pz, Math.min(PATCH, x + dx - px) * 8 + Math.min(PATCH, z + dz - pz));
          lit.push(sky / 255, block / 255, dry);
        }
    }
    if (!patches.length) return null;
    const g = new THREE.InstancedBufferGeometry();
    g.index = this.blade.index;
    g.setAttribute('position', this.blade.getAttribute('position'));
    g.setAttribute('aPatch', new THREE.InstancedBufferAttribute(new Float32Array(patches), 4));
    g.setAttribute('lit', new THREE.InstancedBufferAttribute(new Float32Array(lit), 3));
    g.instanceCount = patches.length / 4;
    // (Culled as the chunk is: its box, units.)
    const S = CHUNK_SIZE;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(S / 2, S / 2, S / 2), (S * Math.sqrt(3)) / 2 + 16);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(S, S + 16, S));
    const mesh = new THREE.Mesh(g, this.material);
    mesh.position.set(t.origin.x / UNITS_PER_METER, t.origin.y / UNITS_PER_METER, t.origin.z / UNITS_PER_METER);
    mesh.scale.setScalar(1 / UNITS_PER_METER);
    return mesh;
  }
}

/** A tuft: a quad, x -0.5..0.5 across (the shader turns it to the eye), y 0..1 up. */
export function bladeGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}
