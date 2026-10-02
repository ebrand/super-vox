/// <reference lib="webworker" />
import { PlateHeights, WORLD_SHAPES, findSites, migratePlateTerrain, sitePicture, type CastleSite, type SiteSearch, type WorldShape } from '@super-vox/shared';

export interface SitesRequest {
  id: number;
  /** The world's name and spec, as /api/worlds lists them. */
  world: string;
  shape: WorldShape;
  plates: unknown;
  search: SiteSearch;
}

/** Pictures: RGBA pixels, `size` x `size` (crops) or `width` x `height` (the overview). */
export type SitesResponse =
  | { id: number; type: 'progress'; text: string }
  | { id: number; type: 'result'; sites: CastleSite[]; overview: { width: number; height: number; pixels: Uint8ClampedArray } | null; crops: Uint8ClampedArray[]; cropSize: number; cropMetres: number }
  | { id: number; type: 'error'; error: string };

/** Overview width (pixels), and each site's picture: pixels and metres per pixel. */
export const OVERVIEW_WIDTH = 1000;
export const CROP_SIZE = 320;
export const CROP_METRES = 10;
const M = 16;

/** The last world built, and its overview already sent (the page keeps it). */
let built: { key: string; p: PlateHeights; overviewSent: boolean } | null = null;

const post = (res: SitesResponse, transfer: Transferable[] = []) => self.postMessage(res, transfer);

self.onmessage = (ev: MessageEvent<SitesRequest>) => {
  const { id, world: name, shape, plates, search } = ev.data;
  try {
    const world = WORLD_SHAPES[shape];
    const key = JSON.stringify([name, shape, plates]);
    if (built?.key !== key) {
      post({ id, type: 'progress', text: `building ${name}'s terrain…` });
      built = { key, p: new PlateHeights(world, migratePlateTerrain(plates)), overviewSent: false };
    }
    const p = built.p;
    let last = -1;
    const sites = findSites(p, world, search, (done) => {
      const pct = Math.floor(done * 10) * 10;
      if (pct !== last) post({ id, type: 'progress', text: `searching… ${(last = pct)}%` });
    });
    post({ id, type: 'progress', text: 'drawing maps…' });
    let overview: { width: number; height: number; pixels: Uint8ClampedArray } | null = null;
    if (!built.overviewSent) {
      const step = world.widthUnits / OVERVIEW_WIDTH, height = Math.round(world.depthUnits / step);
      overview = { width: OVERVIEW_WIDTH, height, pixels: sitePicture(p, world, world.widthUnits / 2, world.depthUnits / 2, OVERVIEW_WIDTH, height, step, 100) };
      built.overviewSent = true;
    }
    const crops = sites.map((s) => sitePicture(p, world, s.x * M, s.z * M, CROP_SIZE, CROP_SIZE, CROP_METRES * M, 20, { x: s.x * M, z: s.z * M, r: 70 * M }));
    post({ id, type: 'result', sites, overview, crops, cropSize: CROP_SIZE, cropMetres: CROP_METRES }, [...crops.map((c) => c.buffer), ...(overview ? [overview.pixels.buffer] : [])]);
  } catch (err) {
    post({ id, type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};
