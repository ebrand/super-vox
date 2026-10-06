import * as THREE from 'three';
import { climateAt, prevailingWind, strikesBetween, weatherAt, type ClimateGrid, type PlaceClimate, type Weather } from '@super-vox/shared';
import { ATMOSPHERE_GLSL, type Atmosphere } from './atmosphere.js';
import { Precipitation, WeatherSound } from './weatherFx.js';

/**
 * The weather where the camera is, as the game shows it (see the shared weather.ts: the same
 * weather everyone sees, worked out from the world's seed, the server's time and its climate):
 * the light dimmed and the sky greyed under cloud, the sun and stars hidden by it, haze and fog
 * thickening in rain and on wet mornings, and a layer of cloud overhead, drifting on the wind, whose
 * cover is the weather's own (so the clouds you see are those it rains from); rain or snow falling
 * round the camera where it falls (not indoors), the rain's sound, and in storms lightning (the same
 * strikes for everyone) and its thunder, heard as late as the sound takes to arrive.
 */

/** Height of the cloud layer above the sea (m). */
const CLOUD_BASE = 1400;
/** Cells across the cloud cover worked out around the camera. */
const COVER_CELLS = 96;
/** How quickly what's shown follows the weather (s): a change takes a few of these. */
const EASE = 4;
/** Grey of an overcast sky (scaled by how bright the day is). */
const OVERCAST = new THREE.Color(0.62, 0.65, 0.68);
/** How far off lightning is seen (m), and how long a flash lasts (s). */
const STRIKE_RADIUS = 14000;
const FLASH = 0.35;
const FLASH_LIGHT = new THREE.Color(0.75, 0.8, 1.0);
const FLASH_SKY = new THREE.Color(0.7, 0.74, 0.9);
const BOLT_POINTS = 18;
/** How far you see in the thickest fog, and in the heaviest rain (m, to half). */
const FOG_HALF = 50;
const RAIN_HALF = 1500;

export interface WeatherNow extends Weather {}

export class WeatherView {
  readonly group = new THREE.Group();
  private seed: number | null = null;
  private climate: ClimateGrid | null = null;
  private seaLevel = 0;
  /** What's shown now (eased toward the weather). */
  private shown: WeatherNow | null = null;
  private readonly clouds: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly coverData = new Uint8Array(COVER_CELLS * COVER_CELLS);
  private readonly coverTex = new THREE.DataTexture(this.coverData, COVER_CELLS, COVER_CELLS, THREE.RedFormat);
  /** Where the cover was last worked out (m), how far across, and when (weather time s). */
  private cover: { x: number; z: number; size: number; t: number } | null = null;
  /** When this session's weather began (weather time s): the fine detail drifts from here. */
  private t0: number | null = null;
  private readonly precipitation: Precipitation;
  private readonly sound = new WeatherSound();
  /** How open to the sky the camera is (eased; 0: indoors or underwater). */
  private open = 1;
  /** Where lightning was last looked for up to (weather time s). */
  private struckTo: number | null = null;
  /** The flash lighting the sky now (0..1), and the bolt drawn. */
  private flash = 0;
  private readonly bolt: THREE.Line<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private boltLeft = 0;
  /** The ground's height under the camera (m), as last known. */
  private groundHeight = 0;
  /** How loud the surf is where the camera is (0..1: how near the shore, and how low; set by the game). */
  surf = 0;
  /** The ground's height at (x, z) (m), as far as known (null: not known: the sea's taken). */
  groundAt: (x: number, z: number) => number | null = () => null;

