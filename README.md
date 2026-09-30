# super-vox

Multiplayer voxel world. Voxels range from 1/16 m to 1 m in 1/16 m steps; a
voxel can be broken into smaller voxels whose size evenly divides its own.

## Voxel rules

- A voxel never crosses a 1 m gridline: it lies entirely inside one 1 m block.
- Placed voxels may be any of the 16 sizes (1/16 m to 1 m).
- Generated terrain uses one of five sizes, the ones that tile a 1 m block:
  1/16, 1/8, 1/4, 1/2 or 1 m (`WORLD_RESOLUTION` = 1, 2, 4, 8 or 16 units).

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
npm run dev:server   # http://127.0.0.1:8787 (WORLD_RESOLUTION=1|2|4|8|16, default 16)
npm run dev:client   # http://localhost:5173 (proxies /api and /ws to the server)
npm test
npm run typecheck
npm run build
```
