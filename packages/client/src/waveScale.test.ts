import { describe, expect, it } from 'vitest';
import { waveScaleAt } from './diorama.js';
import { waterUniforms } from './water.js';
import { createAtmosphere } from './atmosphere.js';

describe('waveScaleAt', () => {
  it('is the game scale up close and swells as the camera pulls back, up to 40x', () => {
    expect(waveScaleAt(10)).toBe(1);
    expect(waveScaleAt(60)).toBe(1);
    expect(waveScaleAt(600)).toBe(10);
    expect(waveScaleAt(1e6)).toBe(40);
  });

  it("leaves the game's water at its own scale", () => {
    expect(waterUniforms(createAtmosphere(1000)).waveScale.value).toBe(1);
  });
});
