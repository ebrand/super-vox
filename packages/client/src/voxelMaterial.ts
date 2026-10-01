import * as THREE from 'three';
import { PALETTE_SIZE, paletteColors } from './materials.js';

/**
 * Voxel material for packed meshes (see MeshBuffers): positions are
 * chunk-local units (the mesh is scaled by 1/16), and each vertex carries its
 * face direction, voxel size, grid phase, and material id (see MeshBuffers). Colors come from a palette
 * uniform. Merged quads cover many voxels, so voxel edges are drawn in the
 * fragment shader and fade out with distance to avoid moire.
 */
export function createVoxelMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: true,
    defines: { PALETTE_SIZE },
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        sunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
        palette: { value: paletteColors().map(([r, g, b]) => new THREE.Vector3(r, g, b)) },
      },
    ]),
    vertexShader: /* glsl */ `
      attribute vec4 face;
      uniform vec3 palette[PALETTE_SIZE];
      varying vec3 vColor;
      varying vec3 vNormal;
      varying vec3 vUnits;
      varying float vSize;
      varying vec2 vPhase;
      #include <common>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      const vec3 NORMALS[6] = vec3[6](
        vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0),
        vec3(0.0, 1.0, 0.0), vec3(0.0, -1.0, 0.0),
        vec3(0.0, 0.0, 1.0), vec3(0.0, 0.0, -1.0));
      void main() {
        // face = (dir | (size - 1) << 3, phaseA | phaseB << 4, material lo, material hi)
        float b0 = floor(face.x + 0.5);
        float b1 = floor(face.y + 0.5);
        vNormal = NORMALS[int(mod(b0, 8.0))];
        vSize = floor(b0 / 8.0) + 1.0;
        vPhase = vec2(mod(b1, 16.0), floor(b1 / 16.0));
        int material = int(face.z + face.w * 256.0 + 0.5);
        vColor = material < PALETTE_SIZE ? palette[material] : vec3(1.0, 0.0, 1.0);
        vUnits = position;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 sunDir;
      varying vec3 vColor;
      varying vec3 vNormal;
      varying vec3 vUnits;
      varying float vSize;
      varying vec2 vPhase;
      #include <fog_pars_fragment>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
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
        float light = 0.55 + 0.45 * max(dot(n, sunDir), 0.0);
        vec3 rgb = vColor * light * (1.0 - 0.35 * line);
        gl_FragColor = vec4(rgb, 1.0);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  });
}
