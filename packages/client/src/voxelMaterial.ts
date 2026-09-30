import * as THREE from 'three';
import { PALETTE_SIZE, paletteColors } from './materials.js';

/**
 * Voxel material for packed meshes (see MeshBuffers): positions are
 * chunk-local units (the mesh is scaled by 1/16), and each vertex carries its
 * face direction, voxel size, and material id. Colors come from a palette
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
      #include <fog_pars_vertex>
      const vec3 NORMALS[6] = vec3[6](
        vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0),
        vec3(0.0, 1.0, 0.0), vec3(0.0, -1.0, 0.0),
        vec3(0.0, 0.0, 1.0), vec3(0.0, 0.0, -1.0));
      void main() {
        vNormal = NORMALS[int(face.x + 0.5)];
        vSize = face.y;
        int material = int(face.z + face.w * 256.0 + 0.5);
        vColor = material < PALETTE_SIZE ? palette[material] : vec3(1.0, 0.0, 1.0);
        vUnits = position;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 sunDir;
      varying vec3 vColor;
      varying vec3 vNormal;
      varying vec3 vUnits;
      varying float vSize;
      #include <fog_pars_fragment>
      void main() {
        vec3 n = vNormal;
        vec2 p = abs(n.x) > 0.5 ? vUnits.yz : (abs(n.y) > 0.5 ? vUnits.xz : vUnits.xy);
        vec2 cell = p / vSize;
        vec2 fw = fwidth(cell);
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
