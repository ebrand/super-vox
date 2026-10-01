/// <reference lib="webworker" />
import { WORLD_SHAPES, type PlateTerrainConfig, type WorldShape } from '@super-vox/shared';
import { buildPreview, type Preview } from './generatorPreview.js';

export interface PreviewRequest {
  id: number;
  config: PlateTerrainConfig;
  size: number;
  shape: WorldShape;
}

export type PreviewResponse = { id: number; ok: true; preview: Preview } | { id: number; ok: false; error: string };

self.onmessage = (ev: MessageEvent<PreviewRequest>) => {
  const { id, config, size, shape } = ev.data;
  let res: PreviewResponse;
  try {
    res = { id, ok: true, preview: buildPreview(config, size, WORLD_SHAPES[shape]) };
  } catch (err) {
    res = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const transfer = res.ok ? [res.preview.map.heights.buffer, res.preview.map.materials.buffer, res.preview.plateOf.buffer, ...(res.preview.biome ? [res.preview.biome.buffer] : [])] : [];
  self.postMessage(res, transfer);
};
