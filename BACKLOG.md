# Backlog

Ideas queued for later, in the order they were proposed. Each has a rough size, the systems it touches, and the questions to settle before building it. Sizes are relative: **S** is an afternoon-sized change like buckets, **M** is like shaped blocks or crafting, **L** is like structural integrity plus cave-ins, **XL** is bigger than anything built so far.

## 1. Weather — M (not done)

Every so often the weather turns: far more cloud, the land darkens, rain falls for a good while, with lightning and thunder.

- **Builds on:** clouds (`clouds.ts`: cover can be raised by lowering the pattern threshold, and shadows darken more), day/night light (`daycycle.ts`), water (`fluid.ts`).
- **Parts:** a weather state machine (clear → overcast → rain → storm → clearing, with random durations of several in-game minutes); rain particles near the camera, hidden under cover; overall light dimmed; lightning flashes that light the whole sky for a moment, and strikes that can set things off (TNT?) or hurt the player.
- **Questions:**
  - Sound: there's none in the game yet. Thunder without audio is only a flash, so this may be the moment to add an audio system.
  - Should rain fill things (cauldrons, puddles in hollows) or put out torches? Minecraft does neither for torches.
  - Should Lurkers spawn by day when it's dark enough in a storm?
  - Snow instead of rain in cold places (needs biomes, item 4).
- **Save:** the weather state and its timer.

## 2. Rail tracks and enclosed rail cars — XL (not done)

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

## 3. Ships on the ocean — L (not done)

- **Parts:** a boat as a vehicle floating on water, steered by the player; buoyancy and drag; possibly larger ships made of blocks (a moving structure), which is much harder.
- **Questions:**
  - A small boat item, like Minecraft's, is simple.
  - A sailable ship built from blocks means moving many blocks as one body. That needs a separate mesh and collision for the moving part, which the engine can't do yet.
  - Should NPC ships sail and trade (item 6)?
- **Suggestion:** start with a rowable boat; decide on block-built ships later.

## 4. 

## 5. Geological strata, faults and ore veins — L (planned 2026-10-06)

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
  3. Intrusions, basalt dikes, ores at their margins (iron; new: copper, gold), banded iron. **M**. Open: what copper and gold are for (items, smelting, recipes) so they're worth mining.
  4. Geologist's hammer that names the rock (a start on prospecting). **S**
- **Decided (2026-10-06):** 4 rocks in phase 1 (basalt with dikes in phase 3); add copper and gold; new worlds on, existing unchanged; cliffs show layers.
- **Later:** prospecting as a skill: reading strata, intrusions and faults; float ore in streams below a vein; a pan for stream gravel; a map marking finds. Ties in with the strata of relics in item 16. Structural integrity (different rocks, different spans) when that exists.

## 6. NPCs who build markets and buy goods — XL (not done)

Characters who set up market stalls and buy ore, iron, steel and tools.

- **Builds on:**
  - Creature AI and pathfinding (`mobs.ts`, `pathfind.ts`).
  - Items and inventory, crafting, and the shaped building blocks.
- **Parts:**
  - Friendly NPCs (a new creature type with its own look).
  - A currency (coins? emeralds?).
  - A trade UI: talk to an NPC and see its offers.
  - Market stalls or settlements, either generated with the world or built by the NPCs over time.
  - Prices, perhaps rising and falling with supply.
- **Questions:**
  - Do NPCs really build (placing blocks over time, which is hard: they need plans and pathfinding to reach each block), or do markets just appear?
  - Do Lurkers attack NPCs?
  - What can the player buy with the money?
  - Should NPCs be saved? Nothing creature-like is saved today.
- **Suggestion:** a first cut could be a generated trading post with a stationary trader and a fixed price list. Wandering and building NPCs would come later.

## 7. Path erosion and footprints in snow — M (not done)

