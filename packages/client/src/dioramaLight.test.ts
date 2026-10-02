import { describe, expect, it } from 'vitest';
import { DEFAULT_DIORAMA_LIGHT, dioramaLighting, parseDioramaLight } from './dioramaLight.js';

describe('dioramaLighting', () => {
  it('puts the sun at its height, in its compass direction', () => {
    const at = (height: number, from: number) => dioramaLighting({ ...DEFAULT_DIORAMA_LIGHT, height, from }).sunDir;
    expect(at(90, 0).y).toBeCloseTo(1, 9);
    const south = at(0.0001, 180);
    expect(south.z).toBeCloseTo(1, 4); // south is +Z
    const east = at(30, 90);
    expect(east.x).toBeCloseTo(Math.cos(Math.PI / 6), 9);
    expect(east.y).toBeCloseTo(0.5, 9);
    expect(at(22, 225).length()).toBeCloseTo(1, 9);
  });

  it('warms the sun toward gold, and shade scales the sky and ground light', () => {
    const white = dioramaLighting({ ...DEFAULT_DIORAMA_LIGHT, warmth: 0 }).sunColor, gold = dioramaLighting({ ...DEFAULT_DIORAMA_LIGHT, warmth: 1 }).sunColor;
    expect([white.r, white.g, white.b]).toEqual([1.1, 1.1, 1.1].map((v) => expect.closeTo(v, 9)));
    expect(gold.b).toBeLessThan(gold.g);
    expect(gold.g).toBeLessThan(gold.r);
    const half = dioramaLighting({ ...DEFAULT_DIORAMA_LIGHT, shade: 0.5 }), none = dioramaLighting({ ...DEFAULT_DIORAMA_LIGHT, shade: 0 });
    expect(half.sky.r).toBeCloseTo(0.24, 9); // the game's sky light
    expect(none.sky.getHex()).toBe(0);
  });
});

describe('parseDioramaLight', () => {
  it('keeps good settings and defaults the rest', () => {
    expect(parseDioramaLight({ height: 40, from: 90, warmth: 0.2, shade: 0.8 })).toEqual({ height: 40, from: 90, warmth: 0.2, shade: 0.8 });
    expect(parseDioramaLight({ height: 400, from: 'west', warmth: 0.2 })).toEqual({ ...DEFAULT_DIORAMA_LIGHT, warmth: 0.2 });
    expect(parseDioramaLight(null)).toEqual(DEFAULT_DIORAMA_LIGHT);
  });
});
