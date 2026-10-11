# Backlog

Ideas queued for later, in the order they were proposed. Each has a rough size, the systems it touches, and the questions to settle before building it. Sizes are relative: **S** is an afternoon-sized change like buckets, **M** is like shaped blocks or crafting, **L** is like structural integrity plus cave-ins, **XL** is bigger than anything built so far.

## 1. Weather — M (Done)

Every so often the weather turns: far more cloud, the land darkens, rain falls for a good while, with lightning and thunder.

- **Builds on:** clouds (`clouds.ts`: cover can be raised by lowering the pattern threshold, and shadows darken more), day/night light (`daycycle.ts`), water (`fluid.ts`).
- **Parts:** a weather state machine (clear → overcast → rain → storm → clearing, with random durations of several in-game minutes); rain particles near the camera, hidden under cover; overall light dimmed; lightning flashes that light the whole sky for a moment, and strikes that can set things off (TNT?) or hurt the player.
- **Questions:**
  - Sound: there's none in the game yet. Thunder without audio is only a flash, so this may be the moment to add an audio system.
  - Should rain fill things (cauldrons, puddles in hollows) or put out torches? Minecraft does neither for torches.
  - Should Lurkers spawn by day when it's dark enough in a storm?
  - Snow instead of rain in cold places (needs biomes, item 4).
- **Save:** the weather state and its timer.

## 2. Rail tracks and enclosed rail cars — XL

Tracks the player lays, and closed cars they ride in.

- **Parts:**
  - Track pieces as shaped blocks: straight, curve, slope and junction. The piece is chosen from its neighbours when placed, like fence connections.
  - Cars as vehicles: bodies that follow the track, with speed, momentum and gravity on slopes.
  - Riding: the camera goes inside the car, and input turns into accelerate / brake.
  - Powered sections or an engine car.
- **Terrain:** tracks need a flat bed, bridges over gaps and tunnels through hills. Options:
  - Only let the player lay track, and make bridges and tunnels their job.
  - Add a "lay track" tool that cuts and fills automatically, like a road builder.
  - Structural integrity already makes long bridges need supports.
- **Stops:** stations as blocks that stop the car and let you out. Possibly a destination UI.
- **Questions:**
  - How realistic should curves and speed be?
  - Should it run while the player is elsewhere? Unloaded chunks stop everything today.
  - What happens to a car on track when its chunk unloads?
  - Should cars carry cargo (ties in with item 6)?
- **Risk:** vehicles are a new kind of entity with their own collision and saving. A good first step would be a single car on a straight or curved track, with no junctions.

## 5. Geological strata, faults and ore veins — L (Done 2026-10-06: phases 1-4)

Rock layers, fault lines, and ores that follow geological logic instead of random blobs: ore found by reading the rock.

- **Today:** `ores.ts` scatters coal (from 4 m down) and iron (from 12 m) in 2 m clumps, by hashing; `TerrainGenerator.generateChunk` paints each wholly-underground 1 m block one material (`materialFor`, then `oreAt` for stone). Bare surface rock is random patches (`rockSurface`).
- **Approach:** a pure `rockAt(bx, by, bz)` replaces "stone, then maybe ore" (painted per chunk as now, no stored state). A world setting `geology` (like `caves`): absent = worlds made before it, which keep today's ore unchanged; on by default for new worlds, with a toggle in the generator settings.
- **Model, bottom up:**
  - Basement: granite, deep down.
  - Sedimentary stack above: sandstone, shale, limestone, layers 2-12 m, a sequence varying by region; tilted and gently folded (wavelengths ~1-3 km), so layers rise, dip and outcrop on hillsides. Layer surfaces worked out per block column, not per block.
  - Coal seams: thin continuous layers (0.5-2 m) in the stack, followable.
  - Banded iron: iron-rich layers deep in the stack.
  - Faults: a few planes per few-km region, offsetting the layers 5-40 m (a seam ends at a wall, carries on above or below).
  - Intrusions: granite bodies rising into the stack and basalt dikes cutting it; iron, copper and gold concentrated in a band a few metres wide at their margins.
