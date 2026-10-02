import { describe, expect, it } from 'vitest';
import { HorizontalTiltShiftShader } from 'three/examples/jsm/shaders/HorizontalTiltShiftShader.js';
import { VerticalTiltShiftShader } from 'three/examples/jsm/shaders/VerticalTiltShiftShader.js';
import { FOCUS_BAND, TILT_H_LINE, TILT_V_LINE, focusBlur, miniatureAmount, withFocusBand } from './miniature.js';

describe('miniatureAmount', () => {
  it('is none with the whole world in view, all of it close up, and grows as you zoom in', () => {
    const world = 32_000; // a 64 x 32 km world's narrower side
    expect(miniatureAmount(30_000, world)).toBe(0);
    expect(miniatureAmount(2500, world)).toBe(1);
    expect(miniatureAmount(500, world)).toBe(1);
    let last = 0;
    for (let d = 12_000; d >= 2500; d -= 500) {
      const a = miniatureAmount(d, world);
      expect(a).toBeGreaterThanOrEqual(last);
      last = a;
    }
    // Small worlds still fade in (over 2.5 .. 3.75 km).
    expect(miniatureAmount(5000, 8000)).toBe(0);
    expect(miniatureAmount(3000, 8000)).toBeGreaterThan(0);
  });
});

describe('the miniature focus band', () => {
  it('keeps the middle sharp and blurs to the same strength at the edges', () => {
    expect(focusBlur(0)).toBe(0);
    expect(focusBlur(FOCUS_BAND)).toBe(0);
    expect(focusBlur(-FOCUS_BAND * 0.9)).toBe(0);
    expect(focusBlur(0.5)).toBeCloseTo(0.5, 12);
    expect(focusBlur(-0.5)).toBeCloseTo(0.5, 12);
    expect(focusBlur(0.4)).toBeGreaterThan(focusBlur(0.3));
  });

  it("rewrites both of three.js's tilt-shift shaders", () => {
    for (const [shader, line] of [[HorizontalTiltShiftShader, TILT_H_LINE], [VerticalTiltShiftShader, TILT_V_LINE]] as const) {
      const out = withFocusBand(shader as never, line);
      expect(out.fragmentShader).toContain('uniform float band;');
      expect(out.fragmentShader).toMatch(/= [hv] \* 0\.5 \* max\( 0\.0, abs\( r - vUv\.y \) - band \) \/ \( 0\.5 - band \);/);
      expect(out.fragmentShader).not.toMatch(line);
      expect((out.uniforms as Record<string, { value: unknown }>)['band']!.value).toBe(FOCUS_BAND);
      // The original is left alone.
      expect(shader.fragmentShader).toMatch(line);
    }
  });
});
