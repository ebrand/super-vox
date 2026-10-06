import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createAtmosphere } from './atmosphere.js';

// (No page here: the sound only listens for the page being hidden.)
vi.stubGlobal('document', { addEventListener: () => {}, hidden: true });
const { WeatherView } = await import('./weatherView.js');

describe('WeatherView', () => {
  /** The weather shown after `seconds` of frames at a spot, forced or not. */
  function settle(forced: 'rain' | 'clear' | 'snow' | null, seconds = 60) {
    const view = new WeatherView(createAtmosphere(2048));
    view.setWorld(1234, null, 0);
    view.forced = forced;
    const camera = new THREE.Vector3(100, 20, 100);
    for (let i = 0; i <= seconds * 4; i++) view.update(1e6 + i / 4, 12, camera, 18, 2048, 0.25, 1, 800);
    return view.now!;
  }

  it('?weather=rain rains where the camera is, whatever the real weather', () => {
    const w = settle('rain');
    expect(w.cover).toBeCloseTo(1, 2);
    expect(w.precipitation).toBeCloseTo(0.75, 2);
    expect(w.snow).toBeCloseTo(0, 2);
  });

  it('?weather=clear clears it, and snow snows', () => {
    const clear = settle('clear');
    expect(clear.cover).toBeCloseTo(0, 2);
    expect(clear.precipitation).toBeCloseTo(0, 2);
    expect(settle('snow').snow).toBeCloseTo(1, 2);
  });
});
