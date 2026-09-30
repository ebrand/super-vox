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

## Controls

Click the view to capture the mouse; then moving the mouse looks around and
Esc releases it. (Without capturing, dragging with a mouse button also looks.) W/A/S/D move along
the ground in the direction you face, Space or E rises, Q or C descends, Shift
moves 5x faster, and the mouse wheel changes the base speed (default 2 m/s). There is no
collision yet: you can fly through terrain.

Editing has three modes; Tab cycles hybrid -> dig -> place (the overlay shows
the current one). Aim with the crosshair (reach 32 m) while the mouse is
captured.

- **hybrid** (default, Minecraft-like): click removes the voxel you aim at;
  right-click places a voxel the same size as the one you aim at against the
  face you aim at, snapped to that size so voxels stack simply. To place a
  different size, hold Command and scroll (or press `[` / `]`) before
  right-clicking; the preview shows while Command is held, and the choice
  applies to that one placement. Only the target outline
  shows. Interactive voxels (doors, TNT, ...) will hook in here later.
- **dig**: click removes the voxel you aim at. Hold Command to show the dig
  box (the selected size, just inside the surface you aim at; its entry face
  is marked on that surface); Command + click removes every voxel with any
  part inside it.
- **place**: a preview of the selected size shows against the face you aim
  at (green if it fits, red if not); click places it.

In dig and place (not hybrid), hold Option to move the box in 1/16 m steps instead of
snapping to its size; it can then cross 1 m gridlines. A placed cube that
crosses a gridline is stored as block-sized pieces (the largest standard
cubes that fit in each block), so every voxel still lies in one block; the
dig box is a region and simply removes whatever it overlaps. In every mode, middle-click breaks the aimed voxel into the next
smaller size that divides it (1 m -> 8 x 1/2 m -> 64 x 1/4 m ...), B breaks
it into the selected size, X removes it. Command + mouse wheel (or `[` and
`]`) chooses the size from the five standard sizes (1/16, 1/8, 1/4, 1/2, 1 m;
the wheel wraps), 1-3 the material (stone, dirt, grass).
The server validates and applies edits, sends changed chunks to every
connected client, and saves edited chunks under `WORLD_DATA_DIR` (default
`./data`, gitignored) so they survive restarts.

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
npm run dev:server   # http://127.0.0.1:8787 (see Terrain for settings)
npm run dev:client   # http://localhost:5173 (?detail=4&view=2048&tolerance=4; proxies /api and /ws)
npm test
npm run typecheck
npm run build
```
