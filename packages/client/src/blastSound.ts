/**
 * The sound of a blast (TNT, C4): heard later the farther it is (sound goes about 343 m a second),
 * quieter and duller with distance, and bigger blasts far bigger: a crack, a deep punch, a roar
 * darkening as it dies, a long rumble, and for big ones an echo. See blastSoundPlan for the numbers.
 */

/** The smallest and biggest blasts (radius, m): a 1/8 m C4 voxel, and the most (see MAX_BLAST_RADIUS). */
const SMALLEST = 2.3;
const BIGGEST = 16;

/** How a blast `radius` m across, `distance` m off, sounds: each layer's loudness (0..1) and timing (s), and its tone (Hz). */
export interface BlastSoundPlan {
  /** When it's heard (s from now): the sound's travel time. */
  delay: number;
  /** How big it is (0: the smallest, 1: the biggest). */
  size: number;
  /** How loud it all is here. */
  loud: number;
  /** The first sharp crack: loudness, and how long it rings (s). */
  crack: number;
  crackDecay: number;
  /** The punch: a thump falling from `punchFrom` to `punchTo` Hz over `punchFall` s, dying over `punchDecay` s. */
  punch: number;
  punchFrom: number;
  punchTo: number;
  punchFall: number;
  punchDecay: number;
  /** The roar: noise starting this bright (Hz), darkening, dying over `roarDecay` s. */
  roar: number;
  roarBright: number;
  roarDecay: number;
  /** The rumble after it: dying over `rumbleDecay` s. */
  rumble: number;
  rumbleDecay: number;
  /** An echo off the land around (0: none), coming back after `echoDelay` s. */
  echo: number;
  echoDelay: number;
  /** Distance takes the top off (Hz: nothing above this much reaches here). */
  muffle: number;
  /** How long it all lasts (s, from when it's heard). */
  length: number;
}

export function blastSoundPlan(distance: number, radius: number): BlastSoundPlan {
  const size = Math.max(0, Math.min(1, (radius - SMALLEST) / (BIGGEST - SMALLEST)));
  // Loud for its size, falling off with distance (beyond about two radii; a little gentler than 1/d,
  // so far blasts are still heard).
  const near = Math.max(4, radius * 2);
  const loud = (0.45 + 0.55 * size) * Math.min(1, (near / Math.max(near, distance)) ** 0.85);
  const far = Math.max(0, distance - near);
  const muffle = Math.max(250, 16000 / (1 + far / 60));
  const crackDecay = 0.006 + 0.01 * size, punchDecay = 0.25 + 0.9 * size, roarDecay = 0.25 + 1.0 * size, rumbleDecay = 0.7 + 2.8 * size;
  return {
    delay: distance / 343,
    size,
    loud,
    // (The crack's highs are the first thing distance takes away.)
    crack: (0.7 + 0.3 * size) * Math.min(1, muffle / 4000) ** 2,
    crackDecay,
    punch: 0.6 + 0.4 * size,
    punchFrom: 140 - 60 * size,
    punchTo: 38 - 10 * size,
    punchFall: 0.12 + 0.3 * size,
    punchDecay,
    roar: 0.7 + 0.3 * size,
    roarBright: Math.min(muffle, 2500 + 3500 * size),
    roarDecay,
    rumble: 0.15 + 0.55 * size,
    rumbleDecay,
    echo: size < 0.3 ? 0 : 0.18 + 0.2 * size,
    echoDelay: 0.35 + 0.5 * size,
    muffle,
    length: Math.max(punchDecay, roarDecay, rumbleDecay) * 5 + (size < 0.3 ? 0 : 1.5),
  };
}