- **Parts:**
  - Footprints: marks in snow where the player (and creatures) walk. They could be decals on the snow surface rather than block changes, fading or filled in by snowfall (ties in with weather).
  - Path erosion: grass that's walked on often wears to dirt, then to a path block. This needs a per-cell wear counter, and storing it only for cells actually walked on keeps it cheap. It's saved like edits.
- **Questions:**
  - Should footprints persist across saves? Persistent per the request, but they need a cap or fading so the save doesn't grow forever.
  - At 0.5 m blocks, do footprints mark whole blocks (lowering snow a layer) or just the surface?

## 8. Erosion — XL

Rivers slowly carve channels, rain wears cliffs down, wind drifts sand into dunes, and snow builds up and melts with the seasons.

- **Builds on:** water flow, weather (item 1), biomes (item 4), falling blocks and structure (collapsing banks).
- **Parts:**
  - Rivers: generated rivers (there are none yet; only sea and ponds), then slow erosion where water flows. For example, flowing water occasionally removes a soft block beside or under it and drops it downstream.
  - Rain wearing cliffs: occasional loosening of exposed soft blocks during rain, feeding the falling-block system.
  - Wind: sand blocks hopping downwind in deserts to build dunes.
  - Seasons: a year cycle alongside the day cycle, with snow layers that build up in winter and melt in spring. Snow layers need a partial-height snow block.
- **Hard parts:**
  - It all has to happen in loaded chunks only and within a frame budget.
  - It changes the world constantly, so saves grow and players' builds get eroded. That may need protection, such as player-placed blocks not eroding.
  - Seasons touch lighting, colours and gameplay everywhere.
- **Suggestion:** do it last, after weather, biomes and rivers exist, and start with one mechanism (snow build-up and melt, or river bank erosion) rather than all four.

## 9. NPC antagonists, guns and ammunition — XL

Hostile people, a handgun and a rifle to craft, ammunition for each, and shooting with damage.

- **Builds on:**
  - Creatures and pathfinding (`mobs.ts`, `pathfind.ts`).
  - Weapons and durability (`weapons.ts`), crafting stations, iron and steel.
  - Sound (gunshots are the loudest thing in the game).
  - The NPCs of item 6: antagonists could raid markets and traders.
- **Parts:**
  - **Antagonists:** armed humans (bandits, raiders) as a new creature type. They'd need their own look, health, and AI for keeping distance, taking cover and shooting back. Some would carry guns and some melee weapons. They'd drop what they carry.
  - **Recipes:** a handgun and a rifle made at a new station or the blast furnace (steel barrel, wooden stock, iron parts). Handgun ammo and rifle ammo, crafted in batches.
  - **Gunpowder:** there's none yet, and it doesn't exist as a material. It needs new ores or items (saltpetre and sulphur alongside coal), which is also what TNT would need to become craftable in survival.
  - **Shooting:** a hitscan ray (like the block-targeting ray) against creatures and blocks. Damage by gun, falling off with range. Rate of fire, magazine size, reloading, recoil or spread, muzzle flash and a tracer. Ammo is used from the inventory.
  - **Damage:** gun damage on creatures and the player, maybe headshots (creature boxes have no head yet). Possibly bullet holes or small block damage.
- **Questions:**
  - Are antagonists everywhere, or tied to places (camps, raids on markets)? Do they come at night like Lurkers, or at any time?
  - Should the player be able to aim down sights or zoom with the rifle?
  - Can antagonists hurt or kill traders, and does the player get rewarded for stopping them?
  - Do bullets break glass and leaves, or pass through water?
  - Should there be armour, since damage to the player goes up sharply with guns?
- **Suggestion:** do the guns first, against Lurkers: recipes, ammo, shooting, damage and sound. Add antagonists once the shooting feels right, then connect them to markets (item 6).

## 10. Music from Apple Music — M

Play tunes from the player's Apple Music library inside the game.

