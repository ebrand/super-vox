# Backlog

Ideas queued for later, in the order they were proposed. Each has a rough size, the systems it touches, and the questions to settle before building it. Sizes are relative: **S** is an afternoon-sized change like buckets, **M** is like shaped blocks or crafting, **L** is like structural integrity plus cave-ins, **XL** is bigger than anything built so far. Finished work is in BACKLOG-DONE.md; an item that's partly done has its done part there and its remainder here.

## 3. Block-built ships — L

The rowboat is done (a design in the boat slot, rowed on water: see BACKLOG-DONE.md). What's left is a sailable ship built from blocks.

- **Parts:** many blocks moving as one body, with its own mesh and collision; sails or an engine; mooring.
- **Questions:**
  - The engine can't yet move a group of blocks as one thing. Trains move as designs, not as player-built blocks: would ships work the same way (a design per ship)?
  - Should NPC ships sail and trade between trading posts?

## 7. Path erosion and footprints in snow — M

- **Parts:**
  - Footprints: marks in snow where the player (and creatures) walk. They could be decals on the snow surface rather than block changes, fading or filled in by snowfall (ties in with weather).
  - Path erosion: grass that's walked on often wears to dirt, then to a path block. This needs a per-cell wear counter, and storing it only for cells actually walked on keeps it cheap. It's saved like edits.
- **Questions:**
  - Should footprints persist across saves? If so they need a cap or fading so the save doesn't grow forever.
  - At 0.5 m blocks, do footprints mark whole blocks (lowering snow a layer) or just the surface?

## 8. Erosion — XL

Rivers slowly carve channels, rain wears cliffs down, wind drifts sand into dunes, and snow builds up and melts with the seasons.

- **Builds on:** water flow, weather, biomes, rivers (generated now), falling blocks and structure (collapsing banks).
- **Parts:**
  - Rivers: slow erosion where water flows. For example, flowing water occasionally removes a soft block beside or under it and drops it downstream.
  - Rain wearing cliffs: occasional loosening of exposed soft blocks during rain, feeding the falling-block system.
  - Wind: sand blocks hopping downwind in deserts to build dunes.
  - Seasons: a year cycle alongside the day cycle, with snow layers that build up in winter and melt in spring. Snow layers need a partial-height snow block.
- **Hard parts:**
  - It all has to happen in loaded chunks only and within a frame budget.
  - It changes the world constantly, so saves grow and players' builds get eroded. That may need protection, such as player-placed blocks not eroding.
  - Seasons touch lighting, colors and gameplay everywhere.
- **Suggestion:** do it last, and start with one mechanism (snow build-up and melt, or river bank erosion) rather than all four.

## 9. Guns and ammunition — XL

Outlaws are done (camps, swords and bows: see item 15 in BACKLOG-DONE.md). What's left is guns: a handgun and a rifle to craft, ammunition for each, and shooting with damage.

- **Builds on:** outlaws and their arrows (`outlawSim.ts`, `arrowFlights.ts`), weapons, crafting stations, iron, sound (gunshots are the loudest thing in the game).
- **Parts:**
  - **Recipes:** a handgun and a rifle made at a new station (steel barrel, wooden stock, iron parts). Ammunition crafted in batches.
  - **Gunpowder:** there's none yet. It needs new ores or items (saltpeter and sulfur alongside coal), which is also what TNT would need to be made from something other than sand.
  - **Shooting:** a hitscan ray against creatures and blocks. Damage by gun, falling off with range. Rate of fire, magazine size, reloading, recoil or spread, muzzle flash and a tracer. Ammunition is used from the inventory.
  - **Outlaws with guns:** some outlaws carrying them, keeping their distance and taking cover.
- **Questions:**
  - Aiming down sights or zooming with the rifle?
  - Do bullets break glass and leaves, or pass through water?
- **Needs:** armor (item 35) first, since damage to the player goes up sharply with guns.

## 10. Music from Apple Music — M

Play tunes from the player's Apple Music library inside the game.

- **How:** Apple's MusicKit JS. The page signs the player in with their Apple ID, then can search and play their library and the catalog. Full songs need an active Apple Music subscription.
- **Needs:**
  - An Apple Developer account ($99 a year) to create a MusicKit key.
  - A developer token: a JWT signed with that key, valid for up to 6 months, handed out by the server (the private key must never ship in the page).
