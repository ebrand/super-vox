import * as THREE from 'three';
import { ATMOSPHERE_GLSL, type Atmosphere } from './atmosphere.js';
import { PALETTE_SIZE, TINTED, paletteColors } from './materials.js';
import { LUT_H, LUT_T_MAX, LUT_T_MIN, LUT_W } from './tintColors.js';
import { Material } from '@super-vox/shared';

/** What trees are made of: the map grid (gridOn) isn't drawn on them, only on the ground they hide. */
const TREE_MATERIALS = [Material.Wood, Material.Leaves, Material.Needles, Material.JungleLeaves, Material.AcaciaLeaves];

/**
 * Biome colour blending: the world's climate grid as a texture (temperature and moisture per
 * cell, see ClimateGrid) and a lookup of ground colour by climate (see biomeTintLut). Ground of
 * the TINTED materials takes the colour of its local climate, so biomes shade into each other.
 */
export interface Tint {
  climate: THREE.Texture;
  lut: THREE.Texture;
  /** World size covered by the climate texture (metres), sea level (m) and cooling (C per m). */
  extent: THREE.Vector2;
  seaLevelM: number;
  coolingPerM: number;
}


/**
 * Voxel material for packed meshes (see MeshBuffers): positions are
 * chunk-local units (the mesh is scaled by 1/16), and each vertex carries its
 * face direction, voxel size, grid phase, material id and corner occlusion (see MeshBuffers).
 * Colors come from a palette uniform. Merged quads cover many voxels, so voxel edges are drawn in the
 * fragment shader and fade out with distance to avoid moire. Lit by the sun and by sky and ground
 * light (less in occluded corners), and hazed by the atmosphere.
 */
