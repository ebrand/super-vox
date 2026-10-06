import { Material, SPRINT, WALK_SPEED, isWater, type MaterialId } from '@super-vox/shared';

/**
 * Footsteps: a step every stride walked on the ground (80 a minute walking, 120 sprinting) (and a thump landing from a jump or a fall),
 * sounding of what's underfoot: a soft thud on earth and grass, a tap on stone, a hollow knock on
 * wood, grit on sand, a coarse crunch on gravel, a squeaky crunch on snow (or ground snow is
 * falling on), a splash wading; wet ground (after rain) squelching, with little splashes. Each step
 * made afresh (a few ms of arithmetic), never two quite alike.
 */

export type Surface = 'soft' | 'hard' | 'wood' | 'sand' | 'gravel' | 'snow' | 'water';

const SURFACES: Partial<Record<MaterialId, Surface>> = {
  [Material.Stone]: 'hard',
  [Material.Cobblestone]: 'hard',
  [Material.DarkStone]: 'hard',
  [Material.PaleStone]: 'hard',
  [Material.MossyStone]: 'hard',
  [Material.CoalOre]: 'hard',
  [Material.IronOre]: 'hard',
  [Material.Ice]: 'hard',
  [Material.DarkMetal]: 'hard',
  [Material.LightMetal]: 'hard',
  [Material.Sandstone]: 'hard',
  [Material.Shale]: 'hard',
  [Material.Limestone]: 'hard',
  [Material.Granite]: 'hard',
  [Material.Basalt]: 'hard',
  [Material.CopperOre]: 'hard',
  [Material.GoldOre]: 'hard',
  [Material.Wood]: 'wood',
  [Material.Planks]: 'wood',
  [Material.CraftingTable]: 'wood',
  [Material.FenceWood]: 'wood',
  [Material.GateWood]: 'wood',
  [Material.DoorWood]: 'wood',
  [Material.TorchWood]: 'wood',
  [Material.Sand]: 'sand',
  [Material.DesertSand]: 'sand',
  [Material.Gravel]: 'gravel',
  [Material.Snow]: 'snow',
};

/** What a step on `material` sounds like (earth, grass, leaves and the rest: soft). */
export function surfaceOf(material: MaterialId): Surface {
  if (isWater(material)) return 'water';
  return SURFACES[material] ?? 'soft';
}

/** Snow lying (see FootstepWeather): earth, grass, sand and gravel under it crunch as snow. */
export function underSnow(surface: Surface, snowCover: number): Surface {
  return snowCover > 0.3 && (surface === 'soft' || surface === 'sand' || surface === 'gravel') ? 'snow' : surface;
}

/** Steps a minute at full pace: walking, and sprinting. */
export const WALK_STEPS_PER_MINUTE = 80;
export const SPRINT_STEPS_PER_MINUTE = 120;
/** How far a step takes you (m), so that at full pace the steps come as often as that (slower, fewer). */
export const STRIDE = (WALK_SPEED * 60) / WALK_STEPS_PER_MINUTE;
export const SPRINT_STRIDE = (WALK_SPEED * SPRINT * 60) / SPRINT_STEPS_PER_MINUTE;

/** Counts strides walked: a step each (the first as soon as you set off). */
export class StepCounter {
  private since = 0;
  private moving = false;

  /** `walked` m along the ground since the last call (0: standing, or in the air); true: a step now. */
  update(walked: number, sprinting: boolean): boolean {
    if (walked <= 1e-4) {
      // (Stopped: the next step comes as soon as you move off.)
      this.moving = false;
      return false;
    }
    if (!this.moving) {
      this.moving = true;
      this.since = 0;
      return true;
    }
    this.since += walked;
    const stride = sprinting ? SPRINT_STRIDE : STRIDE;
    if (this.since < stride) return false;
    this.since -= stride;
    return true;
  }
}

/** How wet the ground is, and how much snow lies, from the weather where you are: rain wets it in half a minute, it dries in about three; snow lies in a minute or so, and melts in five. */
export class FootstepWeather {
  wet = 0;
  snowCover = 0;

  /** `rain` and `snow`: how hard each is falling here (0..1), `dt` s on. */
  update(rain: number, snow: number, dt: number): void {
    this.wet = rain > 0.1 ? Math.min(1, this.wet + (dt / 30) * rain * 2) : Math.max(0, this.wet - dt / 180);
    this.snowCover = snow > 0.1 ? Math.min(1, this.snowCover + (dt / 60) * snow * 2) : Math.max(0, this.snowCover - dt / 300);
  }
}

/** A seeded random (for tests), else Math.random. */
type Random = () => number;

