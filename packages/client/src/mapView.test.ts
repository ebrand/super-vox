import { describe, expect, it } from 'vitest';
import { MAX_SCALE, TILE, clampView, detailTiles, fitView, niceLength, pan, screenToWorld, zoomAt } from './mapView.js';

const round = { width: 64_000 * 16, depth: 32_000 * 16, wrapX: true };
const flat = { width: 16_000 * 16, depth: 16_000 * 16, wrapX: false };
const W = 1000, H = 500;

describe('map view', () => {
  it('fits the whole world, and finds world points on screen', () => {
    const v = fitView(round, W, H);
    expect(v).toEqual({ cx: round.width / 2, cz: round.depth / 2, scale: W / round.width });
    expect(screenToWorld(v, W, H, 0, 0)).toEqual([0, 0]);
    expect(screenToWorld(v, W, H, W, H)).toEqual([round.width, round.depth]);
  });

  it('zooms about the cursor: the point under it stays put', () => {
    const v = fitView(round, W, H);
    const before = screenToWorld(v, W, H, 700, 300);
    const z = zoomAt(v, round, W, H, 700, 300, 8);
    expect(z.scale).toBeCloseTo(v.scale * 8);
    const after = screenToWorld(z, W, H, 700, 300);
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
    // Never further out than the whole world, nor closer than MAX_SCALE.
    expect(zoomAt(v, round, W, H, 0, 0, 0.1).scale).toBe(v.scale);
    expect(zoomAt(v, round, W, H, 0, 0, 1e9).scale).toBe(MAX_SCALE);
  });

  it("pans, wrapping round worlds east-west but never past a flat world's edges or the poles", () => {
    const z = zoomAt(fitView(round, W, H), round, W, H, W / 2, H / 2, 10);
    const east = pan(z, round, W, H, -1e6, 0); // a long drag west: the view moves east
    expect(east.cx).toBeGreaterThanOrEqual(0);
    expect(east.cx).toBeLessThan(round.width);
    const north = pan(z, round, W, H, 0, 1e6); // drag down: the view moves north
    expect(north.cz).toBeCloseTo(H / 2 / z.scale); // the top of the frame at the world's north edge
    const f = zoomAt(fitView(flat, W, H), flat, W, H, W / 2, H / 2, 4);
    expect(pan(f, flat, W, H, 1e6, 0).cx).toBeCloseTo(W / 2 / f.scale); // west edge
    // Zoomed out fully: centred.
    expect(clampView({ cx: 5, cz: 5, scale: 0 }, flat, W, H)).toEqual({ cx: flat.width / 2, cz: flat.depth / 2, scale: fitView(flat, W, H).scale });
  });

  it('covers the view with shared tiles at about one sample per pixel, only when sharper than the whole map', () => {
    const baseStep = round.width / 1024; // ~62 m
    expect(detailTiles(fitView(round, W, H), round, W, H, baseStep)).toBeNull();
    const z = zoomAt(fitView(round, W, H), round, W, H, W / 2, H / 2, 32); // 32 units (2 m) per pixel
    const d = detailTiles(z, round, W, H, baseStep)!;
    expect(d.step).toBe(32);
    const size = TILE * d.step;
    for (const t of d.tiles) {
      expect(t.x0 % size).toBe(0);
      expect(t.z0 % size).toBe(0);
    }
    // Every visible point is in a tile.
    const [l, t] = screenToWorld(z, W, H, 0, 0), [r, b] = screenToWorld(z, W, H, W, H);
    for (const [x, zz] of [[l, t], [r - 1, b - 1], [(l + r) / 2, (t + b) / 2]] as const) {
      expect(d.tiles.some((q) => x >= q.x0 && x < q.x0 + size && zz >= q.z0 && zz < q.z0 + size)).toBe(true);
    }
    // The middle first.
    const mid = d.tiles[0]!;
    expect(z.cx >= mid.x0 - size && z.cx <= mid.x0 + 2 * size).toBe(true);
    // At the seam of a round world: tiles past it, for drawing there.
    const seam = { ...z, cx: 100 };
    expect(detailTiles(seam, round, W, H, baseStep)!.tiles.some((q) => q.x0 < 0)).toBe(true);
  });

  it('picks round lengths for the scale bar', () => {
    expect(niceLength(1500 * 16)).toBe(1000 * 16);
    expect(niceLength(300 * 16)).toBe(200 * 16);
    expect(niceLength(60 * 16)).toBe(50 * 16);
    expect(niceLength(7 * 16)).toBe(5 * 16);
  });
});
