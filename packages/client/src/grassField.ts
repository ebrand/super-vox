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

interface Tops {
  origin: { x: number; y: number; z: number };
  data: Uint16Array;
}

/**
 * Grass blades near the eye: on every open top of grass and dry grass (see grassTops), one to a
 * 1/4 m patch, a column 1/16 m square and 2 to 6 sixteenths tall, where in its patch and how tall
 * by where it is; bending in the wind (the gusts the grass shader draws: see grassGust), the top
 * most. Lit and tinted as the ground (sharing its material's uniforms). Each chunk's blades are one
 * instanced mesh, made when the chunk comes within GRASS_RANGE and let go when it's left behind;
 * farther, the grass shader alone.
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
      vertexShader: /* glsl */ `
        attribute vec4 aPatch;
        attribute vec3 lit;
        uniform float bladeRange;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vTip;
        varying float vShade;
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
          // Where in its patch, how tall (none on part of a small patch: as many to a metre); shrinking away far off.
          vec2 at = floor(vec2(r1 * pw, r2 * pd));
          float h = (2.0 + floor(r3 * 5.0)) * step(r4, pw * pd / ${PATCH * PATCH}.0);
          vec3 base = aPatch.xyz + vec3(at.x, 0.0, at.y);
          vec3 foot = (modelMatrix * vec4(base + vec3(0.5, 0.0, 0.5), 1.0)).xyz;
          h *= 1.0 - smoothstep(bladeRange * 0.66, bladeRange, distance(foot, cameraPosition));
          vec3 p = base + vec3(position.x, position.y * h, position.z);
          // Bent downwind at the top, harder in a gust; and a little flutter of its own.
          float speed = length(grassWind);
          vec2 dir = speed > 0.01 ? grassWind / speed : vec2(1.0, 0.0);
          float gust = grassGust(foot.xz);
          float bend = h * (0.1 + 0.35 * gust) * clamp(speed / 8.0, 0.15, 1.0)
            + 0.25 * sin(grassTime * 6.283 * floor(40.0 + 30.0 * r1) / 100.0 + r2 * 6.283);
          p.xz += dir * bend * position.y;
          vec4 world = modelMatrix * vec4(p, 1.0);
          vWorld = world.xyz;
          vNormal = normal;
          vTip = position.y;
          vShade = 0.85 + 0.3 * r3;
          vLit = lit;
          gl_Position = projectionMatrix * viewMatrix * world;
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
        varying float vTip;
        varying float vShade;
        varying vec3 vLit;
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          bool dry = vLit.z > 0.5;
          vec3 base = groundColor(dry ? dryColor : greenColor, dry ? dryTinted : greenTinted, vWorld) * vShade;
          // Darker at the foot (in among the others), lighter at the tip.
          float ao = mix(0.65, 1.0, vTip);
          vec3 rgb = litColor(base * mix(0.9, 1.12, vTip), vNormal, ao, vLit.x, vLit.y, 0.0, vWorld);
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
    g.setAttribute('normal', this.blade.getAttribute('normal'));
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

/** A blade: a column 1 unit square, 1 tall (the shader stretches it), its four sides and its top. */
export function bladeGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  const quad = (corners: number[][], n: number[]) => {
    const i = pos.length / 3;
    for (const c of corners) {
      pos.push(...c);
      nor.push(...n);
    }
    idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  quad([[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], [1, 0, 0]);
  quad([[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], [-1, 0, 0]);
  quad([[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], [0, 0, 1]);
  quad([[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], [0, 0, -1]);
  quad([[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], [0, 1, 0]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}
