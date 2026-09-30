import * as THREE from 'three';

/**
 * Flat-shaded voxel material. Merged quads cover many voxels, so voxel edges
 * are drawn in the fragment shader from the chunk-local position and each
 * quad's voxel size. Lines fade out with distance to avoid moire.
 */
export function createVoxelMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { sunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() } },
    ]),
    vertexShader: /* glsl */ `
      attribute vec3 color;
      attribute float voxelSize;
      varying vec3 vColor;
      varying vec3 vNormal;
      varying vec3 vUnits;
      varying float vSize;
      #include <fog_pars_vertex>
      void main() {
        vColor = color;
        vNormal = normal;
        vUnits = position * 16.0;
        vSize = voxelSize;
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
        vec3 n = normalize(vNormal);
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
