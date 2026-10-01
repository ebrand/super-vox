# super-vox

Multiplayer voxel world. Voxels range from 1/16 m to 1 m in 1/16 m steps; a
voxel can be broken into smaller voxels whose size evenly divides its own.

## Pages

- `/`: pick a world and play it, change settings, or open the world generator.
- `/play.html?world=name`: the game. **Menu** (top right, after Esc frees the mouse) goes back.
- `/generator.html`: the world generator (see below).

**Settings** (the Settings dialog on `/`, kept in this browser until there are accounts):
detail distance (full-detail radius in 16 m chunks, default 4), view distance (default 2048 m)
and terrain tolerance (the world's own by default; development servers only). URL parameters on
the game page override them for one visit: `?detail=N`, `?view=M`, `?tolerance=N`.

## Voxel rules

- A voxel never crosses a 1 m gridline: it lies entirely inside one 1 m block.
- Placed voxels may be any of the 16 sizes (1/16 m to 1 m).
- Generated terrain uses one of five sizes, the ones that tile a 1 m block:
  1/16, 1/8, 1/4, 1/2 or 1 m.

## Worlds and terrain

Each world lives in `WORLD_DATA_DIR` (default: the repository's `data/`, gitignored) under its
name: `world.json` records the settings it was created with, and `chunks/` holds its saved
edits. A world's settings never change after it is created, so terrain never changes under
existing edits. Delete a world's folder to regenerate it.

The server serves every world in the data folder; `WORLD_NAME` (default `dev`) is the default
one, created from the `WORLD_*` settings below if it doesn't exist yet (the server warns if the
environment asks for something different from an existing world). Open another world with
`?world=name`, e.g. http://localhost:5173/play.html?world=archipelago.

**World generator**: http://localhost:5173/generator.html previews a plate world as you change
its settings (the preview is exactly the terrain the world gets), shows plate borders or plate
colours (minor plates hatched), and creates a named world from the settings. It also lists the
server's worlds: **Load** puts a world's settings in the form to change and **Save to it**
(which regenerates its terrain and discards its edits: they're snapshots of chunks of the old
terrain), **Delete** removes a world (not the server's default one), **Play** opens it. Anyone
playing a world that is regenerated or deleted is disconnected with a message. Settings are kept
in the page URL, so a link reproduces a preview. Creating, changing and deleting worlds
(`POST /api/worlds`, `PUT` and `DELETE /api/worlds/:name`) is only enabled in development
(`NODE_ENV` not `production`) until there are accounts.

Settings for a new world from the environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORLD_GENERATOR` | plates | `plates`, `noise` (old rolling hills), or `flat` |
| `WORLD_SEED` | 1 | Plate layout: positions, sizes, which plates are continents |
| `WORLD_TERRAIN_SEED` | = seed | Each plate's noise; change it to reroll the relief and keep the plates |
| `WORLD_MAJOR_PLATES` | 7 | Large plates (1..40) |
| `WORLD_MINOR_PLATES` | 15 | Small plates along the seams between major plates (0..100) |
| `WORLD_PLATE_SIZE_RATIO` | 6 | Area of a major plate over a minor one (1..50) |
| `WORLD_LAND` | 30 | Percent of the world above the sea (exact); the rest is sea |
| `WORLD_SEA_LEVEL` | 0 | Sea surface, in metres |
| `WORLD_MAX_HEIGHT` | 300 | Highest land outside mountain ranges, in metres (-1000..1000, above the sea) |
| `WORLD_MOUNTAINS` | 50 | Percent of converging plate seams that raise mountain ranges (0 = none) |
| `WORLD_MOUNTAIN_HEIGHT` | 600 | Highest mountain peak, in metres (at least `WORLD_MAX_HEIGHT`) |
| `WORLD_MOUNTAIN_WIDTH` | 2500 | Width of a mountain range, in metres (500..8000) |
| `WORLD_MOUNTAIN_RUGGEDNESS` | 60 | 0 (rounded massifs) .. 100 (sharp ridges) |
| `WORLD_MOUNTAIN_DETAIL` | 50 | Gullies, spurs and crags on mountain sides (16-256 m), 0 .. 100 |
| `WORLD_MIN_HEIGHT` | -300 | Deepest sea floor, in metres (-1000..1000, below the sea) |
| `WORLD_SHORE_FRACTAL` | 50 | Coastline raggedness, 0 (smooth) .. 100 (broken, many islands) |
| `WORLD_BEACHES` | 50 | Sand on gentle coasts, 0 (none above the water) .. 100 (wide); steep coasts stay rocky |
| `WORLD_ROCK_ALTITUDE` | 180 | Without biomes: bare rock from this height above the sea, in metres |
| `WORLD_SNOW_ALTITUDE` | 240 | Without biomes: snow from this height above the sea, in metres (lower land has none) |
| `WORLD_SNOW_FRACTAL` | 50 | How ragged the snow line is: 0 (a contour) .. 100 (wandering ±60 m, at scales from 1 km to 16 m) |
| `WORLD_ROCK_SLOPE` | 25 | Ground steeper than this many degrees is bare rock, even above the snow (90 = never) |
| `WORLD_NOISE_SCALE` | 2000 | Size of the largest features in each plate's noise, in metres (100..16000) |
| `WORLD_NOISE_ROUGHNESS` | 50 | Fine detail in each plate's noise, 0 (smooth swells) .. 100 (rugged) |
| `WORLD_PLAINS` | 0 | Percent of the land that is plains: broad, nearly flat lowlands |
| `WORLD_LOWLAND_FLATNESS` | 0 | Flatter low ground and a steeper climb near the peaks, 0 .. 100 |
| `WORLD_SURFACE_ROUGHNESS` | 50 | Small-scale bumpiness of the ground, 0 (smooth) .. 100 |
| `WORLD_BIOMES` | 1 | Biomes from climate (1) or grass everywhere (0) |
| `WORLD_NORTH_TEMPERATURE` | -6 | Sea-level temperature at the north edge, degrees C |
| `WORLD_SOUTH_TEMPERATURE` | 26 | Sea-level temperature at the south edge, degrees C |
| `WORLD_ALTITUDE_COOLING` | 1.5 | Degrees C colder per 100 m of height |
| `WORLD_RAINFALL` | 50 | How wet the land is, 0 (dry) .. 100 (soaked) |
| `WORLD_WIND_FROM` | 270 | Compass direction rain comes from (270 = west); land behind mountains is drier |
| `WORLD_TREES` | 50 | Forest density: 0 (none), 50 (natural for each biome), 100 (double) |
| `WORLD_SNOW_TEMPERATURE` | -4 | With biomes: ground colder than this (degrees C) is snow, with bare rock just below it on high ground |
| `WORLD_BIOME_BLEND` | 50 | With biomes: how gradually biomes give way to each other, 0 (sharp borders) .. 100 (wide, ragged transitions) |
| `WORLD_ISLAND_ARCS` | 0 | Island chains along seams where an oceanic plate meets another, 0 .. 100 |
| `WORLD_HOTSPOTS` | 0 | Hotspot island groups in oceanic plates (0..40) |
| `WORLD_ISLAND_MIN_SIZE` | 200 | Smallest arc/hotspot island, across, in metres (50..4000) |
| `WORLD_ISLAND_MAX_SIZE` | 1500 | Largest arc/hotspot island, across, in metres (50..4000) |
| `WORLD_MIN_VOXEL` | 1 | Smallest generated voxel, in 1/16 m units (1, 2, 4, 8, 16) |
| `WORLD_TOLERANCE` | 4 | Allowed surface error in 1/16 m units |
| `WORLD_RESOLUTION` | 16 | Voxel size for the flat generator |

**Plates**: major plates are placed spread out and form a power diagram (a weighted Voronoi
diagram) whose weights are tuned until every major plate has the same area. Minor plates are
then placed on the seams between majors, spaced apart (spilling inland only once the seams are
crowded), and all plates are re-tuned together so each major plate is `WORLD_PLATE_SIZE_RATIO`
times the area of each minor plate. Borders are warped by noise so they wander. Enough major
plates (with the minors on them) become continents to cover the land share; the rest is ocean
floor. Each plate's relief comes from its own seeded noise field, blended with its neighbours'
over ~400 m either side of their seam. Mountains: every plate drifts in its own direction; where two plates converge and at least one is
continental, the fastest-closing `WORLD_MOUNTAINS` percent of those seams raise a range
`WORLD_MOUNTAIN_WIDTH` wide (centred on the seam between two continents; set back inland where
ocean dives under a continent, with a trench offshore). Ranges vary along their length, fade out
at their ends, are shaped by ridged gradient noise (sharp crests, V-shaped valleys; mountain
sides also get finer ridged detail, 16-256 m across, up to ~30 m tall at the default
`WORLD_MOUNTAIN_DETAIL`, added per column), and ramp up from
~700 m inland of the coast, so coastal ranges make steep, rocky shores rather than cliffs. They
rise on top of the land, scaled so the highest peak is exactly `WORLD_MOUNTAIN_HEIGHT`; worlds
made before mountains have none. Biomes: each column's biome comes from its temperature (from the north edge's to the south
edge's, wandering a few degrees, colder with height) and moisture (wet by the sea, drier inland
and in the rain shadow behind mountains, scaled by rainfall), after Whittaker's diagram: ice,
tundra and boreal forest when cold; temperate forest or grassland when mild; jungle, savanna or
desert when hot as it dries out. Each has its own ground (taiga floor, meadow, dry grass, jungle
floor, desert sand, ...); beaches, rocky shores and steep rock still take priority. With biomes,
snow lies wherever the ground is colder than `WORLD_SNOW_TEMPERATURE` (so polar lowlands are snowy
and tropical peaks are not), with a band of bare rock ~1.5 degrees warmer just below it on ground
more than 100 m up; the snow line fractal wanders it by up to 2 degrees. Worlds made before biomes have none (grass everywhere). Trees: one candidate per 6 m cell (jittered), growing where the ground is vegetated (not sand,
desert, rock or snow) with a chance by biome: jungle trees (25-40 m, wide flat crowns), temperate
broadleaf (12-20 m, smaller on grassland), boreal conifers (10-25 m, tiered; dwarf on tundra) and
savanna acacias (6-10 m, flat-topped). They are voxels like the ground (1/4 m wood, 1/2 m leaves),
can be dug, and are solid. Distant terrain shows forests as floating canopy slabs: the actual
crowns up close, each biome's typical cover and height further away. Biome blending: borders
become ragged (local noise shifts the climate biomes are classified from by up to 4 degrees and
0.12 moisture at 100), each tree takes the biome of its climate nudged at random within an
ecotone (up to +-6 degrees, +-0.2 moisture), so neighbouring forests mix and forests thin out
across the band, and biome grounds take the colour of their local climate, blended by the same
ecotone (in the game, the generator preview and the map). Worlds made before blending keep sharp
borders. Plains are regions a few km across (chosen by
large-scale noise so `WORLD_PLAINS` percent of the land is in one) where the land is replaced by
a heavily smoothed, lowered copy of itself, blending into the hills over ~1 km; most 16 m squares
in a plain vary by under 1 m. Lowland flatness raises the land's height curve to a power (up to
3), and surface roughness scales the 0.4-6 m of small bumps every column gets. Land rises from the coast inland and the sea floor
deepens away from it, stretched so the highest land is exactly `WORLD_MAX_HEIGHT` and the
deepest sea floor exactly `WORLD_MIN_HEIGHT`; the coastline is then chosen so exactly
`WORLD_LAND` percent is above the sea, drawn as a translucent plane. Islands come first:
island arcs are chains along seams where an oceanic plate meets another (each island stretched
along its seam), and hotspots are groups in oceanic plates, a main island trailing smaller ones
in the direction its plate drifts. Islands are irregular (ellipses with extra lobes, coasts
roughened with the shoreline setting), rise to a peak, and count toward the land share: the
continents get exactly what's left (islands may take at most 90% of it). Lakes under ~1 km^2
more than 700 m from open sea are filled in: all water sits at sea level and land rises with
distance from any water, so an inland pond would be a hole in a crater. Coastal lagoons and
inlets stay; an equal amount of the lowest coast goes under water so the land share stays
exact. The sea floor is sand. Beaches follow the coast's slope: gentle coasts get sand up to
8 m above the sea at `WORLD_BEACHES` 100 (4 m at the default 50; tens of metres wide), tapering
to none on steep coasts, which are bare rock at the waterline; beaches also come and go along a
coast. Grass covers lowland; bare rock covers ground steeper than `WORLD_ROCK_SLOPE` (snow
doesn't stick there) and everything from `WORLD_ROCK_ALTITUDE` metres above the sea, and snow
lies from `WORLD_SNOW_ALTITUDE` metres up, so low worlds have none. The plate map is built once when a world is opened, on
a 32 m grid (a few hundred ms); heights between grid points are interpolated with small-scale
roughness. Worlds made before these settings existed keep their plate counts, seed, shoreline
and water share (as `100 - land`); rock and snow keep their old places (60% and 80% of the land's
height range, converted to metres, and rock above 42 degrees); other settings take the defaults
above.

Terrain is voxelized adaptively: a 1 m block is halved (1 -> 1/2 -> 1/4 -> 1/8
-> 1/16 m) only where the surface passes through it and a coarser voxel would
misplace it by more than the tolerance.

In development (`NODE_ENV` not `production`) the client can ask for another
tolerance (integer 0..16, the Settings dialog or `?tolerance=N`); those edits
stay in memory.

## Controls

Click the view to capture the mouse; then moving the mouse looks around and
Esc releases it. (Without capturing, dragging with a mouse button also looks.)

You start **walking**: W/A/S/D move in the direction you face, Space jumps
(about 1.25 m, enough to get onto a 1 m voxel), gravity pulls you down, and
ledges up to 1/2 m are climbed automatically. **F** switches to **flying**
(Space or E rises, Q or C descends) and back. Shift moves 5x faster and the
mouse wheel changes the base speed (default 2 m/s). You collide with terrain
as a 0.6 x 1.8 m body (eyes at 1.62 m); **N** toggles no-clip, which flies
through everything. Gravity waits until the ground below you has loaded.

**M** opens a map of the whole world (generated terrain; edits aren't shown),
in the same colours the game renders, with your position and facing, the spawn
point, a 1 km grid, and a scale bar. Hover for coordinates, ground height, and
surface; click to go there. M or Esc closes it. The server serves it at
`/api/world/map?width=N` (64..2048 samples across, default 1024), and a world's climate grid
for blending biome colours at `/api/world/climate` (204 where biomes don't blend).

Lighting: a warm sun (about 30 degrees up, low enough to shade the sides of things), blue-ish sky light from above and dim warm light
bounced from the ground, with ambient occlusion darkening the corners and creases of nearby
voxels (not of distant terrain). Haze thickens with distance and thins with height (peaks and
high viewpoints see further), takes the sun's colour when looking toward it, and closes in fully
at the view distance into a sky that matches it. **L** opens a lighting panel (sun height,
direction, strength and warmth; sky light; ground bounce; corner shading; haze; exposure),
applied live and saved in this browser.

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
connected client, and saves edited chunks in the world's folder (see Worlds and
terrain) so they survive restarts.

## Distant terrain

Around the camera the client renders full-detail voxel chunks within the
detail distance (default 4 chunks). Beyond that, out to the view distance
(default 2048 m), it renders low-detail tiles chosen by a quadtree: 32 m tiles next to
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
npm run dev:client   # http://localhost:5173 (proxies /api and /ws)
npm test
npm run typecheck
npm run build
```
