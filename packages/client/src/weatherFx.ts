import * as THREE from 'three';
import { ATMOSPHERE_GLSL, type Atmosphere } from './atmosphere.js';

/**
 * What falls and what's heard in the weather (see weatherView.ts): rain as streaks and snow as
 * flakes in a box around the camera (each fixed in the world, wrapping round the box as it moves,
 * so walking through them looks right), the rain's hiss, and thunder.
 */

/** The box the rain and snow fill around the camera (m): across, and high. */
const BOX = 44;
const BOX_HIGH = 26;
const RAIN_DROPS = 14000;
const SNOW_FLAKES = 7000;
/** How fast they fall (m/s). */
const RAIN_SPEED = 9;
const SNOW_SPEED = 1.3;
/** How long a rain streak is, as time it falls in (s). */
const STREAK = 0.07;

const SHARED_GLSL = /* glsl */ `
  uniform float time;
  uniform vec3 box;
  uniform vec3 velocity;
  uniform float amount;
  attribute vec4 seed;
  // Where this one is now: fixed in the world, drifting with velocity, wrapped into the box round the camera.
  // (back: s ago, as an offset from where it is now, so a streak's two ends are never wrapped apart.)
  vec3 placed(float back) {
    vec3 corner = cameraPosition - box * 0.5;
    vec3 p = seed.xyz * box + velocity * time;
    return corner + mod(p - corner, box) - velocity * back;
  }
`;

export class Precipitation {
  readonly group = new THREE.Group();
  private readonly rain: THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly snow: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private time = 0;

  constructor(atmosphere: Atmosphere) {
    // Rain: a segment each, its two ends the same drop (one a moment behind: the streak).
    const rainSeeds = new Float32Array(RAIN_DROPS * 2 * 4), rainEnd = new Float32Array(RAIN_DROPS * 2);
    for (let i = 0; i < RAIN_DROPS; i++) {
      const s = [Math.random(), Math.random(), Math.random(), Math.random()];
      for (let e = 0; e < 2; e++) {
        rainSeeds.set(s, (i * 2 + e) * 4);
        rainEnd[i * 2 + e] = e;
      }
    }
    const rainGeometry = new THREE.BufferGeometry();
    rainGeometry.setAttribute('seed', new THREE.BufferAttribute(rainSeeds, 4));
    rainGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN_DROPS * 2 * 3), 3));
    rainGeometry.setAttribute('end', new THREE.BufferAttribute(rainEnd, 1));
    this.rain = new THREE.LineSegments(rainGeometry, this.material(atmosphere, `
      attribute float end;
      varying float vAlpha;
      varying vec3 vWorld;
      void main() {
        vec3 w = placed(end * ${STREAK.toFixed(3)});
        // (A fixed share of the drops shows: more of them the harder it rains.)
        vAlpha = seed.w < amount ? 1.0 - end * 0.7 : 0.0;
        vWorld = w;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        #include <logdepthbuf_vertex>
      }
    `, `
      varying float vAlpha;
      varying vec3 vWorld;
      void main() {
        #include <logdepthbuf_fragment>
        if (vAlpha <= 0.0) discard;
        vec3 lit = sunColor * 0.35 * max(sunDir.y, 0.0) + skyAmbient * 0.9 + 0.08;
        gl_FragColor = vec4(applyHaze(lit, vWorld), 0.5 * vAlpha);
        #include <colorspace_fragment>
      }
    `));
    // Snow: a point each, wobbling as it falls.
    const snowSeeds = new Float32Array(SNOW_FLAKES * 4);
    for (let i = 0; i < snowSeeds.length; i++) snowSeeds[i] = Math.random();
    const snowGeometry = new THREE.BufferGeometry();
    snowGeometry.setAttribute('seed', new THREE.BufferAttribute(snowSeeds, 4));
    snowGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SNOW_FLAKES * 3), 3));
    this.snow = new THREE.Points(snowGeometry, this.material(atmosphere, `
      uniform float pixelScale;
      varying float vAlpha;
      varying vec3 vWorld;
      void main() {
        vec3 w = placed(0.0);
        float phase = seed.w * 40.0 + time * (0.6 + seed.w);
        w.xz += vec2(sin(phase), cos(phase * 0.8)) * 0.35;
        vAlpha = seed.w < amount ? 1.0 : 0.0;
        vWorld = w;
        vec4 view = viewMatrix * vec4(w, 1.0);
        gl_Position = projectionMatrix * view;
        gl_PointSize = clamp(pixelScale * 0.06 / max(0.5, -view.z), 1.0, 12.0);
        #include <logdepthbuf_vertex>
      }
    `, `
      varying float vAlpha;
      varying vec3 vWorld;
      void main() {
        #include <logdepthbuf_fragment>
        vec2 d = gl_PointCoord - 0.5;
        float r = dot(d, d);
        if (vAlpha <= 0.0 || r > 0.25) discard;
        vec3 lit = sunColor * 0.45 * max(sunDir.y, 0.0) + skyAmbient * 1.1 + 0.1;
        gl_FragColor = vec4(applyHaze(lit, vWorld), 0.85 * (1.0 - r * 4.0));
        #include <colorspace_fragment>
      }
    `, { pixelScale: { value: 800 } }));
    for (const o of [this.rain, this.snow]) {
      o.frustumCulled = false;
      o.visible = false;
      o.renderOrder = 3;
      this.group.add(o);
    }
    this.rain.name = 'rain';
    this.snow.name = 'snow';
  }

  private material(atmosphere: Atmosphere, vertex: string, fragment: string, extra: Record<string, THREE.IUniform> = {}): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        ...atmosphere.uniforms,
        time: { value: 0 },
        box: { value: new THREE.Vector3(BOX, BOX_HIGH, BOX) },
        velocity: { value: new THREE.Vector3() },
        amount: { value: 0 },
        ...extra,
      },
      transparent: true,
      depthWrite: false,
      vertexShader: `#include <common>\n#include <logdepthbuf_pars_vertex>\n${SHARED_GLSL}\n${vertex}`,
      fragmentShader: `#include <logdepthbuf_pars_fragment>\n${ATMOSPHERE_GLSL}\n${fragment}`,
    });
  }

  /**
   * Shows `rain` and `snow` (0..1: how hard each falls here), blown by `wind` (m/s), `dt` s on;
   * `pixelScale`: the canvas's height in pixels over tan(half the field of view) (how big a flake looks).
   */
  update(rain: number, snow: number, wind: { x: number; z: number }, dt: number, pixelScale: number): void {
    this.time = (this.time + Math.min(dt, 1)) % 3600;
    // (Gusts carry rain less far sideways than the weather drifts; snow more.)
    this.set(this.rain, rain, new THREE.Vector3(wind.x * 0.35, -RAIN_SPEED, wind.z * 0.35));
    this.set(this.snow, snow, new THREE.Vector3(wind.x * 0.25, -SNOW_SPEED, wind.z * 0.25));
    this.snow.material.uniforms.pixelScale!.value = pixelScale;
  }

  private set(o: THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial> | THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>, amount: number, velocity: THREE.Vector3): void {
    // (A light shower shows a few: the share shown is a little ahead of how hard it falls.)
    const shown = amount < 0.02 ? 0 : Math.min(1, 0.08 + amount * 0.92);
    o.visible = shown > 0;
    const u = o.material.uniforms;
    u.amount!.value = shown;
    u.time!.value = this.time;
    u.velocity!.value.copy(velocity);
  }
}

