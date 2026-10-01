import * as THREE from 'three';

/**
 * Sunlight, sky and haze shared by every material, so terrain fades into exactly the sky behind
 * it. Haze is thickest near sea level and thins with height (so peaks and high viewpoints see
 * further), takes the sun's warmth when looking toward it, and always closes in completely at the
 * view distance, where the terrain ends.
 */
export interface Atmosphere {
  uniforms: {
    sunDir: THREE.IUniform<THREE.Vector3>;
    sunColor: THREE.IUniform<THREE.Color>;
    skyAmbient: THREE.IUniform<THREE.Color>;
    groundAmbient: THREE.IUniform<THREE.Color>;
    horizonColor: THREE.IUniform<THREE.Color>;
    zenithColor: THREE.IUniform<THREE.Color>;
    glowColor: THREE.IUniform<THREE.Color>;
    /** Haze extinction at sea level (per metre) and its scale height (metres). */
    hazeDensity: THREE.IUniform<number>;
    hazeHeight: THREE.IUniform<number>;
    seaLevelM: THREE.IUniform<number>;
    viewDistance: THREE.IUniform<number>;
    /** Height of the water surface (m; far below everything when there's none), and 1 while the camera is under water. */
    waterLevel: THREE.IUniform<number>;
    underwater: THREE.IUniform<number>;
    /** Colour of the disc at sunDir (the sun, or the moon at night), and how many stars show (0..1). */
    discColor: THREE.IUniform<THREE.Color>;
    stars: THREE.IUniform<number>;
  };
}

/** Sun direction (towards the sun): south-east-ish, about 29 degrees up (low enough to model sides). */
export const SUN_DIR = new THREE.Vector3(0.6, 0.42, 0.45).normalize();

export function createAtmosphere(view: number, seaLevelM = 0): Atmosphere {
  return {
    uniforms: {
      sunDir: { value: SUN_DIR.clone() },
      sunColor: { value: new THREE.Color(0.9, 0.82, 0.67) },
      skyAmbient: { value: new THREE.Color(0.24, 0.28, 0.34) },
      groundAmbient: { value: new THREE.Color(0.16, 0.14, 0.11) },
      horizonColor: { value: new THREE.Color(0x9fb8cf) },
      zenithColor: { value: new THREE.Color(0x4f7fb3) },
      glowColor: { value: new THREE.Color(0xf2dcb4) },
      // Half the light gone over the view distance at sea level, before the final fade.
      hazeDensity: { value: Math.LN2 / view },
      hazeHeight: { value: 600 },
      seaLevelM: { value: seaLevelM },
      viewDistance: { value: view },
      waterLevel: { value: -1e6 },
      underwater: { value: 0 },
      discColor: { value: new THREE.Color(1, 0.97, 0.9) },
      stars: { value: 0 },
    },
  };
}

/** GLSL: the atmosphere's uniforms, skyColor(dir) and applyHaze(rgb, worldPos). Needs cameraPosition. */
export const ATMOSPHERE_GLSL = /* glsl */ `
  uniform vec3 sunDir;
  uniform vec3 sunColor;
  uniform vec3 skyAmbient;
  uniform vec3 groundAmbient;
  uniform vec3 horizonColor;
  uniform vec3 zenithColor;
  uniform vec3 glowColor;
  uniform float hazeDensity;
  uniform float hazeHeight;
  uniform float seaLevelM;
  uniform float viewDistance;
  uniform float waterLevel;
  uniform float underwater;
  uniform vec3 discColor;
  uniform float stars;

  // Water: light absorbed per metre (red first), and the colour of deep water lit from above
  // (darker the deeper the point it's seen from).
  const vec3 WATER_ABSORB = vec3(0.45, 0.075, 0.05);
  vec3 deepWater(float depth) {
    return vec3(0.015, 0.075, 0.11) * (skyAmbient * 1.6 + sunColor * max(sunDir.y, 0.0)) * exp(-WATER_ABSORB * 0.5 * max(depth, 0.0));
  }

  // Colour of the sky (and of thick haze) seen along a direction.
  vec3 hazeColor(vec3 dir) {
    float s = max(dot(dir, sunDir), 0.0);
    return mix(horizonColor, glowColor, 0.55 * pow(s, 6.0));
  }
  vec3 skyColor(vec3 dir) {
    float up = clamp(dir.y, 0.0, 1.0);
    // Smooth through the horizon (no kink where the haze below meets the gradient above).
    vec3 c = mix(hazeColor(dir), zenithColor, 1.0 - exp(-16.0 * up * up));
    float s = max(dot(dir, sunDir), 0.0);
    // The sun's disc and a soft halo.
    c += glowColor * (0.35 * pow(s, 64.0)) + discColor * smoothstep(0.99975, 0.9999, s);
    // Stars: one in a few hundred cells of a fine grid over the sky, brightest overhead.
    if (stars > 0.0 && dir.y > 0.0) {
      vec3 p = dir * 260.0;
      vec3 cell = floor(p);
      float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      if (h > 0.996) {
        vec3 centre = cell + 0.5 + 0.3 * (vec3(fract(h * 17.0), fract(h * 31.0), fract(h * 47.0)) - 0.5);
        float d = length(p - centre);
        c += vec3(0.9, 0.93, 1.0) * stars * smoothstep(0.45, 0.0, d) * (0.4 + 0.6 * fract(h * 97.0)) * smoothstep(0.0, 0.25, dir.y);
      }
    }
    return c;
  }

  // Haze between the camera and a point: exponential with height, integrated along the ray;
  // then a final fade over the last 30% of the view distance.
  vec3 applyHaze(vec3 rgb, vec3 worldPos) {
    vec3 ray = worldPos - cameraPosition;
    float dist = length(ray);
    if (underwater > 0.5) {
      // Under water: murk instead of haze, closing in within a few tens of metres.
      vec3 t = exp(-(WATER_ABSORB + 0.05) * dist);
      return rgb * t + deepWater(waterLevel - cameraPosition.y) * (1.0 - t);
    }
    vec3 dir = ray / max(dist, 1e-4);
    float h0 = cameraPosition.y - seaLevelM;
    float k = 1.0 / hazeHeight;
    float dy = dir.y * dist * k;
    float optical = hazeDensity * exp(-max(h0, -hazeHeight) * k) * dist * (abs(dy) < 1e-3 ? 1.0 - 0.5 * dy : (1.0 - exp(-dy)) / dy);
    float haze = 1.0 - exp(-optical);
    float edge = smoothstep(0.7 * viewDistance, viewDistance, dist);
    float f = 1.0 - (1.0 - haze) * (1.0 - edge);
    return mix(rgb, hazeColor(dir), f);
  }
`;

/** A sky dome that follows the camera, drawn behind everything. */
export function createSky(atmosphere: Atmosphere): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: atmosphere.uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        // Centred on the camera: only its rotation matters.
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      varying vec3 vDir;
      void main() {
        // Under water the sky is only seen through the surface (drawn with the water).
        gl_FragColor = vec4(underwater > 0.5 ? deepWater(waterLevel - cameraPosition.y) : skyColor(normalize(vDir)), 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  sky.name = 'sky';
  return sky;
}
