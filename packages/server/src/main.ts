import { FLAT_WORLD_16KM, defaultFlatGen } from '@super-vox/shared';
import { buildApp } from './app.js';
import { World } from './world.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
// Generated voxel edge in 1/16 m units: 1, 2, 4, 8 or 16.
const resolution = Number(process.env.WORLD_RESOLUTION ?? 16);

const world = new World(FLAT_WORLD_16KM, defaultFlatGen(resolution));
const app = await buildApp({ world, logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port, host });
app.log.info({ resolution: world.gen.resolution }, 'flat world ready');