/** The weather's sound: rain's hiss, thunder's crack and rumble. Quiet until the page has been interacted with (browsers' rule). */
export class WeatherSound {
  private ctx: AudioContext | null = null;
  private rainGain: GainNode | null = null;
  private rainFilter: BiquadFilterNode | null = null;
  private master: GainNode | null = null;
  /** Thunder still to sound (at AudioContext times): only a few at once. */
  private thunders: number[] = [];

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    });
  }

  private audio(): AudioContext | null {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
        // Rain: a loop of noise, through a low-pass (muffled indoors).
        const len = 4, buf = this.ctx.createBuffer(2, this.ctx.sampleRate * len, this.ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
          const d = buf.getChannelData(ch);
          let brown = 0;
          for (let i = 0; i < d.length; i++) {
            const white = Math.random() * 2 - 1;
            brown = (brown + 0.02 * white) / 1.02;
            d[i] = white * 0.5 + brown * 3;
          }
        }
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        this.rainFilter = this.ctx.createBiquadFilter();
        this.rainFilter.type = 'lowpass';
        this.rainFilter.frequency.value = 3500;
        this.rainGain = this.ctx.createGain();
        this.rainGain.gain.value = 0;
        src.connect(this.rainFilter).connect(this.rainGain).connect(this.master);
        src.start();
      }
      if (this.ctx.state === 'suspended' && !document.hidden) void this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  }

  /** Rain this hard (0..1) falling, `open`: how open to the sky the listener is (0: indoors, muffled). */
  rain(amount: number, open: number): void {
    // (Nothing made until there's rain to hear.)
    if (amount < 0.01 && !this.ctx) return;
    const ctx = this.audio();
    if (!ctx || !this.rainGain || !this.rainFilter) return;
    const gain = amount < 0.01 ? 0 : 0.05 + 0.3 * amount * (0.4 + 0.6 * open);
    this.rainGain.gain.setTargetAtTime(gain, ctx.currentTime, 0.4);
    this.rainFilter.frequency.setTargetAtTime(600 + 3400 * open, ctx.currentTime, 0.4);
  }

  /** Thunder from a strike `distance` m off, which flashed `ago` s ago: sounds when the sound arrives. */
  thunder(distance: number, ago: number): void {
    const ctx = this.audio();
    if (!ctx || !this.master) return;
    const at = ctx.currentTime + Math.max(0, distance / 343 - ago);
    this.thunders = this.thunders.filter((t) => t > ctx.currentTime);
    if (this.thunders.length >= 4 || distance > 15000) return;
    this.thunders.push(at + 2);
    const len = 3 + Math.min(4, distance / 2500);
    const rate = ctx.sampleRate, buf = ctx.createBuffer(1, Math.floor(rate * len), rate), d = buf.getChannelData(0);
    // A crack (near strikes) then a rumble that rolls (slow, random swells), dying away.
    const near = Math.max(0, 1 - distance / 1500);
    let swell = 0.5, target = 0.5;
    let brown = 0;
    for (let i = 0; i < d.length; i++) {
      const s = i / rate;
      if (i % Math.floor(rate * 0.12) === 0) target = 0.25 + Math.random() * 0.75;
      swell += (target - swell) * 0.0004;
      const white = Math.random() * 2 - 1;
      brown = (brown + 0.03 * white) / 1.03;
      const crack = near * Math.exp(-s / 0.08) * white;
      const rumble = brown * 6 * swell * Math.min(1, s / 0.15) * Math.exp(-s / (len * 0.35));
      d[i] = crack + rumble;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 180 + 2500 * near + 400 * Math.max(0, 1 - distance / 6000);
    const gain = ctx.createGain();
    gain.gain.value = Math.min(0.9, 0.9 * (800 / Math.max(800, distance)) ** 0.8);
    src.connect(lp).connect(gain).connect(this.master);
    src.start(at);
  }

  /** Quiet now (leaving the world). */
  stop(): void {
    if (this.rainGain && this.ctx) this.rainGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
  }
}