/** A one-pole low-pass's coefficient for `fc` Hz at `rate`. */
const onePole = (fc: number, rate: number) => 1 - Math.exp((-2 * Math.PI * fc) / rate);

/** A band-pass (biquad, RBJ) over x, its centre swept from f0 to f1 Hz across x (in place). */
function bandpass(x: Float32Array, rate: number, f0: number, f1: number, q: number): void {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const f = f0 * (f1 / f0) ** (i / x.length), w = (2 * Math.PI * f) / rate, alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
    const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - alpha) / a0;
    const y = b0 * x[i]! + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

/** Adds into `out` at `at` s: a thud (noise low-passed at `fc` Hz), `loud`, dying over `decay` s. */
function thud(out: Float32Array, rate: number, at: number, loud: number, fc: number, decay: number, random: Random): void {
  const a = onePole(fc, rate), start = Math.floor(at * rate), len = Math.min(out.length - start, Math.floor(decay * 6 * rate));
  let lp = 0, lp2 = 0;
  for (let i = 0; i < len; i++) {
    lp += (random() * 2 - 1 - lp) * a;
    lp2 += (lp - lp2) * a;
    const env = Math.min(1, i / (0.003 * rate)) * Math.exp(-i / (decay * rate));
    out[start + i] = out[start + i]! + lp2 * env * loud * 4;
  }
}

/** Adds grains into `out` from `at` s over `span` s: `count` tiny clicks (each `grain` s), louder through the middle, band-passed `f0`..`f1` Hz. */
function grains(out: Float32Array, rate: number, at: number, span: number, count: number, grain: number, loud: number, f0: number, f1: number, random: Random): void {
  const n = Math.floor(span * rate) + Math.floor(grain * 6 * rate), x = new Float32Array(n);
  for (let k = 0; k < count; k++) {
    const t = random(), g = Math.floor(t * span * rate);
    // (Rising then falling: the snow or grit giving way under the foot.)
    const shape = Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 0.7, amp = shape * (0.3 + 0.7 * random());
    const len = Math.floor(grain * 6 * rate);
    for (let i = 0; i < len && g + i < n; i++) x[g + i] = x[g + i]! + (random() * 2 - 1) * amp * Math.exp(-i / (grain * rate));
  }
  bandpass(x, rate, f0, f1, 0.9);
  const start = Math.floor(at * rate);
  for (let i = 0; i < n && start + i < out.length; i++) out[start + i] = out[start + i]! + x[i]! * loud;
}

/** Adds a squelch into `out` at `at` s: noise through a resonance rising `f0` to `f1` Hz, over `len` s. */
function squelch(out: Float32Array, rate: number, at: number, len: number, loud: number, f0: number, f1: number, random: Random): void {
  const n = Math.floor(len * rate), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (random() * 2 - 1) * Math.sin((Math.PI * i) / n) ** 2;
  bandpass(x, rate, f0, f1, 5);
  const start = Math.floor(at * rate);
  for (let i = 0; i < n && start + i < out.length; i++) out[start + i] = out[start + i]! + x[i]! * loud * 3;
}

/**
 * A step's sound (mono, `rate` Hz) on `surface`, `wet` (0..1: how wet the ground is), `hard` (0..1:
 * how hard the foot comes down: a landing's harder): heel then toe for most, a crunch for snow and
 * gravel, a splash wading.
 */
