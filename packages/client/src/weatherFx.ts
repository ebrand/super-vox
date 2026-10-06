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

/** A noise loop `len` s long (stereo, each side its own): white and brown (deeper) noise mixed. */
function noiseLoop(ctx: AudioContext, len: number, white: number, brown: number): AudioBufferSourceNode {
  const buf = ctx.createBuffer(2, Math.floor(ctx.sampleRate * len), ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b = (b + 0.02 * w) / 1.02;
      d[i] = w * white + b * brown;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  return src;
}

/**
 * A loop `len` s long of raindrops landing, `perSecond` of them: each a tick (a short burst of
 * bright noise) or a plink (a short high tone), at its own loudness, placed left to right.
 */
function dropsLoop(ctx: AudioContext, len: number, perSecond: number): AudioBufferSourceNode {
  const rate = ctx.sampleRate, n = Math.floor(rate * len);
  const buf = ctx.createBuffer(2, n, rate);
  const left = buf.getChannelData(0), right = buf.getChannelData(1);
  const count = Math.round(perSecond * len);
  for (let k = 0; k < count; k++) {
    const at = Math.floor(Math.random() * n);
    // (Mostly quiet, a few loud: near drops among many further off.)
    const loud = 0.15 + 0.85 * Math.random() ** 3;
    const pan = Math.random();
    const plink = Math.random() < 0.3;
    const freq = 1800 + Math.random() * 4500, decay = (plink ? 0.012 : 0.004) + Math.random() * 0.006;
    const span = Math.floor(rate * decay * 5);
    let hp = 0, last = 0;
    for (let i = 0; i < span; i++) {
      const t = i / rate, env = Math.exp(-t / decay);
      let v: number;
      if (plink) v = Math.sin(2 * Math.PI * freq * t * (1 - 0.3 * t / decay / 5));
      else {
        // (High-passed noise: a tick, not a thud.)
        const w = Math.random() * 2 - 1;
        hp = 0.7 * (hp + w - last);
        last = w;
        v = hp;
      }
      const j = (at + i) % n, x = v * env * loud;
      left[j] = left[j]! + x * (1 - pan);
      right[j] = right[j]! + x * pan;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  return src;
}

/**
 * The weather's sound: rain (a hiss with drops landing in it, sparse and distinct in light rain,
 * dense in a downpour), surf where the sea meets land (a deep roar rising and falling as waves
 * break), thunder's crack and rumble. Quiet until the page has been interacted with (browsers' rule).
 */
export class WeatherSound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private rainNodes: { bed: GainNode; sparse: GainNode; dense: GainNode; filter: BiquadFilterNode } | null = null;
  private surfNodes: { level: GainNode; wave: GainNode; filter: BiquadFilterNode } | null = null;
  /** When the next wave breaks (AudioContext time). */
  private nextWave = 0;
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
      }
      if (this.ctx.state === 'suspended' && !document.hidden) void this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  }

  private gain(ctx: AudioContext, to: AudioNode): GainNode {
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(to);
    return g;
  }

  /** Rain this hard (0..1) falling, `open`: how open to the sky the listener is (0: indoors, muffled). */
  rain(amount: number, open: number): void {
    // (Nothing made until there's rain to hear.)
    if (amount < 0.01 && !this.rainNodes) return;
    const ctx = this.audio();
    if (!ctx || !this.master) return;
    if (!this.rainNodes) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.connect(this.master);
      const bed = this.gain(ctx, filter), sparse = this.gain(ctx, filter), dense = this.gain(ctx, filter);
      // (Loops of different lengths, so they never line up into an audible repeat.)
      const hiss = noiseLoop(ctx, 4.7, 0.5, 1.5);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 400;
      hiss.connect(hp).connect(bed);
      const sparseDrops = dropsLoop(ctx, 6.1, 25), denseDrops = dropsLoop(ctx, 5.3, 260);
      sparseDrops.connect(sparse);
      denseDrops.connect(dense);
      for (const src of [hiss, sparseDrops, denseDrops]) src.start();
      this.rainNodes = { bed, sparse, dense, filter };
    }
    const r = this.rainNodes, now = ctx.currentTime, on = amount >= 0.01 ? 1 : 0;
    const heard = on * (0.4 + 0.6 * open);
    r.bed.gain.setTargetAtTime(heard * 0.12 * amount, now, 0.4);
    r.sparse.gain.setTargetAtTime(heard * (0.35 + 0.25 * amount), now, 0.4);
    r.dense.gain.setTargetAtTime(heard * 0.45 * Math.max(0, amount - 0.25) / 0.75, now, 0.4);
    r.filter.frequency.setTargetAtTime(1300 + 8400 * open, now, 0.4);
  }

  /** Surf as loud as `amount` (0..1: how near the shore, and how low): waves breaking now and then. */
  surf(amount: number): void {
    if (amount < 0.01 && !this.surfNodes) return;
    const ctx = this.audio();
    if (!ctx || !this.master) return;
    if (!this.surfNodes) {
      const level = this.gain(ctx, this.master);
      const wave = ctx.createGain();
      wave.gain.value = 0.15;
      wave.connect(level);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 500;
      filter.connect(wave);
      const src = noiseLoop(ctx, 5.9, 0.5, 3);
      src.connect(filter);
      src.start();
      this.surfNodes = { level, wave, filter };
      this.nextWave = ctx.currentTime;
    }
    const s = this.surfNodes, now = ctx.currentTime;
    s.level.gain.setTargetAtTime(amount < 0.01 ? 0 : 0.35 * amount, now, 0.8);
    // Each wave: a rise as it breaks (the roar brightening), then a long wash dying back.
    if (amount >= 0.01 && now >= this.nextWave - 0.2) {
      const at = Math.max(now, this.nextWave), big = 0.6 + 0.4 * Math.random();
      const rise = 1.2 + Math.random() * 1.2, wash = 3 + Math.random() * 2.5;
      s.wave.gain.cancelScheduledValues(at);
      s.wave.gain.setTargetAtTime(big, at, rise / 3);
      s.wave.gain.setTargetAtTime(0.12, at + rise, wash / 3);
      s.filter.frequency.cancelScheduledValues(at);
      s.filter.frequency.setTargetAtTime(500 + 900 * big, at, rise / 3);
      s.filter.frequency.setTargetAtTime(350, at + rise, wash / 3);
      this.nextWave = at + 7 + Math.random() * 5;
    }
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
    if (!this.ctx) return;
    for (const g of [this.rainNodes?.bed, this.rainNodes?.sparse, this.rainNodes?.dense, this.surfNodes?.level]) g?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
  }
}