export function createVoxelMaterial(atmosphere: Atmosphere): THREE.ShaderMaterial & { setTint(tint: Tint | null): void; setGrassWind(wind: { x: number; z: number }, dt: number): void } {
  const empty = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  empty.needsUpdate = true;
  const material = new THREE.ShaderMaterial({
    defines: { PALETTE_SIZE },
    uniforms: {
      ...atmosphere.uniforms,
      palette: { value: paletteColors().map(([r, g, b]) => new THREE.Vector3(r, g, b)) },
      tinted: { value: Array.from({ length: PALETTE_SIZE }, (_, id) => (TINTED.has(id) ? 1 : 0)) },
      tintOn: { value: 0 },
      climateTex: { value: empty as THREE.Texture },
      tintLut: { value: empty as THREE.Texture },
      climateExtent: { value: new THREE.Vector2(1, 1) },
      climateSea: { value: 0 },
      climateCooling: { value: 0 },
      aoStrength: { value: 0.2 },
      exposure: { value: 1 },
      // A map grid on the ground (the terraformer's close-up; off in the game): see gridOn.
      gridOn: { value: 0 },
      // Trees see-through (the terraformer's close-up): 0 everything, 1 all but trees, 2 trees
      // only, at treeAlpha (a second, transparent pass).
      treePass: { value: 0 },
      treeAlpha: { value: 1 },
      // Grass in the wind (the game; see setGrassWind): its tops speckled with blades and clumps;
      // gusts, drifting downwind (grassDrift: how far the air's gone, m), lighten it as it bends,
      // and blades flutter in them (grassTime, s); grassWind (m/s) says which way and how hard.
      grassOn: { value: 0 },
      grassTime: { value: 0 },
      grassDrift: { value: new THREE.Vector2() },
      grassWind: { value: new THREE.Vector2() },
    },
    vertexShader: /* glsl */ `
      attribute vec4 face;
      attribute vec2 shade;
      uniform vec3 palette[PALETTE_SIZE];
      uniform float tinted[PALETTE_SIZE];
      varying vec3 vColor;
      varying vec3 vNormal;
      varying vec3 vUnits;
      varying vec3 vWorld;
      varying float vSize;
      varying vec2 vPhase;
      varying float vAo;
      varying float vTinted;
      varying float vTree;
      varying float vSkyLight;
      varying float vBlockLight;
      varying float vGlows;
      varying float vGrass;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      const vec3 NORMALS[6] = vec3[6](
        vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0),
        vec3(0.0, 1.0, 0.0), vec3(0.0, -1.0, 0.0),
        vec3(0.0, 0.0, 1.0), vec3(0.0, 0.0, -1.0));
      void main() {
        // face = (dir | (size - 1) << 3, phaseA | phaseB << 4, material lo, material hi | ao << 6)
        float b0 = floor(face.x + 0.5);
        float b1 = floor(face.y + 0.5);
        float b3 = floor(face.w + 0.5);
        vNormal = NORMALS[int(mod(b0, 8.0))];
        vSize = floor(b0 / 8.0) + 1.0;
        vPhase = vec2(mod(b1, 16.0), floor(b1 / 16.0));
        vAo = floor(b3 / 64.0);
        int material = int(face.z + mod(b3, 64.0) * 256.0 + 0.5);
        vColor = material < PALETTE_SIZE ? palette[material] : vec3(1.0, 0.0, 1.0);
        vTinted = material < PALETTE_SIZE ? tinted[material] : 0.0;
        // Trees (trunks and leaves): the map grid is on the ground only.
        vTree = ${TREE_MATERIALS.map((m) => `material == ${m}`).join(' || ')} ? 1.0 : 0.0;
        // shade = (how far below full sky light, block light): see MeshBuffers.shade.
        vSkyLight = 1.0 - shade.x;
        vBlockLight = shade.y;
        // Flames give light: drawn at full brightness, whatever lights them.
        vGlows = material == ${Material.TorchFlame} ? 1.0 : 0.0;
        vGrass = material == ${Material.Grass} || material == ${Material.DryGrass} ? 1.0 : 0.0;
        vUnits = position;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      uniform float tintOn;
      uniform sampler2D climateTex;
      uniform sampler2D tintLut;
      uniform vec2 climateExtent;
      uniform float climateSea;
      uniform float climateCooling;
      uniform float aoStrength;
      uniform float exposure;
      uniform float gridOn;
      uniform float treePass;
      uniform float treeAlpha;
      varying vec3 vColor;
      varying vec3 vNormal;
      varying vec3 vUnits;
      varying vec3 vWorld;
      varying float vSize;
      varying vec2 vPhase;
      varying float vAo;
      varying float vTinted;
      varying float vTree;
      varying float vSkyLight;
      varying float vBlockLight;
      varying float vGlows;
      varying float vGrass;
      uniform float grassOn;
      uniform float grassTime;
      uniform vec2 grassDrift;
      uniform vec2 grassWind;
      #include <logdepthbuf_pars_fragment>
      // A random 0..1 for a whole-numbered cell (wrapped first: far out, a float's too coarse to hash).
      float cellHash(vec2 c) {
        c = mod(c, 1024.0);
        vec2 p = fract(c * vec2(0.1031, 0.1030));
        p += dot(p, p.yx + 33.33);
        return fract((p.x + p.y) * p.x);
      }
      // Smooth noise 0..1, about a unit across.
      float valueNoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(cellHash(i), cellHash(i + vec2(1.0, 0.0)), f.x), mix(cellHash(i + vec2(0.0, 1.0)), cellHash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      // How grass looks at world point xz (m), as a brightness to multiply its colour by: blades
      // (1/16 m) and clumps (1/2 m), and gusts of wind going over it, lightening it as it bends
      // (bands across the wind, sweeping downwind), blades fluttering in them. The fine detail
      // fades out once it's too small to see.
      float grassShade(vec2 xz) {
        vec2 blade = floor(xz * 16.0);
        float r = cellHash(blade), r2 = cellHash(blade + 517.0);
        float fine = 1.0 - smoothstep(0.25, 0.6, max(fwidth(xz.x), fwidth(xz.y)) * 16.0);
        float clump = valueNoise(xz * 2.0);
        // The wind's frame: along it, and across it (the gusts long across, short along).
        float speed = length(grassWind);
        vec2 along = speed > 0.01 ? grassWind / speed : vec2(1.0, 0.0);
        vec2 q = xz - grassDrift;
        vec2 w = vec2(dot(q, along), dot(q, vec2(-along.y, along.x)));
        float gust = smoothstep(0.5, 0.85, valueNoise(w * vec2(0.25, 0.08))) * clamp(speed / 6.0, 0.15, 1.0);
        // (A whole number of cycles in 100 s, 0.4 to 0.7 a second: see setGrassWind.)
        float flutter = sin(grassTime * 6.283 * floor(40.0 + 30.0 * r2) / 100.0 + r * 6.283);
        return (1.0 + fine * (0.16 * (r - 0.5) + 0.06 * flutter * (0.3 + gust))) * (0.94 + 0.12 * clump) * (1.0 + 0.16 * gust);
      }
      // Lines every "spacing" (world units of vWorld: metres) across x and z, "widthPx" pixels wide
      // (x: the lines across x, at constant x; y: those at constant z); fading out once they're
      // under about ten pixels apart (no moire, no solid wash).
      vec2 gridLines(vec2 p, float spacing, float widthPx) {
        vec2 fw = max(fwidth(p), vec2(1e-6));
        vec2 d = abs(fract(p / spacing + 0.5) - 0.5) * spacing / fw;
        vec2 l = 1.0 - smoothstep(vec2(widthPx * 0.5), vec2(widthPx * 0.5 + 1.0), d);
        return l * smoothstep(3.0, 10.0, spacing / max(fw.x, fw.y));
      }
      // Dashes along a line ("t" along it), "period" long, half on and half off; solid once the
      // dashes would be too small to see (no shimmer far off).
      float dashes(float t, float period, float fw) {
        float u = abs(fract(t / period) - 0.5) * period;
        float on = clamp((u - period * 0.25) / max(fw, 1e-6) + 0.5, 0.0, 1.0);
        return mix(1.0, on, smoothstep(6.0, 12.0, period / max(fw, 1e-6)));
      }
      void main() {
        #include <logdepthbuf_fragment>
        // (Trees see-through: the opaque pass leaves them out, their own pass draws only them.)
        if (treePass > 0.5 && (treePass < 1.5) == (vTree > 0.5)) discard;
        vec3 n = vNormal;
        vec2 p = abs(n.x) > 0.5 ? vUnits.yz : (abs(n.y) > 0.5 ? vUnits.xz : vUnits.xy);
        // Voxels never cross 1 m blocks, so each voxel's grid starts at its
        // block-local phase. Derivatives come from the continuous position.
        vec2 fw = fwidth(p / vSize);
        vec2 cell = (mod(p, 16.0) - vPhase) / vSize;
        vec2 grid = abs(fract(cell - 0.5) - 0.5) / max(fw, vec2(1e-4));
        float line = 1.0 - min(min(grid.x, grid.y), 1.0);
        // Fade lines once a voxel spans only a few pixels.
        line *= 1.0 - smoothstep(0.15, 0.35, max(fw.x, fw.y));
        vec3 base = vColor;
        if (tintOn > 0.5 && vTinted > 0.5) {
          // The ground colour of the local climate: temperature falls with height.
          vec2 c = texture2D(climateTex, vWorld.xz / climateExtent).rg;
          float t = c.r * 127.5 - 64.0 - climateCooling * max(0.0, vWorld.y - climateSea);
          // Samples sit at texel centres: first and last at the range's ends.
          vec2 at = clamp(vec2((t - ${LUT_T_MIN.toFixed(1)}) / ${(LUT_T_MAX - LUT_T_MIN).toFixed(1)}, c.g), 0.0, 1.0);
          base = texture2D(tintLut, (at * vec2(${LUT_W - 1}.0, ${LUT_H - 1}.0) + 0.5) / vec2(${LUT_W}.0, ${LUT_H}.0)).rgb;
        }
        // Grass tops: blades, clumps, and the wind over them.
        if (grassOn > 0.5 && vGrass > 0.5 && n.y > 0.5) base *= grassShade(vWorld.xz);
        // Corner occlusion: 0 (open) .. 3 (tucked into a corner).
        float ao = max(0.0, 1.0 - aoStrength * vAo);
        float sky = 0.5 + 0.5 * n.y;
        vec3 light = mix(groundAmbient, skyAmbient, sky) * ao + sunColor * max(dot(n, sunDir), 0.0) * mix(1.0, ao, 0.5);
        // Shade underground: sky light 0..15 (vSkyLight 0..1), each step down 80% as bright, so
        // the depths of a cave are nearly black (as Minecraft's).
        light *= pow(0.8, 15.0 * (1.0 - vSkyLight));
        // Torchlight (block light 0..15, the same falloff), warm, whatever the time of day; faded
        // to nothing over its last few levels (that falloff alone ends at 4% of a torch's light, a
        // hard edge where its reach ends: plain in the dark of night, a diamond of straight lines).
        float torch = pow(0.8, 15.0 * (1.0 - vBlockLight)) * smoothstep(0.0, 0.3, vBlockLight);
        light += vec3(1.0, 0.7, 0.4) * torch * ao;
        if (vGlows > 0.5) light = vec3(1.0);
        // Below the water, light that reached down through it (red is lost first).
        if (vWorld.y < waterLevel) light *= exp(-WATER_ABSORB * 0.5 * (waterLevel - vWorld.y));
        vec3 rgb = base * light * exposure * (1.0 - 0.35 * line);
        // Night vision: colour fades and shifts blue in the dark.
        // (Not where a torch lights it: that keeps its colour.)
        rgb = mix(rgb, vec3(dot(rgb, vec3(0.3, 0.5, 0.2))) * vec3(0.75, 0.9, 1.25), 0.7 * stars * (1.0 - min(1.0, 1.5 * torch + vGlows)));
        if (gridOn > 0.5 && vTree < 0.5) {
          // Metres faintly dark, half kilometres white, kilometres yellow (seen from above: on
          // every face of the ground, by where it is across it; not on trees, which hide it).
          vec2 g = vWorld.xz, fw = fwidth(g);
          vec2 metre = gridLines(g, 1.0, 1.0);
          rgb = mix(rgb, vec3(0.0), 0.3 * max(metre.x, metre.y));
          // Half kilometres dashed (20 m on, 20 m off), kilometres solid; both partly see-through.
          vec2 halfKm = gridLines(g, 500.0, 1.5);
          rgb = mix(rgb, vec3(1.0), 0.4 * max(halfKm.x * dashes(g.y, 40.0, fw.y), halfKm.y * dashes(g.x, 40.0, fw.x)));
          vec2 km = gridLines(g, 1000.0, 2.5);
          rgb = mix(rgb, vec3(1.0, 0.86, 0.35), 0.6 * max(km.x, km.y));
        }
        gl_FragColor = vec4(applyHaze(rgb, vWorld), treePass > 1.5 ? treeAlpha : 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  // (Flutter cycles a whole number of times every 100 s: its time goes round without a jump.)
  let drift = new THREE.Vector2();
  return Object.assign(material, {
    /** Grass in the wind (see grassShade): on, `wind` (m/s, x east, z south) for `dt` s more. */
    setGrassWind(wind: { x: number; z: number }, dt: number) {
      const u = material.uniforms;
      u.grassOn!.value = 1;
      u.grassTime!.value = (u.grassTime!.value + dt) % 100;
      drift = drift.add(new THREE.Vector2(wind.x * dt, wind.z * dt));
      // (Far enough, start again: a gust's pattern jumps, once in hours.)
      if (drift.lengthSq() > 1e10) drift.set(0, 0);
      u.grassDrift!.value.copy(drift);
      u.grassWind!.value.set(wind.x, wind.z);
    },
    setTint(tint: Tint | null) {
      const u = material.uniforms;
      u.tintOn!.value = tint ? 1 : 0;
      u.climateTex!.value = tint?.climate ?? empty;
      u.tintLut!.value = tint?.lut ?? empty;
      if (tint) {
        u.climateExtent!.value = tint.extent;
        u.climateSea!.value = tint.seaLevelM;
        u.climateCooling!.value = tint.coolingPerM;
      }
    },
  });
}
