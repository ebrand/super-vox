# super-vox

Multiplayer voxel world. Voxels range from 1/16 m to 1 m in 1/16 m steps; a
voxel can be broken into smaller voxels whose size evenly divides its own.

## Voxel rules

- A voxel never crosses a 1 m gridline: it lies entirely inside one 1 m block.
- Placed voxels may be any of the 16 sizes (1/16 m to 1 m).
- Generated terrain uses one of five sizes, the ones that tile a 1 m block:
  1/16, 1/8, 1/4, 1/2 or 1 m.

## Terrain

The default generator (`WORLD_GENERATOR=terrain`) voxelizes a heightmap
adaptively: a 1 m block is halved (1 → 1/2 → 1/4 → 1/8 → 1/16 m) only where
the ground surface passes through it and a coarser voxel would misplace the
surface by more than the tolerance. Flat ground on a 1 m line stays 1 m voxels.

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORLD_SEED` | 1 | Noise seed |
| `WORLD_MIN_VOXEL` | 1 | Smallest generated voxel, in 1/16 m units (1, 2, 4, 8, 16) |
| `WORLD_TOLERANCE` | 4 | Allowed surface error in 1/16 m units; voxels no larger than this are never split |

In development (`NODE_ENV` not `production`) the client can override the
tolerance per page load with `?tolerance=N` (integer 0..16), e.g.
http://localhost:5173/?tolerance=0. The overlay shows the tolerance in use and
how long the view took to settle. Production servers ignore the override.

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
npm run dev:server   # http://127.0.0.1:8787 (see Terrain for settings)
npm run dev:client   # http://localhost:5173 (proxies /api and /ws to the server)
npm test
npm run typecheck
npm run build
```
