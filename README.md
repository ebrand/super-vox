# super-vox

Multiplayer voxel world. Voxels range from 1/16 m to 1 m in 1/16 m steps; a
voxel can be broken into smaller voxels whose size evenly divides its own.

## Voxel rules

- A voxel never crosses a 1 m gridline: it lies entirely inside one 1 m block.
- Placed voxels may be any of the 16 sizes (1/16 m to 1 m).
- Generated terrain uses one of five sizes, the ones that tile a 1 m block:
  1/16, 1/8, 1/4, 1/2 or 1 m.

## Worlds and terrain

Each world lives in `WORLD_DATA_DIR` (default: the repository's `data/`, gitignored) under its name
(`WORLD_NAME`, default `dev`): `world.json` records the settings it was created
with, and `chunks/` holds its saved edits. The settings are only used the first
time a name is opened; after that the world always uses its saved settings (the
server warns if the environment asks for something different), so terrain never
changes under existing edits. Delete a world's folder to regenerate it.

Settings for a new world:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORLD_GENERATOR` | plates | `plates`, `noise` (old rolling hills), or `flat` |
| `WORLD_SEED` | 1 | Seed |
| `WORLD_MAJOR_PLATES` | 7 | Large tectonic plates (1..40) |
| `WORLD_MINOR_PLATES` | 12 | Small plates crowding the seams (0..100) |
| `WORLD_WATER` | 70 | Percent of the world under the sea (exact) |
| `WORLD_SHORE_FRACTAL` | 50 | Coastline raggedness, 0 (smooth) .. 100 (broken, many islands) |
| `WORLD_MOUNTAIN_HEIGHT` | 150 | Height of the tallest peaks, in metres (20..600) |
| `WORLD_MIN_VOXEL` | 1 | Smallest generated voxel, in 1/16 m units (1, 2, 4, 8, 16) |
| `WORLD_TOLERANCE` | 4 | Allowed surface error in 1/16 m units |
| `WORLD_RESOLUTION` | 16 | Voxel size for the flat generator |

**Plates**: continental plates become land and oceanic plates sea floor; where
plates collide, mountains rise along the seam (coastal ranges and offshore
trenches where ocean meets continent, island arcs between oceanic plates); where
they pull apart, rift valleys and ocean ridges form. Relief runs from -150 m to
the configured mountain height around a sea at y = 0, drawn as a translucent
plane. Sand lines the shore and sea floor, grass covers lowland, bare rock
shows on steep ground and above 60% of the peak height, and snow caps the top
20%. The plate map is built once at startup
on a 32 m grid (a few hundred ms); heights between grid points are interpolated
with small-scale roughness.

Terrain is voxelized adaptively: a 1 m block is halved (1 -> 1/2 -> 1/4 -> 1/8
-> 1/16 m) only where the surface passes through it and a coarser voxel would
misplace it by more than the tolerance.

In development (`NODE_ENV` not `production`) the client can override the
tolerance per page load with `?tolerance=N` (integer 0..16); those edits stay
in memory.

## Distant terrain

Around the camera the client renders full-detail voxel chunks within
`?detail=N` chunks (default 4). Beyond that, out to `?view=M` metres (default
2048), it renders low-detail tiles chosen by a quadtree: 32 m tiles next to
the full-detail area, doubling in size with distance up to 1 km. A tile is a
32 x 32 grid of ground heights drawn as stepped columns, with skirts along its
edges to hide cracks between levels. For full-detail chunk columns the server
reports each column's exact ground height range, so only chunk layers that
contain the surface are loaded.

Heights currently come from simple value noise (`NoiseHeights`). The voxelizer
only depends on the `HeightSource` interface, so a different source (e.g.
tectonic plates) can replace it. `WORLD_GENERATOR=flat` with
`WORLD_RESOLUTION=1|2|4|8|16` gives the original flat world.

## Layout

| Package | Role |
| --- | --- |
| `packages/shared` | Units, voxel/world math, network protocol. Used by both sides. |
| `packages/server` | Authoritative world server (Fastify + WebSocket). |
| `packages/client` | Browser renderer (Vite + Three.js). |

## Conventions

- **Units:** all server-side geometry is integer units of 1/16 m. Convert to
  meters only for rendering.
- **Axes:** X east-west, Z north-south, Y up. Chunks are 16 m (256 units).
- **Worlds:** flat worlds are bounded; round worlds wrap on X and are bounded on
  Z (poles at the Z edges). Use `normalizeX` / `deltaX` for anything that may
  cross the seam.
- **Imports:** `@super-vox/shared` resolves to TypeScript source via the
  `source` export condition in dev and tests, and to `dist/` in production.

## Commands

```sh
npm install
npm run dev          # server + client together (Ctrl+C stops both)
npm run dev:server   # http://127.0.0.1:8787 (see Terrain for settings)
npm run dev:client   # http://localhost:5173 (?detail=4&view=2048&tolerance=4; proxies /api and /ws)
npm test
npm run typecheck
npm run build
```
