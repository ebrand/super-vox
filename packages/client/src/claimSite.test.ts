import { describe, expect, it } from 'vitest';
import { SITE_PLOT, plotAround, siteOf } from './claimSite.js';

describe('a site opened in Claims', () => {
  it('is read from the hash', () => {
    expect(siteOf(new URLSearchParams('world=caves&site=7966,3482&rank=3'))).toEqual({ x: 7966, z: 3482, rank: 3 });
    expect(siteOf(new URLSearchParams('site=10.5,-2'))).toEqual({ x: 10.5, z: -2, rank: null });
    for (const bad of ['world=caves', 'site=', 'site=1', 'site=1,', 'site=a,b', 'site=1,2,3']) expect(siteOf(new URLSearchParams(bad))).toBeNull();
  });

  it('gets a plot around it, inside the world', () => {
    expect(plotAround({ x: 1000, z: 2000 }, 16384, 8192)).toEqual({ x0: 872, z0: 1872, x1: 1128, z1: 2128 });
    // Near the edges: moved in, still SITE_PLOT square.
    expect(plotAround({ x: 10, z: 8190 }, 16384, 8192)).toEqual({ x0: 0, z0: 8192 - SITE_PLOT, x1: SITE_PLOT, z1: 8192 });
    // A world smaller than that: the whole of its narrower side.
    expect(plotAround({ x: 50, z: 50 }, 100, 200)).toEqual({ x0: 0, z0: 0, x1: 100, z1: 100 });
  });
});
