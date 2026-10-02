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
`?workers=N` sets the number of mesh workers (default: up to 4; the HUD shows
how many and their average time per chunk).
While moving fast, nearby voxel chunks give way to 1 m tiles (full detail up to
25 m/s, half the radius up to 60 m/s, none beyond; it comes back a moment (0.3 s) after you
slow down):
`?fullDetailBelow=A&noDetailAbove=B` (m/s) tune it, `?noDetailAbove=0` turns it off.

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
| `WORLD_SHAPE` | round-64x32 | Shape of a new default world: `round-64x32` or `round-16x8` (wrap east-west, polar ice north and south), or `flat-16x16` |
| `WORLD_EQUATOR` | 1 | 1: hottest across the middle, cooling to both edges; 0: from the north edge to the south edge |
| `WORLD_EQUATOR_TEMPERATURE` | 28 | With an equator: sea-level temperature across the middle (degrees C) |
| `WORLD_RIVERS` | 50 | Rivers: 0 (none) .. 100 (many small streams) |
| `WORLD_LAKES` | 50 | Lakes in land basins: 0 (filled in) .. 100 (even small basins) |
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

## Game modes and inventory

Each world is **survival** (the default) or **creative** (`mode` in its `world.json`;
`WORLD_MODE` for a new default world). Signed-in players have an inventory per world, kept on
the server (Postgres with sign-in, else memory):

- **Survival:** you start with 16 blocks each of dirt, stone and wood. Placing uses material up
  and mining gives it, by volume (a 1/4 m voxel is 1/64 of a block), so every voxel size works.
  Grassy grounds give dirt, leaves give nothing (for now); water can't be placed yet.
- **Creative:** everything placeable is unlimited.

**Crafting** (in the inventory screen): 1 wood → 4 planks, 2 planks → 4 sticks, 4 planks → a
crafting table; and, within 5 m of a placed crafting table, wooden and stone swords, fences,
gates, doors and buckets (see `RECIPES`). Mining stone gives cobblestone. Items that aren't
blocks (sticks, tools, ...) are counted whole.

**Buckets**: with one in the hotbar, right-click water to fill it, anywhere else to pour it into the
block in front of you. Each bucket you own holds 1 m³; the sea, lakes and rivers never run dry,
and poured water can be scooped back up. **Swords** cut leaves (and only leaves): left-click
leaves with one in hand; a wooden sword clears the 1 m block, a stone sword 3 x 3 x 3 m.

**Fences, gates and doors**: with one in the hotbar, right-click a face (hybrid mode) to place it
in the 1 m block there, facing the way you look (doors are two blocks tall). Fences join each
other and gates in their line. Right-click a gate or door to open or close it; left-click any
part of one to take it down (it goes back in your inventory). Other edits can't cut into them.
They're voxels of their own materials, and the server keeps a register of them (objects.json
beside each world's edited chunks).

**Mobs and fighting** (placeholder boxes for now): pigs wander by day on grass and run when hit;
zombies come out at night (19:30 to 06:00), chase players within 24 m and hit for 3, and burn
away in daylight. They appear 24..48 m from players (a few around each) and go when nobody is
within 96 m. Left-click a mob within 4.5 m to hit it: a bare hand does 1, a wooden sword 4, a
stone sword 5, with knockback (pigs have 10 health, zombies 20). Signed-in survival players
have 20 health (hearts above the hotbar), healing a point every 4 s once unhurt for 6 s; at 0
they come back at the spawn point with everything they had. Creative players and visitors who
aren't signed in can't be hurt. Other players show as figures with their names (no fighting
each other). The server moves mobs ten times a second and tells each player what's near.

The hotbar (bottom of the screen) holds what you place: 1-9 or the mouse wheel pick a slot
(Option+wheel sets the flying speed). E opens the inventory
(survival: what you have; creative: everything); click a material to put it in the selected
slot. The hotbar is kept with your inventory. Players who aren't signed in can't build, so they
have neither. Inventories are filed under the world's name and when its terrain was made, so a
recreated world starts everyone afresh.

## Controls

Click the view to capture the mouse; then moving the mouse looks around and
Esc releases it. (Without capturing, dragging with a mouse button also looks.)
A compass rose around the crosshair turns with you; its red N points to world
north (-Z).

