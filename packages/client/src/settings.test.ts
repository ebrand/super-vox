import { describe, expect, it } from 'vitest';
import { defaultSettings, loadSettings, parseSettings, saveSettings } from './settings.js';

/** In-memory stand-in for localStorage. */
function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), raw: m };
}

describe('settings', () => {
  it('defaults to detail 4, view 2048 m, the world tolerance, no world', () => {
    expect(defaultSettings()).toEqual({ detail: 4, view: 2048, tolerance: null, world: null });
    expect(loadSettings(memoryStorage())).toEqual(defaultSettings());
    expect(loadSettings(null)).toEqual(defaultSettings());
  });

  it('round-trips through storage', () => {
    const store = memoryStorage();
    const s = { detail: 7, view: 5000, tolerance: 0, world: 'archipelago' };
    expect(saveSettings(s, store)).toBe(true);
    expect(loadSettings(store)).toEqual(s);
  });

  it('replaces anything invalid with its default, keeping the rest', () => {
    expect(parseSettings({ detail: 99, view: 'far', tolerance: 17, world: '' })).toEqual(defaultSettings());
    expect(parseSettings({ detail: 2.5, view: 64, tolerance: 16, world: 'x' })).toEqual({ detail: 4, view: 64, tolerance: 16, world: 'x' });
    expect(parseSettings(null)).toEqual(defaultSettings());
    const store = memoryStorage();
    store.raw.set('super-vox.settings', '{ not json');
    expect(loadSettings(store)).toEqual(defaultSettings());
  });

  it('reports when the browser refuses to store them', () => {
    const refusing = { setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(saveSettings(defaultSettings(), refusing)).toBe(false);
    expect(saveSettings(defaultSettings(), null)).toBe(false);
  });
});
