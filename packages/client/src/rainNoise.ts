/**
 * Rain's and surf's noise (see weatherFx.ts): loops of noise shaped as recordings of them are, made in
 * the frequency domain. Plain arithmetic, for a worker (rainNoise.worker.ts) as well as the page.
 */

/** Octave bands' levels: [centre (Hz), level (dB, from the loudest)], lowest first. */
export type BandLevels = readonly (readonly [number, number])[];

/**
 * How rain sounds, from recordings of it (each octave band's level, dB, from the loudest; measured
 * through octave-wide band-pass filters): light rain bright and even (most around 1 to 2 kHz), heavy
 * rain a deep roar (most at 60 to 125 Hz, falling away above 1 kHz).
 */
export const CALM_RAIN: BandLevels = [[63, -4.2], [125, -4.5], [250, -3.7], [500, -1.5], [1000, -0.3], [2000, 0], [4000, -1.1], [8000, -2.2], [16000, -9.2]];
export const HEAVY_RAIN: BandLevels = [[63, 0], [125, -0.3], [250, -1.9], [500, -2.4], [1000, -2.8], [2000, -4.3], [4000, -7.9], [8000, -13.4], [16000, -24.8]];
/** Surf on a shore, from a recording of it: most around 1 to 2 kHz, little low down (the same at a wave's peak as between waves). (Set so what's made measures as the recording did.) */
export const SHORE: BandLevels = [[63, -31], [125, -23.3], [250, -13.6], [500, -3.6], [1000, 0], [2000, -0.9], [4000, -4.9], [8000, -9.8], [16000, -21]];

/** In-place FFT (radix 2; `inverse`: the other way, unscaled) of re + i im, a power of two long. */
export function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const r = re[i]!, m = im[i]!;
      re[i] = re[j]!;
      im[i] = im[j]!;
      re[j] = r;
      im[j] = m;
    }
  }
  // (The turns, worked out once: cos and sin of each step round the circle.)
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), sign = inverse ? 1 : -1;
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = sign * Math.sin((2 * Math.PI * k) / n);
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const p = i + k, q = p + half, wr = cos[k * step]!, wi = sin[k * step]!;
        const tr = re[q]! * wr - im[q]! * wi, ti = re[q]! * wi + im[q]! * wr;
        re[q] = re[p]! - tr;
        im[q] = im[p]! - ti;
        re[p] = re[p]! + tr;
        im[p] = im[p]! + ti;
      }
    }
  }
}

/** A band level table's level (dB) at `f` Hz: straight between its octaves, falling away beyond them. */
export function levelAt(table: BandLevels, f: number): number {
  const first = table[0]!, last = table[table.length - 1]!;
  if (f <= first[0]) return first[1] - 12 * Math.max(0, Math.log2(first[0] / Math.max(f, 1)) - 1);
  if (f >= last[0]) return last[1] - 24 * Math.log2(f / last[0]);
  let i = 0;
  while (table[i + 1]![0] < f) i++;
  const [f0, d0] = table[i]!, [f1, d1] = table[i + 1]!;
  return d0 + ((d1 - d0) * Math.log2(f / f0)) / Math.log2(f1 / f0);
}

/**
 * Two channels (each its own) of a seamless loop of noise `samples` long (rounded down to a power of
 * two), at `rate` Hz, whose octave bands are at the levels of `table`: each frequency at its level and
 * a random phase, turned into sound (so it repeats with no seam). RMS 1.
 */
export function shapedNoiseChannels(table: BandLevels, samples: number, rate: number): Float32Array<ArrayBuffer>[] {
  const n = 1 << Math.floor(Math.log2(samples));
  const out: Float32Array<ArrayBuffer>[] = [];
  for (let ch = 0; ch < 2; ch++) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let k = 1; k < n / 2; k++) {
      const f = (k * rate) / n;
      // (An octave band's energy grows with its width (as f): so each frequency's at its band's level less that.)
      const a = 10 ** (levelAt(table, f) / 20) / Math.sqrt(f), phase = Math.random() * 2 * Math.PI;
      re[k] = a * Math.cos(phase);
      im[k] = a * Math.sin(phase);
      re[n - k] = re[k]!;
      im[n - k] = -im[k]!;
    }
    fft(re, im, true);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += re[i]! * re[i]!;
    const scale = 1 / Math.sqrt(sum / n), d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = re[i]! * scale;
    out.push(d);
  }
  return out;
}
