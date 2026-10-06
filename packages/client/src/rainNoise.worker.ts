import { shapedNoiseChannels, type BandLevels } from './rainNoise.js';

/** Makes rain's noise loops off the page (see shapedNoiseLater): slow enough to stall a frame. */
self.onmessage = (e: MessageEvent<{ id: number; table: BandLevels; samples: number; rate: number }>) => {
  const { id, table, samples, rate } = e.data;
  const channels = shapedNoiseChannels(table, samples, rate);
  (self as unknown as Worker).postMessage({ id, channels }, channels.map((c) => c.buffer));
};
