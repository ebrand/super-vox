import { describe, expect, it } from 'vitest';
import { PlateHeights, defaultPlateTerrain } from './plates.js';
import { DEFAULT_SITE_SEARCH, findSites, sitePicture, validateSiteSearch, type SiteSearch } from './sites.js';
import { FLAT_WORLD_16KM } from './world.js';

const p = new PlateHeights(FLAT_WORLD_16KM, { ...defaultPlateTerrain(9), rivers: 60, lakes: 30 });
const search = (over: Partial<SiteSearch> = {}) => findSites(p, FLAT_WORLD_16KM, { ...DEFAULT_SITE_SEARCH, ...over });

describe('findSites', () => {
  const sites = search();

  it('finds hilltops in the height band, near water, best first and spaced apart', () => {
    expect(sites.length).toBeGreaterThan(3);
    expect(sites.length).toBeLessThanOrEqual(DEFAULT_SITE_SEARCH.count);
    sites.forEach((s, i) => {
      expect(s.rank).toBe(i + 1);
      if (i > 0) expect(s.score).toBeLessThanOrEqual(sites[i - 1]!.score);
      // The site's ground is in the band (the grid cell's centre, so within a metre or two).
      expect(s.y).toBeGreaterThanOrEqual(DEFAULT_SITE_SEARCH.minHeight - 3);
      expect(s.y).toBeLessThanOrEqual(DEFAULT_SITE_SEARCH.maxHeight + 3);
      expect(s.water.kind).toBe('river');
      expect(s.water.metres).toBeLessThanOrEqual(DEFAULT_SITE_SEARCH.waterWithin);
      expect(s.steepSides).toBeGreaterThanOrEqual(6);
      expect(s.drop320).toBeGreaterThanOrEqual(30);
      for (const t of sites.slice(0, i)) expect(Math.hypot(t.x - s.x, t.z - s.z)).toBeGreaterThanOrEqual(DEFAULT_SITE_SEARCH.spacing - 16);
    });
  });

  it('is a hilltop: no ground within 320 m much higher than the site', () => {
    for (const s of sites.slice(0, 4)) {
      const h = p.heights((s.x - 320) * 16, (s.z - 320) * 16, 41, 41, 16 * 16);
      expect(Math.max(...h) / 16 - p.seaLevel / 16).toBeLessThan(s.y + 12);
    }
  });

  it('follows the settings: a narrower band, more sites, lakes too', () => {
    for (const s of search({ minHeight: 100, maxHeight: 150 })) expect(s.y).toBeGreaterThanOrEqual(97), expect(s.y).toBeLessThanOrEqual(153);
    expect(search({ count: 3 })).toEqual(sites.slice(0, 3));
    const any = search({ water: 'any', count: 50 }), rivers = search({ count: 50 });
    expect(any.length).toBeGreaterThanOrEqual(rivers.length);
    expect(search({ steepDrop: 200 })).toEqual([]);
  });

  it('is deterministic', () => {
    expect(search()).toEqual(sites);
  });

  it('refuses settings out of range', () => {
    expect(() => validateSiteSearch({ ...DEFAULT_SITE_SEARCH, minHeight: 300, maxHeight: 200 })).toThrow(/minHeight/);
    expect(() => validateSiteSearch({ ...DEFAULT_SITE_SEARCH, count: 0 })).toThrow(/count/);
    expect(() => validateSiteSearch({ ...DEFAULT_SITE_SEARCH, water: 'sea' as 'river' })).toThrow(/water/);
  });
});

describe('sitePicture', () => {
  it('draws w x d opaque pixels, with the ring in red', () => {
    const px = sitePicture(p, FLAT_WORLD_16KM, 8000 * 16, 8000 * 16, 64, 64, 8 * 16, 20, { x: 8000 * 16, z: 8000 * 16, r: 100 * 16 });
    expect(px.length).toBe(64 * 64 * 4);
    for (let k = 3; k < px.length; k += 4) expect(px[k]).toBe(255);
    // 100 m out (12.5 pixels) from the centre: red.
    const k = (32 + 12 + 64 * 32) * 4;
    expect([px[k], px[k + 1], px[k + 2]]).toEqual([230, 30, 30]);
  });
});