- **Limits:**
  - Apple plays the music through its own DRM-protected player, not the game's Web Audio graph.
  - The game can play, pause, skip and set the volume, but can't filter it (no muffling underwater or indoors).
  - The browser needs a user gesture to start playback (the pointer-lock click works).
- **Parts:**
  - A music panel in the pause menu: sign in, pick a playlist or album, shuffle.
  - A separate music volume.
  - Game-aware touches using volume only, such as ducking during thunder and explosions, or quieter at night.
- **Alternative without a developer account:** the player picks audio files or a folder from their computer. That plays DRM-free purchases and MP3s through Web Audio, so filtering works, but not songs downloaded from Apple Music (they're protected).
- **Questions:** Apple Music only, or local files too? Should music be per world (a playlist per world) or global?

## 11. Giant trees with tree houses — L

Huge trees you can climb, with tree houses built into them.

- **Builds on:**
  - Biome trees: `treeAt` / `stampTree` in `terrain.ts` already let trees spread across chunk borders, which a giant needs.
  - Ladders and shaped blocks (platforms from slabs, stairs, fences).
  - Structural integrity: leaves already hold up a treehouse within 2 m of the logs; a giant tree's thick trunk and branches would carry more.
- **Parts:**
  - **Giant trees:** a trunk 2–4 m thick and 30–60 m tall, with roots flaring at the base, branches reaching out 8–15 m, and a canopy in clumps. Probably rare, and in forest or jungle.
  - **Height:** terrain can reach about 116 m of the world's 128, so giants would need to grow only on low ground, or the build limit would need raising (a memory and generation cost).
  - **Climbing:** trunk-hugging vines or ladder blocks placed in generation, a spiral of branch steps, or letting the player climb bark directly.
  - **Tree houses:** small generated structures on the big branches: a plank platform with fence railings, walls, a roof, a door, and a rope bridge between neighboring giants. Their pieces could be Object Designer slots, like cottages.
  - **New blocks:** perhaps a big-tree log (different color, a stronger span for structure), vines, and rope for bridges.
- **Questions:**
  - Should tree houses be generated, built by villagers, or just possible for the player?
  - How rare? Should a giant tree be visible from a distance as a landmark?
  - Should giant trees be protected from collapse when their trunk is cut, or come crashing down?
- **Cost:** a 60 m tree reaches across many chunks. `treeAt` would need a wider search, or a sparse list of giant-tree sites per region, to stay within the generation budget.

## 12. Electricity — XL

Power made by generators and solar panels, carried by underground cables or overhead lines on poles, and used by electric lights. Many more electrical things later.

- **Builds on:** crafting (iron, coal; copper exists now, as ore and coins), block light (`light.ts`: an electric light is an emitter that switches on and off), the day/night cycle and weather (solar output follows the sun and cloud cover), furnaces (a station with its own contents, kept by the server).
- **Parts:**
  - **Network model:** connected components of conductor blocks and cables, found by flood fill and cached per network. They're recomputed only when a conductor is placed or broken. Each network adds up supply and demand; when demand exceeds supply, lights dim or brown out.
  - **Cables:** underground (a cable block, or "wired" variants of others) and overhead (poles with sagging wires between them, connected by clicking one pole then another, within a maximum span; wires need their own save data).
  - **Solar panel:** glass (item 21) and iron; output follows sky light, the time of day and cloud cover.
  - **Coal generator:** burns coal from its own small inventory, like a furnace.
  - **Electric lights:** glass, iron and copper; lit only while their network has power.
  - **Later:** switches, batteries, electric furnaces, pumps, powered rail, doors, alarms, power for villages.
- **Questions:**
  - Should networks work in unloaded chunks? Simplest: only loaded parts count.
  - Does anything hurt the player (bare wires, lightning striking poles)?
  - How much should the player see: a meter or tooltip showing supply and demand?
- **Suggestion:** start with an underground cable block, a coal generator, a solar panel and an electric light. Add poles and overhead wires once networks work.

## 15. Settlements: what's left — L

Stages 1–5 are done (outlaws, villages, villagers who fight back and hold grudges, trade, building a block at a time while watched: see BACKLOG-DONE.md).

- **Ruin:** abandoned villages decay: roofs fall in, vegetation creeps over, blocks weather; ruins keep loot.
- **Layout:** villages are laid out by a fixed plan (cottages round a middle, a wall at 14 villagers). A Wave Function Collapse layout (modules for walls, doors, roofs, streets, fields with adjacency rules) would fit them to their terrain and let them grow outwards.
- **More buildings:** a well, a market, barns, a chapel, as Object Designer slots like the cottage (each a role with many designs).
- **Known compromises:**
  - Builders in watched villages stop at night; unwatched villages keep building through it.
  - Outlaws exist as creatures only near players (records elsewhere); far-off camps don't fight villages.
  - "Go" on the Places panel can land you on the forest canopy.
- **A creative tool to found a village where you stand** (for testing designs without waiting for wanderers to meet).

## 16. Finer terrain edges, and a stratum of relics — XL

Two ideas about the ground: its edges drawn smoother, and something worth digging for in it.

- **Sub-voxel edges:** terrain surfaces drawn with smaller cubes (a setting, 0.125–0.5 m) where the ground meets air, as leaves already are near the player (the Leaf size setting). Probably by the same approach: a finer mesh near the camera, plain beyond. The world stays 0.5 m blocks; only the drawing changes.
- **Relics:** a layer of archaeological finds (bones, artifacts, scrolls, coins of old civilizations) in particular strata, rarer and richer deeper and near old sites (and in ruins, item 15), found by careful digging. Sold for a lot at trading posts: a reason to explore and dig beyond ore.
- **Questions:** does a relic break if you dig it carelessly (a brush tool)? Are they items only, or also blocks you can see in the ground?

## 17. Animals: rabbits, deer and bears — L

Pigs are the only animal (with zombies and outlaws as the other creatures). The rest of this item hasn't been started.

- **Builds on:** creatures (`mobs.ts`: AI states, pathfinding, spawning, senses), drops, food and cooking (the stove).
- **Parts:** a creature type per animal with its own model, speed and senses; rabbits and deer spawn by day in grassland and forest, flee from players (and bears); bears wander, and charge when close or hurt; each drops meat (and hide, for armor: item 35?).
- **Questions:** herds? Breeding, or just spawning? Do animals leave prints in snow?

## 18. Heat and fire — XL

Temperature that flows through the world: fire that needs fuel and air, stone that cracks, metal that melts, water that boils to steam, and lava that cools into rock depending on how fast it cools.

- **Builds on:** the cellular systems (water in `fluid.ts`, light in `light.ts`), structural integrity (cracking), blocks (new ones: lava, steam, obsidian-like glassy rock and slower-cooled basalt), weather (rain puts fires out).
- **Parts:**
  - Temperature per cell diffusing by each material's conductivity and heat capacity; only where it differs from its surroundings (see the design rules below: most cells never have a temperature worth tracking).
  - Fire as a reaction: needs fuel (wood, leaves, coal) and air next to it, spreads by heat, produces heat and smoke, burns out.
  - Thresholds per material: stone cracks and weakens, metal melts, water boils to steam (a gas that rises and condenses), ice melts.
  - Lava: flows like water, cools by losing heat to what it touches: fast cooling gives glassy rock, slow cooling crystalline rock.
- **Questions:** how much of the world can be hot at once within the tick budget? Probably only near players, like everything else.

## 21. Survival recipe gaps — M

Ores, tools, the furnace, the stove and cooking are done (see BACKLOG-DONE.md). These things exist but can't be had or used in survival:

- **Saplings:** leaves and needles drop nothing, so trees can't be replanted and wood runs out where you cut.
- **Glass:** sand's only use is TNT; nothing makes glass (needed for windows, and later solar panels and lights).
- **Stone and bricks:** mined stone gives cobblestone, which can't be made back into stone or into bricks.
- **C4:** placeable in creative, with no recipe.
- **Anvil and smithing table:** they have Object Designer slots but no recipe and no use.
- **Tools don't wear out**, so there's nothing to keep making once you have iron ones.

## 25. Building tools for creative — L

Creative has big boxes (up to 16 m) but no way to undo a mistake or repeat a build.

- **Builds on:** edits and big boxes (`edit.ts`: fillBox, removeBox; `editTool.ts`), the world's edit store (`chunkStore.ts`), the terraformer's undo (`terraformDraft.ts`), the Object Designer's shapes (line, box, circle, dome, sphere).
- **Parts:**
  - **Undo and redo** of your own edits (the server keeps what each edit replaced, for a while).
  - **Select, copy, paste:** select a box, copy it, paste it elsewhere, rotated or mirrored.
  - **Blueprints:** copies saved to your account, to paste in any world.
  - **Replace:** turn one material into another within a selection; hollow out; walls only.
  - **Shapes:** spheres, cylinders and lines in the world, as the designer has them.
- **Questions:** how far back does undo go, and does it survive a reload? What happens to an undo when someone else has built over the same place since?

## 26. Dying costs something — S

Health, food and position are saved now, and a bed sets where you come back to (see BACKLOG-DONE.md). But dying costs nothing: you keep everything you carry.

- **Parts:** on death, drop part or all of the inventory where you died, as a pile to go back for (lasting a while, then gone); perhaps keep the hotbar.
- **Questions:** how much is dropped? Can other players take it? Survival only, surely.

## 28. Fair play: the server checks movement — M

The server takes the client's word for where a player is and how hard they landed: fall damage is reported by the client, and a changed client could fly in survival or move impossibly fast.

- **Builds on:** walking physics shared by client and server (`walking.ts`, `physics.ts`), poses (`app.ts`), mining checks (the server already checks mining time).
- **Parts:** the server checks each pose against what walking allows (speed, gravity, no passing through solid voxels), corrects or rejects impossible ones, and works out falls itself from the poses; rate limits on edits and attacks.
- **Questions:** how much latency to allow for (a laggy player looks like a fast one)? Only in survival (creative flies anyway)?

## 29. Disaster recovery: backups off the volume, and restoring — M

Every world, the design library, the meshes and animations, and Synchronize's backups all live on one Railway volume per environment. If that volume is lost, so is all of it. Synchronize keeps what it replaces (the last five syncs), but on that same volume, and restoring is by hand.

- **Builds on:** Synchronize's packing (`sync.ts`: a world as one stream, the libraries as JSON), world files and the edit store (`worldFile.ts`, `chunkStore.ts`), World management.
- **Parts:**
  - **Scheduled backups off the volume:** each world and library packed and sent to object storage (S3, R2 or Railway's own) daily, kept for a while.
  - **Restoring:** from a sync backup or a scheduled one, on World management: a world, or a library, back to an earlier copy, with a button rather than by hand.
  - **Disk use:** World management showing how full the volume is, and warning before it's full (backups and big worlds grow it).
  - **Later:** restoring just an area of a world; per-area history (who changed what, when).
- **Questions:** how long to keep backups? Which storage (cost, and the credentials it needs)?

## 31. Import 3D meshes — M

Bring in models made elsewhere (Blender, MagicaVoxel, downloaded) instead of building everything voxel by voxel in the Object Designer or the mesh editor.

- **Parts:**
  - **Voxel models** (MagicaVoxel `.vox`): read straight into an Object Designer design, each voxel becoming one of the design's (colors matched to the nearest design material).
  - **Ordinary meshes** (`.obj`, `.glb`/glTF): voxelized at a chosen size (1/16–1 m) into a design, or used as a player figure in the mesh editor.
- **Questions:** which formats first? Should colors be matched to materials, or should designs allow free colors? How big a model is allowed (designs have a voxel limit)?

## 34. Tests that run on every push — M

Today the tests run only when they're run by hand before a push. There's no CI, and no automated tests of the game in a browser: the game page, the designer and survival play have been checked by hand, or not at all.

- **Parts:**
  - **CI:** GitHub Actions running typechecks and the full suite on every push and pull request, and gating merges to main.
  - **Browser tests:** a small Playwright suite against a test server: the landing page loads, the game joins a world and draws it, a block is placed and removed, the designer opens and saves, an admin page refuses a non-admin.
- **Questions:** run the browser tests on every push, or nightly (they're slower, and need a GPU-less WebGL)?

## 35. Armor — M

Outlaws with swords and bows hurt now, and guns (item 9) would hurt more. There's nothing to wear.

- **Builds on:** health and damage (`survival.ts`), the inventory window, figures (players drawn from the mesh editor's meshes), recipes, iron ingots.
- **Parts:** pieces (helmet, chestplate, leggings, boots) in leather, iron and more; worn in slots of their own; each cutting damage by a share; shown on the player's figure; wearing out with hits.
- **Questions:** see the design notes when it's built.

## 36. Errors you'd notice — S

World management lists recent errors, but only while someone's looking at it. Nothing says when something goes wrong on production.

- **Parts:** errors on production (and failed syncs, a full disk, a crash and restart) sent somewhere you'd see them: an email, a push notification, a Slack or Discord message.
- **Questions:** which channel? How many is too many (one a day summing them up, or each as it happens)?

## 37. A new player's first steps — M

Nothing teaches a new player what to do: punch a tree, make planks, a crafting table, tools; where the trading posts and villages are.

- **Parts:** a short list of goals shown in the corner until done (each ticked as it happens, as the server sees it); hints when stuck (no tools after five minutes: "craft planks from wood"); the recipe list pointing at what can be made now.
- **Questions:** survival only? Shown once per account, or per world?

## 38. Smaller ideas

- **Trading between players:** offering items for items or coins, both agreeing.
- **Your own map markers:** pins with names on the map (M), kept per account and world.
- **Touch controls:** the game has none, so it can't be played on a phone or tablet.

## 39. Aqueducts — L

Like railways, but above ground: a raised channel on arches carrying water from a large water source (a lake, a big river, the sea's edge, if fresh) across country to dry land (deserts, dry grassland, a village far from water).

- **Builds on:**
  - Railways: routes drawn on the map (`rail.ts`: a smooth line kept to a gentle grade, built through and over the land), and building them in the world from the route.
  - Water (`fluid.ts`: poured water is finite and flows; natural water stands still), lakes and rivers (generated), farming, villages, the Object Designer (arch and channel pieces as slots, like the railway station).
- **Parts:**
  - **A route on the map:** from a point on a large body of water to its end, falling gently all the way (water must run downhill), drawn and checked like a railway.
  - **Built above ground:** a channel on arches or piers, high enough to cross valleys and low ground; through or over hills (a cut, a tunnel, or taller arches). The arch and channel pieces could be Object Designer slots, each with many designs.
  - **Water that keeps flowing:** water in the channel is topped up from its source, so it doesn't run out (unlike a poured bucket); at its end it fills a basin or cistern, and spills onto the land around.
  - **What it does at the end:** dry land made fertile (grass and farmland near the outflow, wheat growing there); a village in a dry place able to grow; fountains, and later mills (power for item 12?).
  - **Villages building them:** a prosperous village in a dry place building one from the nearest large water.
- **Questions:**
  - Drawn on the map by players (like railways), built by villages, or both?
  - Should it cost materials (stone or cobblestone by length) in survival, as track costs rails?
  - Does water flow in it with no one near (the world's water only flows near players today), or is its effect at the end simply kept on while it stands?
  - Does a broken arch spill the water out, and dry up the end?

## Design rules (from engineering advice, to keep to as systems are added)

- **Keep the voxel compact.** A cell is a 1-byte block id (a global palette of up to 256) plus a byte of light; water's level is part of the block id; structural stress is worked out when needed, not stored. New per-cell state (temperature, fire, moisture) goes in sparse per-chunk maps holding only the cells that have it, never as a new array for every cell.
- **Budget the simulation.** Every cellular system (water, falling blocks, heat, fire, erosion) competes for the same tick. Aim for a global scheduler with a time budget per system and active-region tracking (only chunks with something happening, near players, get ticked), and run the simulation off the render thread (a worker in the browser, the game server in multiplayer) with double-buffered chunk state for the view to read.

## Suggested order

1. Item 29 (disaster recovery) and item 34 (CI): the cost of losing prod's volume, or shipping a break, grows with everything built on it.
2. Items 21 and 35 (recipe gaps, armor): survival is otherwise complete.
3. Item 26 (dying costs something) and item 36 (errors you'd notice): small.
4. Then by interest: item 17 (animals), item 25 (creative tools), item 15's remainder, the rest.