You start **walking**: W/A/S/D move in the direction you face, Space jumps
(about 1.25 m, enough to get onto a 1 m voxel), gravity pulls you down, and
ledges up to 1/2 m are climbed automatically. **F** switches to **flying**
(Space or E rises, Q or C descends) and back. Shift moves 5x faster and the
mouse wheel changes the base speed (default 2 m/s). You collide with terrain
as a 0.6 x 1.8 m body (eyes at 1.62 m); **N** toggles no-clip, which flies
through everything. Gravity waits until the ground below you has loaded.

**M** opens a map of the world (generated terrain; edits aren't shown),
in the same colours the game renders, with your position and facing, the spawn
point, a grid, and a scale bar. The wheel zooms (about the cursor, down to 4 pixels per metre),
dragging moves it (round worlds wrap east-west), 0 shows the whole world again; zoomed in,
256 x 256-sample tiles at about one sample per screen pixel fill in over the whole-world map
(fetched four at a time, the middle first, and kept). Hover for coordinates, ground height, and
surface; click (without dragging) to go there. M or Esc closes it. The server serves the whole
map at `/api/world/map?width=N` (64..2048 samples across, default 1024), closer looks at
`/api/world/map/area?x0=&z0=&step=&cols=&rows=` (up to 512 x 512 samples, at least 1 m apart),
and a world's climate grid for blending biome colours at `/api/world/climate` (204 where biomes
don't blend).

The client keeps chunks it has seen (up to 32 MB) after they leave the detailed area, so
turning back costs no requests, and loads the ring of columns just beyond the area (not drawn)
so walking on finds them ready. Meshes that were replaced stay drawn until the ground they
covered is drawn again (by chunks or tiles), so nothing goes missing while terrain reloads.

Lighting: a warm sun (about 30 degrees up, low enough to shade the sides of things), blue-ish sky light from above and dim warm light
bounced from the ground, with ambient occlusion darkening the corners and creases of nearby
voxels (not of distant terrain). Haze thickens with distance and thins with height (peaks and
high viewpoints see further), takes the sun's colour when looking toward it, and closes in fully
at the view distance into a sky that matches it. **L** opens a lighting panel (noon sun height
and direction, sun strength and warmth; sky light; ground bounce; corner shading; haze;
exposure), applied live and saved in this browser.

Water is a material, and there are two kinds. **Natural water** (the sea, lakes and rivers) never
moves and never runs dry: it fills space you open beside or under it at once (a channel dug from
the sea below its surface fills as you dig; up to 512 blocks an edit), but it never runs out
over the land. **Poured water** (from a bucket, or placed in creative) is finite: on the server,
five steps a second, it falls into open space below and otherwise levels out with its
neighbours, comparing surfaces (it runs down steps, never up), until it settles flat; it's never
made or lost, except into natural water, which it joins. Water isn't solid (you see, aim and
swim through it). Near the player the sea is these voxels; further away a flat sea surface stands
in for it.

Rivers and lakes (`WORLD_RIVERS`, `WORLD_LAKES`, 0..100, default 50; older worlds have none):
water drains from every 32 m cell toward the sea along the lowest route (basins filled to their
spill height first). Basins big and deep enough hold lakes at that height, the rest are filled
in; where enough water gathers (more in wet country) a river runs, wider downstream (up to 50 m),
falling all the way to the sea or a lake. Rivers cut a channel with a sand bed and a valley around
it (banks rising at 0.3 out to ~100 m), and their and lakes' water is source water like the sea's.
Distant terrain and the map show them as water over their beds.

