# Backlog

Ideas queued for later, in the order they were proposed. Each has a rough size, the systems it touches, and the questions to settle before building it. Sizes are relative: **S** is an afternoon-sized change like buckets, **M** is like shaped blocks or crafting, **L** is like structural integrity plus cave-ins, **XL** is bigger than anything built so far.

## 3. Ships on the ocean — L

- **Parts:** a boat as a vehicle floating on water, steered by the player; buoyancy and drag; possibly larger ships made of blocks (a moving structure), which is much harder.
- **Questions:**
  - A small boat item, like Minecraft's, is simple.
  - A sailable ship built from blocks means moving many blocks as one body. That needs a separate mesh and collision for the moving part, which the engine can't do yet.
  - Should NPC ships sail and trade (item 6)?
- **Suggestion:** start with a rowable boat; decide on block-built ships later.

## 6. NPCs who build markets and buy goods — XL

Characters who set up market stalls and buy ore, iron, steel and tools.

- **Builds on:**
  - Creature AI and pathfinding (`mobs.ts`, `pathfind.ts`).
  - Items and inventory, crafting, and the shaped building blocks.
- **Parts:**
  - Friendly NPCs (a new creature type with its own look).
  - A currency: coins, smelted from copper and gold (decided 2026-10-06; see item 5, phase 3).
  - A trade UI: talk to an NPC and see its offers.
  - Market stalls or settlements, either generated with the world or built by the NPCs over time.
  - Prices, perhaps rising and falling with supply.
- **Questions:**
  - Do NPCs really build (placing blocks over time, which is hard: they need plans and pathfinding to reach each block), or do markets just appear?
  - Do Lurkers attack NPCs?
  - What can the player buy with the money?
  - Should NPCs be saved? Nothing creature-like is saved today.
- **Suggestion:** a first cut could be a generated trading post with a stationary trader and a fixed price list. Wandering and building NPCs would come later.

## 7. Path erosion and footprints in snow — M

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

## 11. Giant trees with tree houses — L

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

## 15. NPCs who build and live in settlements — XL

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

## 18. Heat and fire — XL

Temperature that flows through the world: fire that needs fuel and air, stone that cracks, metal that melts, water that boils to steam, and lava that cools into rock depending on how fast it cools.

- **Builds on:** the cellular systems (water in `fluid.ts`, light in `light.ts`), structural integrity (cracking), blocks (new ones: lava, steam, obsidian-like glassy rock and slower-cooled basalt), weather (rain puts fires out).
- **Parts:**
  - Temperature per cell diffusing by each material's conductivity and heat capacity; only where it differs from its surroundings (see the design rules below: most cells never have a temperature worth tracking).
  - Fire as a reaction: needs fuel (wood, leaves, coal) and air next to it, spreads by heat, produces heat and smoke, burns out.
  - Thresholds per material: stone cracks and weakens (its structural reach drops), metal melts, water boils to steam (a gas that rises and condenses), ice melts.
  - Lava: flows like water, cools by losing heat to what it touches: fast cooling gives glassy rock, slow cooling crystalline rock.
- **Questions:** how much of the world can be hot at once within the tick budget? Probably only near players, like everything else (see the design rules).

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

## 31. Import 3D Meshes

## 32. Rail Stations

Let the player place a station that attaches to an existing rail line. The station should be to allow people to get on/off as well as villagers to load/unload cargo.

If a rail station is located near a village, its villagers use the station to 'commute' from one village to another or to a trading post and back.

## 33. Rail Lines

Allow the player to define a raile line route bewteen stations on a line. Once the line is defined, the train should auto-tavel between each station, stopping for a few minutes ate each (configurable?) to allow villagers to get on/off nd for cargo to be loaded/unloaded.

## Design rules (from engineering advice, to keep to as systems are added)

- **Keep the voxel compact.** A cell is a 1-byte block id (a global palette of up to 256) plus a byte of light; water's level is part of the block id; structural stress is worked out when needed, not stored. New per-cell state (temperature, fire, moisture) goes in sparse per-chunk maps holding only the cells that have it, never as a new array for every cell.
- **Budget the simulation.** Every cellular system (water, falling blocks, heat, fire, erosion) competes for the same tick. Aim for a global scheduler with a time budget per system and active-region tracking (only chunks with something happening, near players, get ticked), and run the simulation off the render thread (a worker in the browser, the game server in multiplayer) with double-buffered chunk state for the view to read.

## Decisions so far

## Suggested order
