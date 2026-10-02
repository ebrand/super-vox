import * as THREE from 'three';
import { ATMOSPHERE_GLSL, type Atmosphere } from './atmosphere.js';

/** Layer water surfaces are drawn on: after everything else, reading what lies behind them. */
export const WATER_LAYER = 1;

/**
 * GLSL for water surfaces. Needs ATMOSPHERE_GLSL before it, and the uniforms of waterUniforms.
 * waterColor(worldPos, normal) shades a surface fragment from what is behind it (the opaque scene's
 * colour and depth): light is absorbed along the path through the water (red first), so shallows
 * show a turquoise-tinted bottom and depths turn deep blue; the sky is reflected by Fresnel off
 * animated ripples, with the sun's glint; foam gathers where the water is very shallow.
 */
export const WATER_GLSL = /* glsl */ `
  uniform sampler2D sceneColor;
  uniform sampler2D sceneDepth;
  uniform vec2 resolution;
  uniform float farLog;
  uniform float time;
  uniform vec3 cameraForward;

  // Distance along the view axis to the opaque scene at a screen position (log depth, see three's
  // logdepthbuf: depth = log2(1 + w) / log2(far + 1)).
  float sceneViewDepth(vec2 uv) {
    return exp2(texture2D(sceneDepth, uv).r * farLog) - 1.0;
  }

  // Value noise with its gradient (Inigo Quilez), for ripples.
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  vec3 noised(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    float a = hash21(i), b = hash21(i + vec2(1.0, 0.0)), c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
    float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
    return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
  }

  // Ripples: the slope of two layers of noise drifting in different directions, octaves from
  // 16 m down to 0.5 m, each fading out before it shrinks to a few pixels (no moire).
  vec2 waveSlope(vec2 p, float pixel) {
    vec2 s = vec2(0.0);
    float len = 16.0, amp = 0.05;
    mat2 turn = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 6; i++) {
      float fade = 1.0 - smoothstep(0.04, 0.2, pixel / len);
      if (fade <= 0.0) break;
      float speed = sqrt(9.81 * len / 6.2831853) * 0.35;
      vec2 q = p / len;
      vec2 g = noised(q + vec2(time * speed / len, 0.37 * float(i))).yz + noised(turn * q * 1.3 - vec2(0.0, time * speed / len) + 11.0).yz;
      s += g * amp * fade;
      len *= 0.55;
      p = turn * p;
    }
    return s;
  }

  vec3 waterColor(vec3 worldPos, vec3 n0) {
    vec3 ray = worldPos - cameraPosition;
    float dist = length(ray);
    vec3 view = ray / dist;
    bool fromBelow = dot(view, n0) > 0.0;
    vec3 up = fromBelow ? -n0 : n0;
    // Size of a pixel on the water here (m), to fade ripples that can't be resolved.
    float pixel = length(fwidth(worldPos));
    // (Gentler from below, where they would bend Snell's window out of shape.)
    vec2 slope = waveSlope(worldPos.xz, pixel) * step(0.5, abs(n0.y)) * (fromBelow ? 0.35 : 1.0);
    vec3 n = normalize(up + vec3(-slope.x, 0.0, -slope.y) * abs(up.y));

    vec2 uv = gl_FragCoord.xy / resolution;
    float surfaceW = dot(ray, cameraForward);
    float behindW = sceneViewDepth(uv);
    // Refraction: look up the bottom a little off, along the ripples, unless that lands in front of the water.
    vec2 ruv = uv + n.xz * 0.03 * clamp((behindW - surfaceW) / 4.0, 0.0, 1.0);
    float rw = sceneViewDepth(ruv);
    if (rw < surfaceW) { ruv = uv; rw = behindW; }
    // Path length through water to the bottom, and the depth of water above it.
    float path = max(0.0, (rw - surfaceW) / max(dot(view, cameraForward), 1e-3));
    vec3 bottom = cameraPosition + view * (rw / max(dot(view, cameraForward), 1e-3));
    float depth = max(0.0, worldPos.y - bottom.y);

    if (fromBelow) {
      // From under water: the sky through Snell's window overhead; beyond it, the surface mirrors the deep.
      // (n faces the camera, down; past the critical angle, cos 0.66, nothing gets through.)
      float cosi = clamp(dot(-view, n), 0.0, 1.0);
      float window = smoothstep(0.62, 0.7, cosi);
      vec3 sky = skyColor(normalize(refract(view, n, 1.33) + vec3(0.0, 1e-4, 0.0))) * (1.0 - pow(1.0 - cosi, 5.0));
      return mix(deepWater(0.0) * 0.8, sky, window);
    }
    vec3 trans = exp(-WATER_ABSORB * path);
    vec3 below = texture2D(sceneColor, ruv).rgb * trans + deepWater(depth) * (1.0 - trans);

    float cosi = clamp(dot(-view, n), 0.0, 1.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - cosi, 5.0);
    vec3 r = reflect(view, n);
    vec3 rgb = mix(below, skyColor(r), fromBelow ? 0.0 : fresnel);
    rgb += fromBelow ? vec3(0.0) : glowColor * 1.4 * pow(max(dot(r, sunDir), 0.0), 400.0);

    // Foam where it's very shallow: broken up by the ripples, drifting with them.
    // (Thin flowing water over the ground stays mostly clear: foam is a light lace, strongest
    // right at the waterline.)
    float shallow = 1.0 - smoothstep(0.0, 0.12, depth);
    float froth = smoothstep(0.4, 0.8, sin(worldPos.x * 2.3 + slope.x * 6.0 + time * 0.7) * sin(worldPos.z * 2.1 - slope.y * 6.0 - time * 0.5) + shallow * 0.6);
    rgb = mix(rgb, vec3(0.9, 0.93, 0.95) * (skyAmbient * 1.4 + sunColor * max(sunDir.y, 0.2)), shallow * froth * 0.45 * (fromBelow ? 0.0 : 1.0));
    return rgb;
  }
`;