World shapes: new worlds are round by default, 64 km around east-west (walk or fly past the
seam and you're back where you started; nothing changes as you cross) and 32 km north to south
(a 16 x 8 km round world is available for quick tests), with polar ice at the north and south edges: a band ~700 m wide that rises from a low shelf over
the sea to a 70 m ice wall at the edge. Flat 16 x 16 km worlds are still available (the
generator's World menu, `"shape"` in the API: `round-64x32`, `round-16x8` or `flat-16x16`, or
`WORLD_SHAPE` for a new default world); worlds made before shapes stay flat. Default plate counts
grow with the world (24 major and 52 minor at 64 x 32 km), and on worlds bigger than 16 x 16 km
plate borders also bend at the plates' own scale, so coasts don't run straight. A 64 x 32 km
world takes about 5 s to build (at server start, when first opened, and for each generator
preview change) and about 100 MB of server memory. The climate has an equator across the
middle (`equator`, `equatorTemperature`, default 28 C) cooling to `northTemperature` and
`southTemperature` (default -8 C) at the edges; worlds from before keep their cold-north,
hot-south climate.

World dashboard (`/dashboard.html`, linked from the menu; development servers only, from
`GET /api/dashboard`): live server health (CPU, memory, event loop delay, network), five minutes
of charts (chunks and tiles sent, traffic, CPU, memory, edits and water changes per second),
each world (players, clock, edited chunks and their size on disk, cache use and hit rates,
generation times, water flow), the players (position and heading on the world's map, what
they've loaded and sent) and recent errors. Players report their position twice a second.

Day and night: each world has a clock kept by the server (saved in its world.json, so it
carries on across restarts and terrain updates), a 24-minute day by default or real time (the
server's clock and time zone). New worlds take `WORLD_DAY_MINUTES` (1..1440 or `real`, default
24). The sun rises in the east, crosses the noon direction at the noon height and sets in the
west, reddening near the horizon with an orange sky at dusk; at night the moon (opposite the sun)
gives a dim blue light, colours fade, and stars come out. Press **I** to hide or show the info panel. The lighting panel shows the time and,
on development servers, sets it (`PUT /api/worlds/<name>/clock` with `hours`, `dayMinutes` or
`frozen`); every player in the world sees the change.

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
Over water it also reports the water's surfaces and the top of everything solid:
chunks holding only water draw nothing, so only the surface is loaded, plus the
ground within 96 m below the water (deeper, it's too dark to see) or, while
swimming, below you, and the layer you're in.

Streaming: a column's reply is followed by its chunks (the layers it names in
`sent`), so the client needn't ask for each; it keeps only a few columns in
flight so the server's queue stays short. Each connection's requests are served
a few milliseconds at a time, and the client cancels requests for chunks, tiles
and columns it has moved away from, so flying fast doesn't leave the server
generating terrain behind you. Mesh workers take one job at a time and skip
chunks that have left the view. While moving, the full-detail area is centred
up to a second of travel ahead of the camera (at most detail - 1 chunks).

`packages/client/bench/fly.ts` flies a headless client (the real chunk and tile
managers, meshing on node worker threads) east across the seam of a running
server and reports how much of the area around the camera was ready:

```sh
PORT=8799 WORLD_DATA_DIR=/tmp/fly npm run dev -w @super-vox/server   # a fresh world
cd packages/client && npx tsx bench/fly.ts 8799 30@2 80@-12          # speed (m/s) @ row (km from the equator)
```

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

## Deploying (Railway)

One service runs everything: the `Dockerfile` builds all three packages and starts the
server in production mode, which also serves the built pages (so `/`, `/api` and `/ws`
share an address). `railway.toml` points Railway at the Dockerfile and health-checks
`/api/health`.

- **Volume:** mount one at `/data` (`WORLD_DATA_DIR`); worlds and their edits live there.
  Without it, every deploy starts a fresh world.
- **Production mode** (`NODE_ENV=production`, set by the image): `?tolerance` is ignored, and
  the operator's tools (the dashboard, the clock, creating, changing and deleting worlds) are
  for signed-in admins (`ADMIN_EMAILS`) only. Signed-in players can play and build.
- **First start** creates the default world from the `WORLD_*` settings (64 x 32 km round,
  1/4 m tolerance by default); later starts reuse it. It takes several seconds to build
  and about 300 MB of memory.
- `auth/` (credentials) and `data/` are excluded from the image by `.dockerignore`.
- **Sign-in** (Google): set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET` (32+
  characters), `DATABASE_URL` (Supabase Postgres; tables go in the `"super-vox"` schema,
  created on start), `PUBLIC_URL` (this site's address, for Google's callback
  `/api/auth/google/callback`) and optionally `ADMIN_EMAILS`. With sign-in on, only signed-in
  players can edit; anyone can look around. Locally, `npm run dev` takes the Google client and
  session secret from `auth/` and keeps accounts in memory (set `DATABASE_URL` to use Postgres).

```sh
docker build -t super-vox .
docker run -p 8787:8787 -v super-vox-data:/data super-vox   # http://localhost:8787
```