- **How:** Apple's MusicKit JS. The page signs the player in with their Apple ID, then can search and play their library and the catalogue. Full songs need an active Apple Music subscription.
- **Needs:**
  - An Apple Developer account ($99 a year) to create a MusicKit key.
  - A developer token: a JWT signed with that key, valid for up to 6 months. For a personal game it can be generated locally and kept out of the repo (e.g. in an untracked `.env`), but the private key must never ship in the page.
  - A published site would need a small server to hand out tokens.
- **Limits:**
  - Apple plays the music through its own DRM-protected player, not the game's Web Audio graph.
  - The game can play, pause, skip and set the volume, but can't filter it (no muffling underwater or indoors).
  - The browser needs a user gesture to start playback (the pointer-lock click works).
- **Parts:**
  - A music panel in the pause menu: sign in, pick a playlist or album, shuffle.
  - A separate music volume.
  - Game-aware touches using volume only, such as ducking during thunder and explosions, or quieter at night.
- **Alternative without a developer account:** the player picks audio files or a folder from their computer. That plays DRM-free iTunes purchases and MP3s through Web Audio, so filtering works, but not songs downloaded from Apple Music (they're protected).
- **Questions:** Apple Music only, or local files too? Should music be per world (a playlist per world) or global?

## 11. Giant trees with tree houses — L (not done)

Huge trees you can climb, with tree houses built into them.

- **Builds on:**
  - Biome trees: `treeAt` / `stampTree` in `terrain.ts` already let trees spread across chunk borders, which a giant needs.
  - Ladders and shaped blocks (platforms from slabs, stairs, fences).
  - Structural integrity: leaves already hold up a treehouse within 2 m of the logs; a giant tree's thick trunk and branches would carry more.
- **Parts:**
  - **Giant trees:** a trunk 2–4 m thick and 30–60 m tall, with roots flaring at the base, branches reaching out 8–15 m, and a canopy in clumps. Probably rare, and in forest or jungle.
  - **Height:** the world is 128 m tall and terrain can reach about 116 m, so giants would need to grow only on low ground, or the build limit would need raising (a memory and generation cost).
  - **Climbing:** trunk-hugging vines or ladder blocks placed in generation, a spiral of branch steps, or letting the player climb bark directly (a new rule, like ladders but on the trunk's surface).
  - **Tree houses:** small generated structures on the big branches: a plank platform with fence railings, walls, a roof, a door, and a rope bridge between neighbouring giants. Perhaps loot or a trader inside (item 6).
  - **New blocks:** perhaps a big-tree log (different colour, a stronger span for structure), vines, and rope for bridges.
- **Questions:**
  - Should tree houses be generated, built by NPCs (item 6), or just possible for the player?
  - How rare? Should a giant tree be visible from a distance as a landmark?
  - Should giant trees be protected from collapse when their trunk is cut, or come crashing down (a big falling-blocks event)?
- **Cost:** a 60 m tree reaches across many chunks at 0.5 m blocks (chunks are 8 m). `treeAt` would need a wider search, or a sparse list of giant-tree sites per region, to stay within the generation budget.

## 12. Electricity — XL

Power made by generators and solar panels, carried by underground cables or overhead lines on poles, and used by electric lights. Many more electrical things later.

- **Builds on:**
  - Crafting (iron, steel, coal, glass).
  - Block light (`light.ts`: an electric light is an emitter that switches on and off).
  - The day/night cycle and weather (solar output follows the sun and cloud cover).
  - Shaped blocks (poles, wires).
- **Parts:**
  - **Network model:** connected components of conductor blocks and cables, found by flood fill and cached per network. They're recomputed only when a conductor is placed or broken, not every frame. Each network adds up supply and demand. When demand exceeds supply, lights dim or brown out (all at once or by priority).
  - **Cables:**
    - Underground: a cable block placed in the ground, or inside other blocks as "wired" variants.
    - Overhead: poles (a shaped block) with wires between them. The wire is drawn as a sagging line mesh, and connections are made by clicking one pole and then another, within a maximum span. Wires between poles aren't blocks, so they need their own save data.
  - **Solar panel:** a recipe (glass, iron or steel, and a new silicon-like ingredient, or just glass and iron to keep it simple). Output follows sky light at the panel, the time of day, and the weather's cloud cover.
  - **Coal generator:** a recipe (iron, steel, furnace). Burns coal from its own small inventory, giving steady power for a set time per coal. This is the first block that holds items, which the furnace doesn't do yet.
  - **Electric lights:** a recipe (glass, iron, copper or wire). An emitter that's lit only while its network has power; a lamp block that switches on and off needs a light update each time.
  - **Later:** switches and buttons, batteries, electric furnaces, pumps (with water flow), powered rail sections (item 2), doors, alarms, and power for NPC markets (item 6).
- **Questions:**
  - Is copper needed (a new ore, which ties in with geology, item 5), or do iron and steel cover wiring?
  - Should networks work in unloaded chunks? A network spanning unloaded chunks would need a saved summary. Simplest: only loaded parts count.
  - Does anything hurt the player (bare wires, lightning striking poles)?
  - How much should the player see: a meter or tooltip showing supply and demand?
- **Suggestion:** start with one network type: an underground cable block, a coal generator, a solar panel and an electric light. Add poles and overhead wires once networks work.

## 13. A round world you can sail around, with larger biomes — XL (not done)

A world of finite size that you can circumnavigate (walk or sail far enough east and you come back from the west), with biomes on a bigger scale: climate by latitude, polar ice caps, and continents and oceans sized for long voyages.

- **Why not a true sphere:** a voxel world on a real sphere means a cube-sphere projection (six curved faces with seams and distorted blocks near the corners) and gravity pointing to the centre. It would also need a rewrite of chunks, physics, lighting (sky light straight down no longer works) and the map. That's far beyond the rest of the backlog.
- **Practical version (Civilization-style):**
  - **East–west wrap:** X wraps at a circumference C (for example 16–32 km). Chunk coordinates are taken modulo C/chunk, so the world is seamless: walking east long enough returns you to the start. Streaming, the edit log, water flow, structure and creature pathfinding all need wrapped neighbour lookups at the seam.
  - **North–south limits:** latitude from Z sets temperature: equatorial jungle and desert, temperate bands, arctic toward the poles, and polar ice caps or an impassable ice wall at the ends. The poles can't wrap too, because a torus isn't a sphere and the map would look wrong.
  - **Seamless noise:** terrain, climate and caves are sampled on a cylinder (X mapped to an angle, via cos/sin in one more noise dimension), so there's no seam at X = C.
  - **Curvature look (optional):** a vertex-shader bend that lowers distant terrain with distance, so the horizon curves and ships sink hull-first. It only changes the view, not physics.
  - **Map:** a world map that wraps east–west, and perhaps a globe view.
- **Larger biomes:**
  - Climate scale grows from about 1 km features to continental bands.
  - Continents several km across with real oceans between them (the continent noise scale also grows), making boats essential.
  - More biomes fit into the bands: taiga, savanna, swamp, mesa. The border rules in `biomes.ts` already blend land shape smoothly.
- **Builds on:** biomes (item 4, `biomes.ts`, `terrain.ts`), rowboats and ships (item 3) for crossing oceans, weather (latitude could set storm frequency), rail (item 2) for long distances.
- **Questions:**
  - How big: a circumference a boat can cross in minutes, hours, or an evening? At 5 m/s, 16 km is about 55 minutes of rowing.
  - Should the poles be reachable ice caps or a hard edge?
  - Should existing worlds stay infinite (a per-world choice at creation), or should all new worlds be round?
  - Does the day/night cycle follow longitude (the sun at different positions around the world) or stay global?
- **Cost:**
  - Every neighbour lookup and chunk key needs to wrap, which touches many systems.
  - Noise on a cylinder costs a little more per column (4D noise, or 3D for 2D fields).
  - Saves need the circumference.
- **Suggestion:**
  1. Start with larger biomes and latitude-based climate on the existing infinite world: cheap, and visible immediately.
  2. Add east–west wrapping as a world option.
  3. Add the curvature shader last.

## 14. Tools and weapons shown in hand — M

What you hold is drawn in the corner of the view and moves when used: a sword swings, a pick strikes, a bucket tips, a spyglass comes up to the eye.

- **Builds on:** the hotbar and items (`blocks.ts`, `icons.ts`), the attack and break actions (their events already say when they happen, in `events.ts`).
- **Parts:** a first-person hand layer drawn over the world (its own scene and camera, so it never clips into walls); a small model per held item (blocks as cubes, tools from the icon shapes); swing, strike and bob animations tied to actions and walking.
- **Multiplayer:** other players show what they hold too (phase 3 draws other players).
- **Questions:** blocky models built from the 16x16 icons (like Minecraft's extruded sprites), or hand-made models per tool?

## 15. NPCs who build and live in settlements — XL (not done)

**Planned in stages** (decided 2026-09-29): 1. outlaws (hostile NPCs in the wild, any time; not done); 2. communities founded with the world, growing a whole building at a time, their buildings written as edits; 3. villagers who live there, defend themselves (against outlaws, and you if you hit them), can be hurt and killed, and whose community remembers; 4. trade with a community; 5. building block by block near the player.


Settlements that grow on their own: NPCs build by the same rules the player does (placing blocks, needing materials and support), expand as they prosper, and fall into ruin when abandoned.

- **Builds on:** item 6 (traders, markets), building and structural integrity (`building.ts`, `structure.ts`), pathfinding (`pathfind.ts`), the Sim (NPCs are more of its creatures).
- **Parts:**
  - Layout by Wave Function Collapse: a tile set of building modules (walls, doors, roofs, streets, fields) with adjacency rules, collapsed over a site so a village fits its terrain and grows outwards over time.
  - NPCs that carry out the plan block by block: fetch materials, walk there, place within reach, obeying support rules (so their buildings stand or fall like the player's).
  - Growth: a settlement's prosperity (trade, food) decides whether it expands.
  - Ruin: abandoned settlements decay: roofs fall in (structural integrity), vegetation creeps over, blocks weather; ruins keep loot.
- **Questions:** how many NPCs can be simulated at once (the phase 2 benchmark puts creature AI at about 2 ms a tick for 96 Lurkers)? Far-away settlements probably grow in coarse steps (whole buildings at once) and only build block by block near players. Saving NPCs and settlements.

## 16. Finer terrain edges, and a stratum of relics — XL

Two ideas about the ground: its edges drawn smoother, and something worth digging for in it.

- **Sub-voxel edges:** terrain surfaces drawn with smaller cubes (a setting, 0.125–0.5 m) where the ground meets air, as leaves already are near the player (the Leaf size setting). Probably by the same approach: a finer mesh near the camera, plain beyond. The world stays 0.5 m blocks; only the drawing changes.
- **Relics:** a layer of archaeological finds (bones, artifacts, scrolls, coins of old civilisations) in particular strata (item 5), rarer and richer deeper and near old sites (and in ruins, item 15), found by careful digging. Traded for a lot of money at markets (item 6): a reason to explore and dig beyond ore.
- **Questions:** does a relic break if you dig it carelessly (a brush tool)? Are they items only, or also blocks you can see in the ground?

## 17. Animals: rabbits, deer and bears — L

Wildlife by biome: rabbits and deer that flee, bears that are meat and a threat.

- **Builds on:** creatures (`mobs.ts`: AI states, pathfinding, spawning, senses), drops and items, health.
- **Parts:** a creature type per animal with its own model, speed and senses; rabbits and deer spawn by day in grassland and forest, flee from players (and bears); bears wander, and charge when close or hurt; each drops meat (and hide?).
- **Needs food:** meat is for eating, and there's no hunger or eating yet. A food system (hunger, cooking at a furnace or fire, item 18) would come with this.
- **Questions:** herds? Breeding, or just spawning? Do animals leave prints in snow (they could, like Lurkers)?

## 18. Heat and fire — XL

Temperature that flows through the world: fire that needs fuel and air, stone that cracks, metal that melts, water that boils to steam, and lava that cools into rock depending on how fast it cools.

- **Builds on:** the cellular systems (water in `fluid.ts`, light in `light.ts`), structural integrity (cracking), blocks (new ones: lava, steam, obsidian-like glassy rock and slower-cooled basalt), weather (rain puts fires out).
- **Parts:**
  - Temperature per cell diffusing by each material's conductivity and heat capacity; only where it differs from its surroundings (see the design rules below: most cells never have a temperature worth tracking).
  - Fire as a reaction: needs fuel (wood, leaves, coal) and air next to it, spreads by heat, produces heat and smoke, burns out.
  - Thresholds per material: stone cracks and weakens (its structural reach drops), metal melts, water boils to steam (a gas that rises and condenses), ice melts.
  - Lava: flows like water, cools by losing heat to what it touches: fast cooling gives glassy rock, slow cooling crystalline rock.
- **Questions:** how much of the world can be hot at once within the tick budget? Probably only near players, like everything else (see the design rules).

## 19. 

## 20. Terrain from tectonic plates, with rivers and water-driven biomes — XL (not done)

Rethink generation from the ground up: a world is a set of tectonic plates, and everything else follows from them and from water.

- **Parts:**
  - **Plates:** each world starts by laying out plates (continental and oceanic).
  - **Mountains where plates meet:** mountain ranges along the joins (colliding plates), replacing the mountain swaths; perhaps rift valleys where plates pull apart.
  - **Oceans between some plates:** large bodies of water separating plates.
  - **Lakes and rivers within each plate** from noise.
  - **Rivers that really flow downhill:** from springs and lakes to the plate's sea, finding their way through the terrain (valleys, meanders, deltas where they meet the sea).
  - **Biomes from water:** lush jungle around water in the equatorial zones, lush forest around water further north and south, grassland farther from water (with sparse clumps of trees), then desert farthest from any water. Moisture from distance to water replaces the moisture noise; latitude still sets temperature.
- **Builds on:** round worlds (item 13), the current climate and biomes (`biomes.ts`), mountain swaths (version 3), savanna groves, and the world map (which will show all of this well). Relates to geology (item 5: plates give faults and intrusions somewhere to be) and erosion (item 8: rivers carve).
- **The hard part:** rivers flowing downhill and "distance from water" aren't local, but chunks are generated one at a time from local noise. This probably needs a coarse world map computed first: plates, heights, drainage (where rivers run), and moisture on a grid of, say, 16–64 m cells. Chunks then sample and detail it.
  - **Round worlds** are finite (32 x 16 km), so the whole map can be computed when the world is made (a few seconds, perhaps in a worker) and kept, or recomputed from the seed.
  - **Endless worlds** can't precompute everything. They would compute it region by region as players go, with rivers allowed to cross region borders.
- **Decided** (2026-09-29):
  1. **Every world is round.** The "Round world" checkbox goes; endless worlds are no longer made. That also settles the hard part: every world can have its coarse map computed whole.
  2. **Every world is 16 x 8 km**, a quarter of today's 32 x 16 km.
  3. **5 to 7 plates per world,** about 70 % water and 30 % land, like the Earth. (Changed later the same day: 7 major plates and about 10 minor ones, 70/30 counted outside the polar ice.)
  4. **Water inside a plate is lakes and inland seas:** lakes up to 100 m across (configurable), inland seas up to 1 km, in the ratio 95 % lakes to 5 % inland seas. (The oceans between plates are separate.)
  5. **Rivers are still water for now;** currents come later.
  6. **This is terrain version 4,** and it may replace existing worlds (they're for testing).
- **Cost:** the coarse map is new work at world creation. Per chunk it should be cheaper than today's many noise layers, since most of the shape comes from sampling the map.

## 21. Survival progression: ores, tools, furnace and cooking — L

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

## 22. Caves, and light to see by — L

There's nothing underground but solid rock, and nothing gives light but the sun.

- **Builds on:** plate terrain and chunk generation (`plates.ts`, `terrain.ts`, made off the main thread in `genWorker.ts`), the mesher and lighting (`mesher.ts`, `lighting.ts`, `voxelMaterial.ts`).
- **Parts:**
  - **Caves:** tunnels and caverns from 3D noise (worms and chambers), kept out of the sea and away from the surface in most places, with entrances in cliffs and valleys. They'd make ores (item 21) worth exploring for.
  - **Block light:** emitters (torches, lamps, lava) lighting their surroundings, worked out per chunk in the mesher and passed across chunk borders. Sky light falling short underground, so caves are dark.
  - **Torches:** a recipe (sticks and coal), placed on walls or floors as an object, like fences.
  - Zombies spawning in the dark, not just at night.
- **Questions:** light as a vertex value (cheap, blocky) or a 3D light texture per chunk (smooth)? How far does light reach, and at what cost when a torch is placed (re-meshing the chunks it reaches)?
- **Cost:** caves change terrain everywhere, so it's a new terrain version (the disk cache is already versioned by terrain).

## 23. Sound — M

The only sound is an explosion's boom. Item 1 (thunder) and item 10 (music) both assume an audio system.

- **Builds on:** the boom in `explosions.ts` (Web Audio, delayed by distance).
- **Parts:** one audio manager (volume settings, master, effects, music); positional sounds (panning and fall-off with distance) for footsteps by material, mining and placing, doors and gates, splashes and swimming, mobs (pigs, zombies), hurt, eating; ambient beds by biome and time (wind, birds by day, crickets at night, the sea near the shore).
- **Questions:** made sounds (synthesised, like the boom) or recorded samples (better, but they need finding and licensing)? Other players' sounds too (their footsteps, their mining)?

## 24. Playing together: chat, player list, names — M

Several players can share a world, but they can't talk, and there's no way to see who's on.

- **Builds on:** the WebSocket protocol (`protocol.ts`), accounts and sign-in (`accounts.ts`, `auth.ts`), entities (other players are drawn already), the dashboard (admins see players).
- **Parts:** text chat in a world (Enter to type, messages fading over the view, a short history); a player list (Tab is the tool mode, so another key); names over players' heads; admin commands from chat (kick, set time, set mode, teleport a player).
- **Questions:** moderation (mute, rate limits, a word filter) once the game is public? Chat across worlds, or per world only?

## 25. Building tools for creative — L

Creative has big boxes (up to 16 m) but no way to undo a mistake or repeat a build.

- **Builds on:** edits and big boxes (`edit.ts`: fillBox, removeBox; `editTool.ts`), the world's edit store (`chunkStore.ts`), the terraformer's undo (`terraformDraft.ts`).
- **Parts:**
  - **Undo and redo** of your own edits (the server keeps what each edit replaced, for a while).
  - **Select, copy, paste:** select a box, copy it, paste it elsewhere, rotated or mirrored.
  - **Blueprints:** copies saved to your account, to paste in any world (stored in Supabase alongside inventories).
  - **Replace:** turn one material into another within a selection; hollow out; walls only.
  - **Shapes:** spheres, cylinders and lines, not just cubes.
- **Questions:** how far back does undo go, and does it survive a reload? What happens to an undo when someone else has built over the same place since?

## 26. Saving the player — S

Health and food reset when the page reloads (an easy cheat in survival), and dying always sends you back to the world's spawn point.

- **Builds on:** inventories saved per account and world (`inventories.ts`), the vitals the server keeps (`survival.ts` Vitals), respawning (`app.ts`).
- **Parts:** save health, food, breath and position with the inventory (on leaving, and every so often); a bed (a recipe) that sets where you come back to; perhaps a death penalty (drop part of the inventory where you died, to go back for).

## 27. The server: heavy work off the main thread — L

One thread does everything that changes the world: a 16 m blast's carving holds up every player in every world for about 0.4–0.7 s (more on Railway), and water steps, edits and mob AI all queue behind it. The server has 32 cores.

- **Builds on:** the generation pool (`genPool.ts`, `genWorker.ts`), the blast loop (announce, then carve, `explosives.ts`), the per-world water flow and mob managers.
- **Parts:**
  - **Carving in a worker:** a blast's chunks sent to a worker, carved there, the changed chunks sent back (the bang and dust are already separate, so nothing visible waits on it).
  - **A world per thread:** each open world's simulation (water, mobs, explosions) in its own worker, so a busy world doesn't slow the others.
  - **Tiles that show edits:** distant tiles are made from the generator, so craters and buildings vanish when you fly fast (only voxel chunks show them). Tiles for edited ground could be remade from the edited chunks.
  - **The browser's blast dust** sampled in a worker too (it takes up to about 120 ms on the main thread for a 16 m blast).
- **Questions:** how do chunks move between threads cheaply (transfer the encoded bytes; the world's caches are per thread)?

## 28. Fair play: the server checks movement — M

The server takes the client's word for where a player is and how hard they landed: fall damage is reported by the client, and a changed client could fly in survival or move impossibly fast.

- **Builds on:** walking physics shared by client and server (`walking.ts`, `physics.ts`), poses (`app.ts`), mining checks (the server already checks mining time).
- **Parts:** the server checks each pose against what walking allows (speed, gravity, no passing through solid voxels), corrects or rejects impossible ones, and works out falls itself from the poses; rate limits on edits and attacks.
- **Questions:** how much latency to allow for (a laggy player looks like a fast one)? Only in survival (creative flies anyway)?

## 29. Worlds you can keep: backups, export and history — M

Worlds live on one Railway volume; a bad edit (or a big blast in the wrong place) can't be undone, and a world can't be moved or shared.

- **Builds on:** world files and the edit store (`worldFile.ts`, `chunkStore.ts`), the dashboard, Railway's volume.
- **Parts:** scheduled backups (to object storage); restoring a world, or just an area of it, to an earlier time; export and import of a world (its settings, strokes and edits) as a file; per-area history in the dashboard (who changed what, when).
- **Questions:** how long to keep backups, and how big do edit stores get (a 16 m blast writes a lot of small voxels)?

## 30. UI re-vamp — M (not done; wireframes from the user, 2026-10-05)

Every page gets one look: a header bar (title, navigation, a fullscreen button at its right).

- **Landing page** (top to bottom): title; sign-in information; a big picture of the selected world; that world's details; the world selector; then a row of four buttons: world management, object designer, settings, **PLAY**.
- **World management** (today's dashboard and world tools in one): header; server status; the last five minutes (the dashboard's history); the world list, each row its columns of details and buttons for mode, terraform, find site, make claim; a "generate new world" button at the bottom left (the world generator).
- **Object designer:** header; object list on the left, the workspace in the middle, the palette on the right.
- **Settings** (its own page, not a panel): header; the settings area; at the bottom, reset to defaults (left), cancel and save (right).
- **Questions:** where the Terraformer, Site finder and Claims pages go (from the world list's buttons, per the wireframe, rather than the landing page?); what the world picture is (the map, the 3D relief, a saved snapshot?); whether the game itself gets the header.

## Design rules (from engineering advice, to keep to as systems are added)

- **Keep the voxel compact.** A cell is a 1-byte block id (a global palette of up to 256) plus a byte of light; water's level is part of the block id; structural stress is worked out when needed, not stored. New per-cell state (temperature, fire, moisture) goes in sparse per-chunk maps holding only the cells that have it, never as a new array for every cell.
- **Budget the simulation.** Every cellular system (water, falling blocks, heat, fire, erosion) competes for the same tick. Aim for a global scheduler with a time budget per system and active-region tracking (only chunks with something happening, near players, get ticked), and run the simulation off the render thread (a worker in the browser, the game server in multiplayer) with double-buffered chunk state for the view to read.

## Decisions so far

## Suggested order
