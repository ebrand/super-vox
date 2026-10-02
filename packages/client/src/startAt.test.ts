import { describe, expect, it } from 'vitest';
import { rememberReturn, startFromParams, takeReturn } from './startAt.js';

const round = { widthUnits: 64000 * 16, depthUnits: 32000 * 16, wrapX: true };
const flat = { widthUnits: 16000 * 16, depthUnits: 16000 * 16, wrapX: false };
const at = (q: string, w = round) => startFromParams(new URLSearchParams(q), w);

describe('startFromParams', () => {
  it('reads x and z in metres (and y if given), as units', () => {
    expect(at('world=cartesian&x=10104&z=14184')).toEqual({ x: 10104 * 16, z: 14184 * 16, y: null });
    expect(at('x=12.5&z=3&y=165')).toEqual({ x: 200, z: 48, y: 165 * 16 });
  });

  it('needs both x and z, as numbers', () => {
    for (const q of ['', 'x=5', 'z=5', 'x=&z=5', 'x=abc&z=5', 'x=5&z=Infinity']) expect(at(q), q).toBeNull();
    // A bad y is ignored (looked up instead).
    expect(at('x=5&z=5&y=high')).toEqual({ x: 80, z: 80, y: null });
  });

  it('wraps x on round worlds, clamps it on flat ones, and keeps z inside', () => {
    expect(at('x=65000&z=100')!.x).toBe(1000 * 16);
    expect(at('x=-1000&z=100')!.x).toBe(63000 * 16);
    expect(at('x=-5&z=-5', flat)).toEqual({ x: 0, z: 0, y: null });
    expect(at('x=99999&z=99999', flat)).toEqual({ x: 16000 * 16 - 1, z: 16000 * 16 - 1, y: null });
  });
});

describe('rememberReturn / takeReturn', () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  it('comes back to the same world, once, within a minute', () => {
    const s = store();
    rememberReturn(s, 'isle', 1200.5, -30, 1000);
    expect(takeReturn(s, 'isle', 30_000)).toEqual({ x: 1200.5, z: -30 });
    expect(takeReturn(s, 'isle', 30_000)).toBeNull();
    rememberReturn(s, undefined, 5, 6, 1000);
    expect(takeReturn(s, undefined, 2000)).toEqual({ x: 5, z: 6 });
  });
  it('ignores another world, a stale or broken note, and missing storage', () => {
    const s = store();
    rememberReturn(s, 'isle', 1, 2, 1000);
    expect(takeReturn(s, 'other', 2000)).toBeNull();
    rememberReturn(s, 'isle', 1, 2, 1000);
    expect(takeReturn(s, 'isle', 62_000)).toBeNull();
    s.setItem('super-vox.return', '{not json');
    expect(takeReturn(s, 'isle')).toBeNull();
    expect(takeReturn(null, 'isle')).toBeNull();
    expect(() => rememberReturn(null, 'isle', 1, 2)).not.toThrow();
  });
});