export function stepSound(surface: Surface, wet: number, hard: number, rate: number, random: Random = Math.random): Float32Array {
  const out = new Float32Array(Math.floor(0.45 * rate));
  const v = () => 0.85 + 0.3 * random();
  const loud = (0.45 + 0.55 * hard) * v();
  // (Heel, then toe a moment later, softer.)
  const toe = 0.05 + 0.04 * random();
  switch (surface) {
    case 'soft':
      thud(out, rate, 0, 0.5 * loud, 500 * v(), 0.025, random);
      thud(out, rate, toe, 0.25 * loud, 700 * v(), 0.018, random);
      grains(out, rate, 0.01, 0.07, 14, 0.0015, 0.08 * loud, 1500, 3500, random);
      break;
    case 'hard':
      thud(out, rate, 0, 0.35 * loud, 900 * v(), 0.012, random);
      grains(out, rate, 0, 0.006, 3, 0.0008, 0.35 * loud, 2500, 5000, random);
      thud(out, rate, toe, 0.2 * loud, 1200 * v(), 0.008, random);
      grains(out, rate, toe, 0.006, 2, 0.0008, 0.2 * loud, 3000, 6000, random);
      break;
    case 'wood': {
      // A hollow knock: the board ringing low.
      thud(out, rate, 0, 0.4 * loud, 800 * v(), 0.015, random);
      const f = 160 + 120 * random();
      for (let i = 0; i < Math.floor(0.12 * rate); i++) out[i] = out[i]! + Math.sin((2 * Math.PI * f * i) / rate) * Math.exp(-i / (0.03 * rate)) * 0.25 * loud;
      thud(out, rate, toe, 0.2 * loud, 1000 * v(), 0.01, random);
      break;
    }
    case 'sand':
      thud(out, rate, 0, 0.35 * loud, 400 * v(), 0.03, random);
      grains(out, rate, 0, 0.12, 60, 0.001, 0.12 * loud, 2000, 5000, random);
      break;
    case 'gravel':
      thud(out, rate, 0, 0.3 * loud, 500 * v(), 0.02, random);
      grains(out, rate, 0, 0.14, 45, 0.0025, 0.42 * loud, 900, 3500, random);
      break;
    case 'snow':
      // A squeaky crunch: many fine grains giving way, over a muffled thud.
      thud(out, rate, 0, 0.25 * loud, 300 * v(), 0.04, random);
      grains(out, rate, 0, 0.17 + 0.05 * random(), 220, 0.0007, 0.35 * loud, 1800 * v(), 4500 * v(), random);
      break;
    case 'water':
      // A splash: a slap, then the water thrown, falling back in drops.
      thud(out, rate, 0, 0.3 * loud, 700, 0.02, random);
      grains(out, rate, 0, 0.18, 70, 0.002, 0.25 * loud, 1200, 4000, random);
      grains(out, rate, 0.12, 0.2, 12, 0.003, 0.12 * loud, 2500, 5000, random);
      return out;
  }
  if (wet > 0.05 && surface !== 'snow') {
    // Wet ground: a squelch under the foot (soft ground most), and little splashes.
    const soft = surface === 'soft' || surface === 'sand' ? 1 : 0.4;
    squelch(out, rate, 0.005, 0.09 + 0.03 * random(), 0.4 * wet * soft * loud, 450 * v(), 1300 * v(), random);
    grains(out, rate, 0.02, 0.12, Math.round(6 + 10 * wet), 0.0025, 0.2 * wet * loud, 2000, 5000, random);
  }
  return out;
}

/** A geologist's hammer on rock (mono, `rate` Hz): a sharp tick and a short, bright ring. */
export function tapSound(rate: number, random: Random = Math.random): Float32Array {
  const out = new Float32Array(Math.floor(0.25 * rate));
  grains(out, rate, 0, 0.004, 3, 0.0006, 0.5, 2500, 7000, random);
  const f = 2200 + 600 * random();
  for (let i = 0; i < Math.floor(0.2 * rate); i++) out[i] = out[i]! + Math.sin((2 * Math.PI * f * i) / rate) * Math.exp(-i / (0.035 * rate)) * 0.18;
  thud(out, rate, 0, 0.15, 1200, 0.01, random);
  return out;
}

/** Plays footsteps (see stepSound), through a limiter. Quiet until the page has been interacted with (browsers' rule). */
export class FootstepSound {
  private ctx: AudioContext | null = null;
  private out: AudioNode | null = null;
  private left = false;

  private audio(): AudioContext | null {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        const limit = this.ctx.createDynamicsCompressor();
        limit.threshold.value = -10;
        limit.ratio.value = 12;
        limit.attack.value = 0.002;
        limit.release.value = 0.15;
        const level = this.ctx.createGain();
        level.gain.value = 0.55;
        level.connect(limit).connect(this.ctx.destination);
        this.out = level;
      }
      if (this.ctx.state === 'suspended' && !document.hidden) void this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  }

  /** A step on `surface`, the ground `wet` (0..1); `hard` (0..1) how hard (a landing: harder). Left and right feet in turn. */
  step(surface: Surface, wet: number, hard = 0.4): void {
    const ctx = this.audio();
    if (!ctx || !this.out) return;
    const data = stepSound(surface, wet, hard, ctx.sampleRate);
    const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const pan = ctx.createStereoPanner();
    this.left = !this.left;
    pan.pan.value = this.left ? -0.15 : 0.15;
    src.connect(pan).connect(this.out);
    src.start();
  }

  /** A geologist's hammer's tap (see tapSound). */
  tap(): void {
    const ctx = this.audio();
    if (!ctx || !this.out) return;
    const data = tapSound(ctx.sampleRate);
    const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    src.start();
  }

  /** Quiet when the page is hidden (and back when it's shown). */
  pause(hidden: boolean): void {
    if (!this.ctx) return;
    void (hidden ? this.ctx.suspend() : this.ctx.resume());
  }
}