/** The uniforms WATER_GLSL needs (shared by every water material), with the atmosphere's. */
export function waterUniforms(atmosphere: Atmosphere) {
  return {
    ...atmosphere.uniforms,
    sceneColor: { value: null as THREE.Texture | null },
    sceneDepth: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    farLog: { value: 1 },
    time: { value: 0 },
    cameraForward: { value: new THREE.Vector3(0, 0, -1) },
  };
}

/** The sea surface (a large flat plane, kept under the camera). */
export function createSeaMaterial(uniforms: ReturnType<typeof waterUniforms>): THREE.ShaderMaterial & { setNear(x: number, z: number, half: number): void } {
  const near = { nearCentre: { value: new THREE.Vector2() }, nearHalf: { value: 0 } };
  const material = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, ...near },
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      ${WATER_GLSL}
      uniform vec2 nearCentre;
      uniform float nearHalf;
      varying vec3 vWorld;
      #include <logdepthbuf_pars_fragment>
      void main() {
        // Near the player, the sea is water voxels (and holes dug below sea level stay dry).
        vec2 d = abs(vWorld.xz - nearCentre);
        if (max(d.x, d.y) < nearHalf) discard;
        #include <logdepthbuf_fragment>
        gl_FragColor = vec4(applyHaze(waterColor(vWorld, vec3(0.0, 1.0, 0.0)), vWorld), 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  return Object.assign(material, {
    /** The square (centre and half-width, metres) where water voxels take over from the plane. */
    setNear(x: number, z: number, half: number) {
      near.nearCentre.value.set(x, z);
      near.nearHalf.value = half;
    },
  });
}

/**
 * Renders a scene whose water (objects on WATER_LAYER) shades from what's behind it: everything
 * else is drawn into an offscreen target (colour and depth); that is copied to the screen, depth
 * included; then the water is drawn over it, reading the target.
 */
export class WaterRenderer {
  readonly uniforms: ReturnType<typeof waterUniforms>;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly copyScene = new THREE.Scene();
  private readonly copyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly clock = new THREE.Clock();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    atmosphere: Atmosphere,
  ) {
    this.uniforms = waterUniforms(atmosphere);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.target.depthTexture = new THREE.DepthTexture(size.x, size.y, THREE.FloatType);
    this.uniforms.sceneColor.value = this.target.texture;
    this.uniforms.sceneDepth.value = this.target.depthTexture;
    // Full-screen copy of the target's colour and depth.
    const copy = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: { sceneColor: this.uniforms.sceneColor, sceneDepth: this.uniforms.sceneDepth },
        depthTest: true,
        depthWrite: true,
        depthFunc: THREE.AlwaysDepth,
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D sceneColor;
          uniform sampler2D sceneDepth;
          varying vec2 vUv;
          void main() {
            gl_FragColor = texture2D(sceneColor, vUv);
            gl_FragDepth = texture2D(sceneDepth, vUv).r;
            #include <colorspace_fragment>
          }
        `,
      }),
    );
    copy.frustumCulled = false;
    this.copyScene.add(copy);
  }

  setSize(): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target.setSize(size.x, size.y);
  }

  /** Draws the scene, water last, onto the screen (or into `output`). */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, output: THREE.WebGLRenderTarget | null = null): void {
    const r = this.renderer, u = this.uniforms;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    if (size.x !== this.target.width || size.y !== this.target.height) this.target.setSize(size.x, size.y);
    u.resolution.value.copy(size);
    u.farLog.value = Math.log2(camera.far + 1);
    u.time.value = this.clock.getElapsedTime();
    camera.getWorldDirection(u.cameraForward.value);
    const layers = camera.layers.mask;
    // 1. Everything but water, offscreen.
    camera.layers.set(0);
    r.setRenderTarget(this.target);
    r.clear();
    r.render(scene, camera);
    // 2. Onto the screen (or the output), depth and all.
    r.setRenderTarget(output);
    r.clear();
    r.render(this.copyScene, this.copyCamera);
    // 3. Water over it.
    camera.layers.set(WATER_LAYER);
    const autoClear = r.autoClear;
    r.autoClear = false;
    const background = scene.background;
    scene.background = null;
    r.render(scene, camera);
    scene.background = background;
    r.autoClear = autoClear;
    camera.layers.mask = layers;
  }
}

/**
 * Water voxels' surfaces (packed meshes, see MeshBuffers): shaded like the sea, from what lies
 * behind them; they write depth, so the far sea plane doesn't show through near water.
 */
export function createVoxelWaterMaterial(uniforms: ReturnType<typeof waterUniforms>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec4 face;
      varying vec3 vWorld;
      varying vec3 vNormal;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      const vec3 NORMALS[6] = vec3[6](
        vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0),
        vec3(0.0, 1.0, 0.0), vec3(0.0, -1.0, 0.0),
        vec3(0.0, 0.0, 1.0), vec3(0.0, 0.0, -1.0));
      void main() {
        vNormal = NORMALS[int(mod(floor(face.x + 0.5), 8.0))];
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      ${WATER_GLSL}
      varying vec3 vWorld;
      varying vec3 vNormal;
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        gl_FragColor = vec4(applyHaze(waterColor(vWorld, vNormal), vWorld), 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}
