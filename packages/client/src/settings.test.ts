import { describe, expect, it } from 'vitest';
import { defaultGrass, defaultSettings, farDetailFor, loadSettings, parseSettings, returnTo, saveSettings, workersFor } from './settings.js';

/** In-memory stand-in for localStorage. */
function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), raw: m };
}

describe('settings', () => {
  it('defaults to detail 4, view 2048 m, the world tolerance, no world, medium performance, not full-screen', () => {
    expect(defaultSettings()).toEqual({ detail: 4, view: 2048, tolerance: null, world: null, performance: 'medium', fullscreen: false, grass: defaultGrass() });
    expect(defaultGrass()).toEqual({ blades: 24, height: 100, cover: 65, sway: 100, texture: true });
    expect(loadSettings(memoryStorage())).toEqual(defaultSettings());
    expect(loadSettings(null)).toEqual(defaultSettings());
  });

  it('round-trips through storage', () => {
    const store = memoryStorage();
    const s = { detail: 7, view: 5000, tolerance: 0, world: 'archipelago', performance: 'max' as const, fullscreen: true, grass: { blades: 0, height: 150, cover: 100, sway: 0, texture: false } };
    expect(saveSettings(s, store)).toBe(true);
    expect(loadSettings(store)).toEqual(s);
  });

  it('replaces anything invalid with its default, keeping the rest', () => {
    expect(parseSettings({ detail: 99, view: 'far', tolerance: 17, world: '', performance: 'turbo', fullscreen: 'yes' })).toEqual(defaultSettings());
    expect(parseSettings({ detail: 2.5, view: 64, tolerance: 16, world: 'x', performance: 'normal' })).toEqual({ detail: 4, view: 64, tolerance: 16, world: 'x', performance: 'normal', fullscreen: false, grass: defaultGrass() });
    // Grass: each bad one its default, the good ones kept (settings saved before there was grass: all defaults).
    expect(parseSettings({ grass: { blades: 49, height: 120, cover: -1, sway: 1.5, texture: 'no' } }).grass).toEqual({ ...defaultGrass(), height: 120 });
    expect(parseSettings({ performance: 'toString' }).performance).toBe('medium');
    expect(parseSettings(null)).toEqual(defaultSettings());
    const store = memoryStorage();
    store.raw.set('super-vox.settings', '{ not json');
    expect(loadSettings(store)).toEqual(defaultSettings());
  });

  it('gives 2 mesh workers at normal, half the cores at medium, all of them at max', () => {
    expect([workersFor('normal', 16), workersFor('medium', 16), workersFor('max', 16)]).toEqual([2, 8, 16]);
    expect([workersFor('normal', 6), workersFor('medium', 6), workersFor('max', 6)]).toEqual([2, 3, 6]);
    // At least one; and a guess of 4 cores when the browser won't say.
    expect([workersFor('normal', 1), workersFor('medium', 1), workersFor('max', 1)]).toEqual([1, 1, 1]);
    expect([workersFor('normal', 0), workersFor('medium', 0), workersFor('max', 0)]).toEqual([2, 2, 4]);
  });

  it('draws distant terrain coarser at normal, as the default at medium, finer at max', () => {
    expect([farDetailFor('normal'), farDetailFor('medium'), farDetailFor('max')]).toEqual([3, 4, 6]);
  });

  it('reports when the browser refuses to store them', () => {
    const refusing = { setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(saveSettings(defaultSettings(), refusing)).toBe(false);
    expect(saveSettings(defaultSettings(), null)).toBe(false);
  });
});

describe('the settings page goes back to', () => {
  it('pages of this site only', () => {
    expect(returnTo('?return=%2Fclaim.html%23world%3Dhome')).toBe('/claim.html#world=home');
    expect(returnTo('?return=%2F')).toBe('/');
    for (const bad of ['', '?return=', '?return=https%3A%2F%2Fevil.example', '?return=%2F%2Fevil.example', '?return=%2F%5Cevil.example', '?return=javascript%3Aalert(1)']) expect(returnTo(bad)).toBeNull();
  });
});