/** Noise buffers, made once per AudioContext: white and brown (deeper), 6 s each. */
const noises = new WeakMap<BaseAudioContext, { white: AudioBuffer; brown: AudioBuffer }>();
function noiseFor(ctx: BaseAudioContext): { white: AudioBuffer; brown: AudioBuffer } {
  let n = noises.get(ctx);
  if (!n) {
    const len = Math.floor(ctx.sampleRate * 6);
    const white = ctx.createBuffer(1, len, ctx.sampleRate), brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = white.getChannelData(0), b = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      w[i] = Math.random() * 2 - 1;
      last = (last + 0.02 * w[i]!) / 1.02;
      b[i] = last * 3.5;
    }
    n = { white, brown };
    noises.set(ctx, n);
  }
  return n;
}

/** A soft clip (tanh): grit on the punch, so it's heard on small speakers too. */
let clipCurve: Float32Array<ArrayBuffer> | null = null;
function softClip(): Float32Array<ArrayBuffer> {
  if (!clipCurve) {
    clipCurve = new Float32Array(1024);
    for (let i = 0; i < clipCurve.length; i++) clipCurve[i] = Math.tanh(((i / (clipCurve.length - 1)) * 2 - 1) * 2.5);
  }
  return clipCurve;
}

/** Plays a blast `distance` m off of `radius` m into `out` on `ctx` (see blastSoundPlan). */
export function playBlast(ctx: BaseAudioContext, out: AudioNode, distance: number, radius: number): void {
  const p = blastSoundPlan(distance, radius);
  const at = ctx.currentTime + p.delay, end = at + p.length;
  const { white, brown } = noiseFor(ctx);
  // Everything through the distance's muffling, then (big ones) an echo, then out.
  const muffle = ctx.createBiquadFilter();
  muffle.type = 'lowpass';
  muffle.frequency.value = p.muffle;
  const all = ctx.createGain();
  all.gain.value = p.loud;
  muffle.connect(all).connect(out);
  if (p.echo > 0) {
    const delay = ctx.createDelay(2), back = ctx.createGain(), dull = ctx.createBiquadFilter();
    delay.delayTime.value = p.echoDelay;
    back.gain.value = p.echo;
    dull.type = 'lowpass';
    dull.frequency.value = 700;
    // (Each echo duller and quieter than the last.)
    all.connect(delay).connect(dull).connect(back).connect(delay);
    back.connect(out);
  }
  const noise = (buffer: AudioBuffer) => {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.start(at, Math.random() * 2, p.length);
    return src;
  };
  const envelope = (peak: number, attack: number, decay: number) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + attack);
    g.gain.setTargetAtTime(0, at + attack, decay);
    return g;
  };
  // The crack: bright noise, gone in a few hundredths of a second.
  const crackHp = ctx.createBiquadFilter();
  crackHp.type = 'highpass';
  crackHp.frequency.value = 1200;
  noise(white).connect(crackHp).connect(envelope(p.crack, 0.001, p.crackDecay)).connect(muffle);
  // The punch: a sine falling in pitch, soft-clipped for grit.
  const thump = ctx.createOscillator();
  thump.frequency.setValueAtTime(p.punchFrom, at);
  thump.frequency.exponentialRampToValueAtTime(p.punchTo, at + p.punchFall);
  const clip = ctx.createWaveShaper();
  clip.curve = softClip();
  thump.connect(envelope(p.punch * 1.6, 0.004, p.punchDecay)).connect(clip).connect(muffle);
  thump.start(at);
  thump.stop(end);
  // The roar: noise through a low-pass closing from bright to dark.
  const roarLp = ctx.createBiquadFilter();
  roarLp.type = 'lowpass';
  roarLp.frequency.setValueAtTime(p.roarBright, at);
  roarLp.frequency.exponentialRampToValueAtTime(90, at + p.roarDecay * 3);
  noise(white).connect(roarLp).connect(envelope(p.roar, 0.006, p.roarDecay)).connect(muffle);
  // The rumble: deep noise, rising a moment late and lasting.
  const rumbleLp = ctx.createBiquadFilter();
  rumbleLp.type = 'lowpass';
  rumbleLp.frequency.value = 220;
  noise(brown).connect(rumbleLp).connect(envelope(p.rumble, 0.08 + 0.15 * p.size, p.rumbleDecay)).connect(muffle);
}