- **Surface:** in geology worlds, cliffs and bare rock show the real layers (bands, seams outcropping) instead of random patches. Distant tiles must agree with chunks (same function), or cliffs change colour as they load.
- **Phases** (each shipped and tested alone; each benchmarked against today's generation time per chunk before shipping):
  1. New rocks (sandstone, shale, limestone, granite: colour, hardness, drop, inventory), tilted/folded strata, coal seams, the `geology` setting, banded cliffs. **M** **Done 2026-10-06 (db39edd).**
  2. Faults. **M**
  3. Intrusions, basalt dikes, ores at their margins (iron; new: copper, gold), banded iron. **M**. **Done 2026-10-06 (6cd0203).** Copper and gold are smelted into coins (decided 2026-10-06), to be spent in the marketplaces of item 6 later.
  4. Geologist's hammer that names the rock (a start on prospecting). **S** **Done 2026-10-06 (bcf8ac5, ad5bbb4), before phase 3.** Phase 2 (faults) done too (2a1e790).
- **Decided (2026-10-06):** 4 rocks in phase 1 (basalt with dikes in phase 3); add copper and gold; new worlds on, existing unchanged; cliffs show layers.
- **Later:** prospecting as a skill: reading strata, intrusions and faults; float ore in streams below a vein; a pan for stream gravel; a map marking finds. Ties in with the strata of relics in item 16. Structural integrity (different rocks, different spans) when that exists.

## 14. Tools and weapons shown in hand — M (Done)

What you hold is drawn in the corner of the view and moves when used: a sword swings, a pick strikes, a bucket tips, a spyglass comes up to the eye.

- **Builds on:** the hotbar and items (`blocks.ts`, `icons.ts`), the attack and break actions (their events already say when they happen, in `events.ts`).
- **Parts:** a first-person hand layer drawn over the world (its own scene and camera, so it never clips into walls); a small model per held item (blocks as cubes, tools from the icon shapes); swing, strike and bob animations tied to actions and walking.
- **Multiplayer:** other players show what they hold too (phase 3 draws other players).
- **Questions:** blocky models built from the 16x16 icons (like Minecraft's extruded sprites), or hand-made models per tool?

## 17. Animals: rabbits, deer and bears — L (Partially Done)

Wildlife by biome: rabbits and deer that flee, bears that are meat and a threat.

- **Builds on:** creatures (`mobs.ts`: AI states, pathfinding, spawning, senses), drops and items, health.
- **Parts:** a creature type per animal with its own model, speed and senses; rabbits and deer spawn by day in grassland and forest, flee from players (and bears); bears wander, and charge when close or hurt; each drops meat (and hide?).
- **Needs food:** meat is for eating, and there's no hunger or eating yet. A food system (hunger, cooking at a furnace or fire, item 18) would come with this.
- **Questions:** herds? Breeding, or just spawning? Do animals leave prints in snow (they could, like Lurkers)?

## 21. Survival progression: ores, tools, furnace and cooking — L (Partially Done - needs recipes?)

Survival has swords and hand-mining only: nothing to dig for, no faster tools, no way to cook the pork pigs drop.

- **Builds on:** mining times by material (`mining.ts` HARDNESS), recipes and the crafting table (`recipes.ts`), inventory (`playerInventory.ts`), food (`survival.ts` FOODS), the plate terrain (where ore goes).
- **Parts:**
  - **Ores:** coal and iron first (copper later, for item 12), placed by depth and rock (a cheap first cut of item 5).
  - **Tools:** pickaxe, axe and shovel in wood, stone and iron: each mines its materials faster (a multiplier on the mining time the server checks), wears out with use.
  - **Furnace:** a block that holds fuel and an input and makes an output over time (smelting ore to ingots, cooking meat). The first block with its own inventory, kept by the server.
  - **Cooked food:** raw pork worth less than cooked; perhaps a chance of getting sick from raw.
  - **Survival C4:** a recipe needing a late material (refined from ore), so it isn't the first thing a new player makes.
- **The inventory window** (designed 2026-10-03): one window (E) with tabs: **Inventory, Crafting, Smelting, Cooking, …** (more stations later: anvil, smithing). The hotbar shows along the top of every tab, as **10 slots, keys 1–0**.
  - **Inventory tab:** cards (icon, name, count), with search and sort by kind; a durability bar on tools once they wear. Drag between the inventory, the hotbar and a station's table; shift-click moves a whole stack. Throwing away happens here: a trash slot, or dragging out of the window.
  - **Every station works the same way:** a **table** of ingredient slots (shapeless: order doesn't matter), an action (**Make**, **Smelt**, **Cook**), and the result. One component, set up per station (a fuel slot or not, the action's name, what's done with the result).
  - **Amounts:** slots hold amounts (blocks by volume, items by count); shift-click puts in all, the wheel or ± one at a time.
  - **Recipes, both ways:** as things go on the table, what they could make is shown; and a recipe list beside it fills the table from the inventory in one click (for players who don't know the recipes yet).
  - **The result:** **Make** puts it straight into the inventory; **Cancel** (or closing the window) gives the ingredients back. Cooked food can be eaten straight away (**Eat**).
  - **Stations are in the world:** crafting-table recipes need a crafting table near; smelting a furnace, cooking a stove (or campfire). Their tabs show, greyed out with the reason ("needs a furnace nearby"), when there's none. Clicking a furnace or stove in the world opens its tab, for that one.
  - **Smelting and cooking take time:** fuel and input go in; it works with a progress bar, and keeps going with the window closed. The output waits to be collected. The furnace's contents are the server's, the same for everyone at it.
  - **Creative:** Inventory only (everything, unlimited); stations aren't needed there.
  - **Steps:** first the Inventory and Crafting tabs over today's recipes, and the 10-slot hotbar; Smelting and Cooking with the furnace, stove and ores.
- **Questions:** does the furnace work while no one is near (the server's always on, so it could)? Does dying drop what you carry (today you keep everything)? Is a furnace shared by everyone, or locked to whoever loaded it? What burns, and for how long (planks, wood, coal)?

## 22. Caves, and light to see by — L (Done)

There's nothing underground but solid rock, and nothing gives light but the sun.

- **Builds on:** plate terrain and chunk generation (`plates.ts`, `terrain.ts`, made off the main thread in `genWorker.ts`), the mesher and lighting (`mesher.ts`, `lighting.ts`, `voxelMaterial.ts`).
- **Parts:**
  - **Caves:** tunnels and caverns from 3D noise (worms and chambers), kept out of the sea and away from the surface in most places, with entrances in cliffs and valleys. They'd make ores (item 21) worth exploring for.
  - **Block light:** emitters (torches, lamps, lava) lighting their surroundings, worked out per chunk in the mesher and passed across chunk borders. Sky light falling short underground, so caves are dark.
  - **Torches:** a recipe (sticks and coal), placed on walls or floors as an object, like fences.
  - Zombies spawning in the dark, not just at night.
- **Questions:** light as a vertex value (cheap, blocky) or a 3D light texture per chunk (smooth)? How far does light reach, and at what cost when a torch is placed (re-meshing the chunks it reaches)?
- **Cost:** caves change terrain everywhere, so it's a new terrain version (the disk cache is already versioned by terrain).

## 23. Sound — M (Done)

The only sound is an explosion's boom. Item 1 (thunder) and item 10 (music) both assume an audio system.

- **Builds on:** the boom in `explosions.ts` (Web Audio, delayed by distance).
- **Parts:** one audio manager (volume settings, master, effects, music); positional sounds (panning and fall-off with distance) for footsteps by material, mining and placing, doors and gates, splashes and swimming, mobs (pigs, zombies), hurt, eating; ambient beds by biome and time (wind, birds by day, crickets at night, the sea near the shore).
- **Questions:** made sounds (synthesised, like the boom) or recorded samples (better, but they need finding and licensing)? Other players' sounds too (their footsteps, their mining)?

## 24. Playing together: chat, player list, names — M

Several players can share a world, but they can't talk, and there's no way to see who's on.

- **Builds on:** the WebSocket protocol (`protocol.ts`), accounts and sign-in (`accounts.ts`, `auth.ts`), entities (other players are drawn already), the dashboard (admins see players).
- **Parts:** text chat in a world (Enter to type, messages fading over the view, a short history); a player list (Tab is the tool mode, so another key); names over players' heads; admin commands from chat (kick, set time, set mode, teleport a player).
- **Questions:** moderation (mute, rate limits, a word filter) once the game is public? Chat across worlds, or per world only?

## 27. The server: heavy work off the main thread — L (Done?)

One thread does everything that changes the world: a 16 m blast's carving holds up every player in every world for about 0.4–0.7 s (more on Railway), and water steps, edits and mob AI all queue behind it. The server has 32 cores.

- **Builds on:** the generation pool (`genPool.ts`, `genWorker.ts`), the blast loop (announce, then carve, `explosives.ts`), the per-world water flow and mob managers.
- **Parts:**
  - **Carving in a worker:** a blast's chunks sent to a worker, carved there, the changed chunks sent back (the bang and dust are already separate, so nothing visible waits on it).
  - **A world per thread:** each open world's simulation (water, mobs, explosions) in its own worker, so a busy world doesn't slow the others.
  - **Tiles that show edits:** distant tiles are made from the generator, so craters and buildings vanish when you fly fast (only voxel chunks show them). Tiles for edited ground could be remade from the edited chunks.
  - **The browser's blast dust** sampled in a worker too (it takes up to about 120 ms on the main thread for a 16 m blast).
- **Questions:** how do chunks move between threads cheaply (transfer the encoded bytes; the world's caches are per thread)?

## 30. UI re-vamp — M (Done; wireframes from the user, 2026-10-05)

Every page gets one look: a header bar (title, navigation, a fullscreen button at its right).

- **Landing page** (top to bottom): title; sign-in information; a big picture of the selected world; that world's details; the world selector; then a row of four buttons: world management, object designer, settings, **PLAY**.
- **World management** (today's dashboard and world tools in one): header; server status; the last five minutes (the dashboard's history); the world list, each row its columns of details and buttons for mode, terraform, find site, make claim; a "generate new world" button at the bottom left (the world generator).
- **Object designer:** header; object list on the left, the workspace in the middle, the palette on the right.
- **Settings** (its own page, not a panel): header; the settings area; at the bottom, reset to defaults (left), cancel and save (right).
- **Questions:** where the Terraformer, Site finder and Claims pages go (from the world list's buttons, per the wireframe, rather than the landing page?); what the world picture is (the map, the 3D relief, a saved snapshot?); whether the game itself gets the header.

## 32. Grassland

Grass in open meadows and on the ground below forests and jungles.

## Design rules (from engineering advice, to keep to as systems are added)

- **Keep the voxel compact.** A cell is a 1-byte block id (a global palette of up to 256) plus a byte of light; water's level is part of the block id; structural stress is worked out when needed, not stored. New per-cell state (temperature, fire, moisture) goes in sparse per-chunk maps holding only the cells that have it, never as a new array for every cell.
- **Budget the simulation.** Every cellular system (water, falling blocks, heat, fire, erosion) competes for the same tick. Aim for a global scheduler with a time budget per system and active-region tracking (only chunks with something happening, near players, get ticked), and run the simulation off the render thread (a worker in the browser, the game server in multiplayer) with double-buffered chunk state for the view to read.

## Decisions so far

## Suggested order