  constructor(atmosphere: Atmosphere) {
    this.coverTex.magFilter = this.coverTex.minFilter = THREE.LinearFilter;
    this.coverTex.wrapS = this.coverTex.wrapT = THREE.ClampToEdgeWrapping;
    this.coverTex.needsUpdate = true;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...atmosphere.uniforms,
        coverTex: { value: this.coverTex },
        coverOrigin: { value: new THREE.Vector2() },
        coverSize: { value: 1 },
        drift: { value: new THREE.Vector2() },
        detailDrift: { value: new THREE.Vector2() },
        radius: { value: 1 },
        edgeSlope: { value: 0 },
      },
      // Drawn with the sky, after it and before everything else (so the world's in front, and
      // nothing as far as the clouds is cut off by the camera's far plane): blended, but in the
      // opaque pass (transparent false, custom blending) so it's drawn in that order.
      transparent: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
          // (At the back of the depth range, like the sky: never clipped for being far.)
          gl_Position.z = gl_Position.w * 0.9999;
        }
      `,
      fragmentShader: /* glsl */ `
        ${ATMOSPHERE_GLSL}
        uniform sampler2D coverTex;
        uniform vec2 coverOrigin;
        uniform float coverSize;
        uniform vec2 drift;
        uniform vec2 detailDrift;
        uniform float radius;
        uniform float edgeSlope;
        varying vec3 vWorld;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
        }
        float fbm(vec2 p) {
          return 0.5 * noise(p) + 0.3 * noise(p * 2.13 + 7.1) + 0.2 * noise(p * 4.71 + 3.3);
        }
        void main() {
          // The weather's cover here (drifted since it was worked out), broken up by finer detail.
          float c = texture2D(coverTex, (vWorld.xz - drift - coverOrigin) / coverSize).r;
          float d = fbm((vWorld.xz - detailDrift) / 700.0);
          float density = smoothstep(0.12, 0.8, c * 1.2 + (d - 0.5) * 0.55 - 0.08);
          // (Faded out toward the layer's edge, so it has none: seen from below, by how high above the
          // horizon it is, since its outer part is squeezed into a sliver just above it.)
          float across = length(vWorld.xz - cameraPosition.xz);
          density *= 1.0 - smoothstep(0.75, 1.0, across / radius);
          if (edgeSlope > 0.0) density *= smoothstep(edgeSlope * 1.05, edgeSlope * 4.0, (vWorld.y - cameraPosition.y) / max(across, 1.0));
          if (density < 0.01) discard;
          // Lit from above by the sun and sky; thick cloud darker underneath.
          vec3 lit = sunColor * (0.35 + 0.65 * max(sunDir.y, 0.0)) + skyAmbient * 1.15;
          lit *= mix(1.05, 0.5, density * c);
          // Fading into the sky's haze with distance (its own: the view distance's haze is the ground's).
          vec3 ray = vWorld - cameraPosition;
          float far = 1.0 - exp(-length(ray) / 18000.0);
          // (And the haze and fog on the way, as far as the ground's goes before its edge fade.)
          vec3 hazedTo = cameraPosition + normalize(ray) * min(length(ray), 0.65 * viewDistance);
          gl_FragColor = vec4(applyHaze(mix(lit, hazeColor(normalize(ray)), far), hazedTo), min(0.97, density));
          #include <colorspace_fragment>
        }
      `,
    });
    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), material);
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = -9;
    this.clouds.name = 'clouds';
    this.clouds.visible = false;
    this.group.add(this.clouds);
    this.precipitation = new Precipitation(atmosphere);
    this.group.add(this.precipitation.group);
    const boltGeometry = new THREE.BufferGeometry();
    boltGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BOLT_POINTS * 3), 3));
    // (Drawn as the clouds are: behind the world, never cut off for being far.)
    this.bolt = new THREE.Line(
      boltGeometry,
      new THREE.ShaderMaterial({
        uniforms: { opacity: { value: 1 } },
        transparent: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneFactor,
        depthWrite: false,
        depthTest: false,
        vertexShader: /* glsl */ `
          void main() {
            gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
            gl_Position.z = gl_Position.w * 0.9999;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float opacity;
          void main() { gl_FragColor = vec4(0.91, 0.93, 1.0, opacity); }
        `,
      }),
    );
    this.bolt.frustumCulled = false;
    this.bolt.renderOrder = -8;
    this.bolt.visible = false;
    this.bolt.name = 'lightning';
    this.group.add(this.bolt);
  }

  /** The world's weather: its seed (see weatherSeed), its climate (null: temperate everywhere), its sea's height (m). */
  setWorld(seed: number, climate: ClimateGrid | null, seaLevel: number): void {
    this.seed = seed;
    this.climate = climate;
    this.seaLevel = seaLevel;
    this.cover = null;
    this.shown = null;
    this.struckTo = null;
  }

  /** Leaving the world: quiet, nothing shown. */
  stop(): void {
    this.seed = null;
    this.sound.stop();
    this.group.visible = false;
  }

  private climateHere(x: number, z: number): PlaceClimate {
    const c = climateAt(this.climate, x, z);
    return this.climate ? c : { ...c, seaLevel: this.seaLevel };
  }

  /** The weather shown now (eased), or null before there's a world. */
  get now(): WeatherNow | null {
    return this.shown;
  }

  /**
   * Follows the weather at the camera: `t` weather time (s, see weatherTime), `hours` of the day,
   * `ground` the height under the camera (m; null: unknown), `view` the view distance (m), `dt` s since the last,
   * `open` how open to the sky the camera is (0: indoors or underwater, 1: out), `pixelScale` the
   * canvas's height in pixels over tan(half the field of view).
   */
  update(t: number, hours: number, camera: THREE.Vector3, ground: number | null, view: number, dt: number, open: number, pixelScale: number): void {
    if (this.seed === null) return;
    this.group.visible = true;
    this.groundHeight = ground ?? Math.min(camera.y, this.groundHeight);
    const seed = this.seed;
    const here = this.climateHere(camera.x, camera.z);
    const w = weatherAt(seed, t, camera.x, camera.z, ground ?? camera.y, hours, here);
    if (!this.shown) this.shown = { ...w };
    else {
      const k = 1 - Math.exp(-dt / EASE);
      for (const key of ['cover', 'precipitation', 'snow', 'storm', 'fog', 'temperature'] as const) this.shown[key] += (w[key] - this.shown[key]) * k;
      this.shown.wind = w.wind;
    }
    // The cloud layer: as wide as the view (and some), its cover worked out again now and then.
    const radius = Math.max(8000, Math.min(30000, view * 1.6));
    const size = radius * 2;
    const c = this.cover;
    if (!c || Math.abs(camera.x - c.x) > size / 6 || Math.abs(camera.z - c.z) > size / 6 || t - c.t > 30 || Math.abs(c.size - size) > 1) this.workOutCover(t, camera.x, camera.z, size);
    this.t0 ??= t;
    const wind = prevailingWind(seed);
    const u = this.clouds.material.uniforms;
    const at = this.cover!;
    u.coverOrigin!.value.set(at.x - at.size / 2, at.z - at.size / 2);
    u.coverSize!.value = at.size;
    u.drift!.value.set(wind.x * (t - at.t), wind.z * (t - at.t));
    u.detailDrift!.value.set(wind.x * (t - this.t0), wind.z * (t - this.t0));
    u.radius!.value = radius;
    // (The slope up to the layer's edge from the camera; 0: at or above the layer.)
    u.edgeSlope!.value = Math.max(0, this.seaLevel + CLOUD_BASE - camera.y) / radius;
    this.clouds.position.set(camera.x, this.seaLevel + CLOUD_BASE, camera.z);
    this.clouds.scale.set(size, 1, size);
    this.clouds.visible = true;
    // Rain and snow, where it's open to the sky; the rain heard (muffled indoors).
    this.open += (open - this.open) * (1 - Math.exp(-dt / 0.3));
    const w2 = this.shown!;
    const falling = w2.precipitation * this.open;
    this.precipitation.update(falling * (1 - w2.snow), falling * w2.snow, w2.wind, dt, pixelScale);
    this.sound.rain(w2.precipitation * (1 - w2.snow), this.open);
    // (Rougher seas in stormy weather.)
    this.sound.surf(Math.min(1, this.surf * (0.8 + 0.5 * w2.storm + 0.2 * w2.cover)));
    this.lightning(t, camera, dt);
  }

  /** Lightning struck since the last frame: flashes (brighter nearer), a bolt for near ones, thunder to follow. */
  private lightning(t: number, camera: THREE.Vector3, dt: number): void {
    this.flash = Math.max(0, this.flash - dt / FLASH);
    if (this.boltLeft > 0) {
      this.boltLeft -= dt;
      this.bolt.material.uniforms.opacity!.value = Math.max(0, this.boltLeft / FLASH) * (0.6 + 0.4 * Math.random());
      this.bolt.visible = this.boltLeft > 0;
    }
    // (A jump: a new world, a long pause, the time moved: no burst of what was missed.)
    if (this.struckTo === null || t < this.struckTo || t - this.struckTo > 5) {
      this.struckTo = t;
      return;
    }
    const strikes = strikesBetween(this.seed!, this.struckTo, t, camera.x, camera.z, STRIKE_RADIUS, (x, z) => this.climateHere(x, z));
    this.struckTo = t;
    for (const s of strikes) {
      const ground = this.groundAt(s.x, s.z) ?? this.seaLevel;
      const distance = Math.hypot(s.x - camera.x, ground - camera.y, s.z - camera.z);
      this.flash = Math.max(this.flash, 0.12 + 0.88 * Math.max(0, 1 - distance / 7000) ** 1.5);
      if (distance < 9000) this.drawBolt(s.x, ground, s.z);
      this.sound.thunder(distance, t - s.t);
    }
  }

  /** A jagged bolt from the cloud down to (x, ground, z). */
  private drawBolt(x: number, ground: number, z: number): void {
    const top = this.seaLevel + CLOUD_BASE;
    if (top <= ground) return;
    const p = this.bolt.geometry.getAttribute('position') as THREE.BufferAttribute;
    let ox = 0, oz = 0;
    for (let i = 0; i < BOLT_POINTS; i++) {
      const f = i / (BOLT_POINTS - 1);
      if (i > 0 && i < BOLT_POINTS - 1) {
        ox += (Math.random() - 0.5) * 60;
        oz += (Math.random() - 0.5) * 60;
      } else if (i === BOLT_POINTS - 1) ox = oz = 0;
      p.setXYZ(i, x + ox * (1 - f * 0.5), top + (ground - top) * f, z + oz * (1 - f * 0.5));
    }
    p.needsUpdate = true;
    this.bolt.visible = true;
    this.boltLeft = FLASH;
    this.bolt.material.uniforms.opacity!.value = 1;
  }

  /** The cloud cover over a square `size` m across centred on (x, z), at weather time t. */
  private workOutCover(t: number, x: number, z: number, size: number): void {
    const seed = this.seed!, cell = size / COVER_CELLS;
    for (let j = 0; j < COVER_CELLS; j++)
      for (let i = 0; i < COVER_CELLS; i++) {
        const px = x - size / 2 + (i + 0.5) * cell, pz = z - size / 2 + (j + 0.5) * cell;
        const cl = this.climateHere(px, pz);
        this.coverData[i + COVER_CELLS * j] = Math.round(weatherAt(seed, t, px, pz, cl.seaLevel, 12, cl).cover * 255);
      }
    this.coverTex.needsUpdate = true;
    this.cover = { x, z, size, t };
  }

  /**
   * Weathers the light the lighting set (call after applyLighting): sun and sky dimmed and greyed
   * under cloud, the sun's disc and stars hidden, haze thickened by rain and fog.
   */
  applyTo(atmosphere: Atmosphere): void {
    const w = this.shown;
    if (!w) return;
    const u = atmosphere.uniforms;
    const overcast = Math.min(1, w.cover * 0.85 + w.precipitation * 0.25);
    u.sunColor.value.multiplyScalar(1 - 0.75 * overcast);
    u.discColor.value.multiplyScalar(1 - overcast);
    u.stars.value *= 1 - overcast;
    u.skyAmbient.value.multiplyScalar(1 - 0.3 * overcast);
    // The sky's colours toward grey, as bright as the day is (dark at night).
    for (const key of ['horizonColor', 'zenithColor', 'glowColor'] as const) {
      const c = u[key].value, lum = 0.3 * c.r + 0.59 * c.g + 0.11 * c.b;
      c.lerp(OVERCAST.clone().multiplyScalar(lum * 1.25 * (1 - 0.35 * overcast)), 0.85 * overcast);
    }
    // Rain and fog: thicker haze, hugging the ground in fog. (Fog's as thick as it is whatever the
    // view distance: half gone in FOG_HALF / fog² m (thick fog: tens of metres; rain: a km or two),
    // as thick as that at the ground here: the haze thins going up from the sea.)
    const height = 600 * (1 - 0.65 * w.fog);
    const fogHalf = FOG_HALF / Math.max(1e-3, w.fog * w.fog);
    const absolute = Math.LN2 / fogHalf + (Math.LN2 / RAIN_HALF) * w.precipitation;
    const lift = Math.exp(Math.min(4, Math.max(0, this.groundHeight - this.seaLevel) / height));
    u.hazeDensity.value = u.hazeDensity.value * (1 + 1.5 * w.precipitation) + absolute * lift;
    u.hazeHeight.value = height;
    // Lightning: the sky and everything lit by it, briefly bright and blue-white (flickering).
    if (this.flash > 0) {
      const f = this.flash * (0.55 + 0.45 * Math.random());
      u.skyAmbient.value.lerp(FLASH_LIGHT, Math.min(1, f * 0.8));
      for (const key of ['horizonColor', 'zenithColor', 'glowColor'] as const) u[key].value.lerp(FLASH_SKY, Math.min(1, f * 0.6));
    }
  }
}
