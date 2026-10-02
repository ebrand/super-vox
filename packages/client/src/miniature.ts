import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { HorizontalTiltShiftShader } from 'three/examples/jsm/shaders/HorizontalTiltShiftShader.js';
import { HueSaturationShader } from 'three/examples/jsm/shaders/HueSaturationShader.js';
import { VerticalTiltShiftShader } from 'three/examples/jsm/shaders/VerticalTiltShiftShader.js';

/**
 * Miniature (tilt-shift): the top and bottom of the view blurred, sharp across the middle, colours
 * a little richer; none with the whole world in view, all of it from MINIATURE_FULL metres away.
 * Blur at the frame's edges (pixels, at full strength) and the extra saturation.
 */
const MINIATURE_FULL = 2500;
const MINIATURE_BLUR = 22;
const MINIATURE_SATURATION = 0.18;
/** The band across the middle that stays sharp: this far either side of the middle (fraction of the height). */
export const FOCUS_BAND = 0.15;

/**
 * How blurred a row is, `dy` (0..0.5) from the middle of the view: 0 within the sharp band,
 * growing to 0.5 at the top and bottom edges (as three.js's tilt-shift blurs at the edges).
 * The shaders below compute the same.
 */
export function focusBlur(dy: number, band = FOCUS_BAND): number {
  return (0.5 * Math.max(0, Math.abs(dy) - band)) / (0.5 - band);
}

/** The line in each of three.js's tilt-shift shaders that sets how far apart its samples are. */
export const TILT_H_LINE = /float (hh) = (h) \* abs\( r - vUv\.y \);/;
export const TILT_V_LINE = /float (vv) = (v) \* abs\( r - vUv\.y \);/;

/** One of three.js's tilt-shift passes, with a sharp band across the middle (see focusBlur). */
export function withFocusBand(shader: { uniforms: Record<string, { value: unknown }>; vertexShader: string; fragmentShader: string }, line: RegExp): typeof shader {
  const fragmentShader = shader.fragmentShader
    .replace('uniform float r;', 'uniform float r;\nuniform float band;')
    .replace(line, (m, name: string, scale: string) => `float ${name} = ${scale} * 0.5 * max( 0.0, abs( r - vUv.y ) - band ) / ( 0.5 - band );`);
  if (!fragmentShader.includes('uniform float band;') || !fragmentShader.includes('- band ) / ( 0.5 - band )')) throw new Error('tilt-shift shader changed: update withFocusBand');
  return { ...shader, uniforms: { ...THREE.UniformsUtils.clone(shader.uniforms), band: { value: FOCUS_BAND } }, fragmentShader };
}

/** How much miniature effect at a camera `distance` (m) on a world `size` m across its narrower side: 0..1. */
export function miniatureAmount(distance: number, size: number): number {
  const far = Math.max(MINIATURE_FULL * 1.5, size * 0.35);
  const t = Math.max(0, Math.min(1, (far - distance) / (far - MINIATURE_FULL)));
  return t * t * (3 - 2 * t);
}

/**
 * Draws a scene through the miniature effect: `scene` renders it (into the composer's buffer),
 * then the tilt-shift blur (across, then up and down), a little more saturation, and out to the
 * screen's colours. Multisampled.
 */
export class MiniatureEffect {
  private readonly composer: EffectComposer;
  private readonly tiltH: ShaderPass;
  private readonly tiltV: ShaderPass;
  private readonly saturate: ShaderPass;
  private width = 1;
  private height = 1;

  constructor(renderer: THREE.WebGLRenderer, scene: Pass) {
    this.composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType }));
    this.composer.addPass(scene);
    this.tiltH = new ShaderPass(withFocusBand(HorizontalTiltShiftShader, TILT_H_LINE));
    this.tiltV = new ShaderPass(withFocusBand(VerticalTiltShiftShader, TILT_V_LINE));
    for (const t of [this.tiltH, this.tiltV]) t.uniforms['r']!.value = 0.5;
    this.saturate = new ShaderPass(HueSaturationShader);
    this.composer.addPass(this.tiltH);
    this.composer.addPass(this.tiltV);
    this.composer.addPass(this.saturate);
    this.composer.addPass(new OutputPass());
  }

  /** The canvas's size (CSS pixels). */
  setSize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.composer.setSize(w, h);
  }

  /** Draws a frame with the effect at `amount` (0: none .. 1: full). */
  render(amount: number): void {
    // (The blur's step is per pass and per unit of distance from the sharp line across the middle.)
    const blur = (MINIATURE_BLUR / 2) * amount;
    this.tiltH.enabled = this.tiltV.enabled = this.saturate.enabled = amount > 0.01;
    this.tiltH.uniforms['h']!.value = blur / this.width;
    this.tiltV.uniforms['v']!.value = blur / this.height;
    this.saturate.uniforms['saturation']!.value = MINIATURE_SATURATION * amount;
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
  }
}
