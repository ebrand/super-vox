import { BLOCK_SIZE, isGridSize } from './chunk.js';
import type { BlockVoxel } from './edit.js';
import { ALL_ITEMS, Item, isBlock, setExtraItems, type ItemId } from './items.js';
import { Material, type MaterialId } from './materials.js';
import type { RecipeGroup } from './recipes.js';
import { setExtraRecipes, type Recipe } from './recipes.js';

/**
 * Objects designed by admins with the designer (designer.html): built of voxels (1/16 m to 1 m)
 * inside a box of whole blocks (up to DESIGN_MAX_BLOCKS a side), in one or more states (a
 * right-click steps through them: open and shut, lit and not...), each its own item, made in
 * survival by its recipe (if it has one). One library for every world (see the server's
 * DesignLibrary); clients are sent it, and both register it (setDesigns) so its items and recipes
 * are known like the built-in ones.
 *
 * Voxels are in design units: (0, 0, 0) is the box's corner at its least x, y and z; the box is
 * size[0] blocks along x, size[1] up and size[2] along z. As drawn, the design faces north (-Z): its
 * front is its +Z side, toward whoever places it (see designBlocks for the other facings).
 */
export interface DesignState {
  name: string;
  voxels: BlockVoxel[];
}

export interface DesignRecipe {
  /** What it takes (as recipes count them: blocks whole, items one by one). */
  inputs: [ItemId, number][];
  /** How many it makes. */
  count: number;
  /** Only by a crafting table (see Recipe.table). */
  table: boolean;
}

export interface ObjectDesign {
  /** Its name in URLs and placed objects: lower case letters, digits and dashes. */
  id: string;
  name: string;
  /** Blocks along x, y and z (each 1 to DESIGN_MAX_BLOCKS). */
  size: [number, number, number];
  states: DesignState[];
  /** The item it is in inventories (given by the library: FIRST_DESIGN_ITEM and up, never reused). */
  item: ItemId;
  /** How it's made in survival; null: it isn't (creative only). */
  recipe: DesignRecipe | null;
  /**
   * The station it stands in for in the game, if any (one design at most for each: see STATIONS):
   * that station's item places it (and its recipe makes it), it gives one back when taken down, and
   * what needs the station works beside it. It has no item or recipe of its own (its `item` number
   * and `recipe` are kept, unused).
   */
  role?: DesignRole;
}

export type DesignRole = 'crafting-table' | 'furnace' | 'stove' | 'anvil' | 'smithing-table';

/**
 * The stations a design can stand in for: each one's item, what it's for, and how it's made (null:
 * the crafting table's built-in recipe, or not yet: creative only). Recipes and items of those no
 * design stands in for aren't in play.
 */
export const STATIONS: readonly { role: DesignRole; name: string; item: ItemId; use: string; recipe: Omit<DesignRecipe, 'count'> | null }[] = [
  { role: 'crafting-table', name: 'crafting table', item: Item.CraftingTable, use: 'making what needs a crafting table', recipe: null },
  { role: 'furnace', name: 'furnace', item: Item.Furnace, use: 'smelting (coming with ores)', recipe: { inputs: [[Material.Cobblestone, 8]], table: true } },
  { role: 'stove', name: 'stove', item: Item.Stove, use: 'cooking (coming)', recipe: { inputs: [[Material.Cobblestone, 6], [Material.Planks, 2]], table: true } },
  { role: 'anvil', name: 'anvil', item: Item.Anvil, use: 'repairing and naming (coming with metals)', recipe: null },
  { role: 'smithing-table', name: 'smithing table', item: Item.SmithingTable, use: 'metal tools and armour (coming with metals)', recipe: null },
];
export const DESIGN_ROLES: readonly DesignRole[] = STATIONS.map((s) => s.role);

export function stationOf(role: DesignRole): (typeof STATIONS)[number] {
  return STATIONS.find((s) => s.role === role)!;
}

/** The biggest a design can be: 4 m a side. */
export const DESIGN_MAX_BLOCKS = 4;
export const DESIGN_MAX_STATES = 8;
/** Voxels in a state, at most. */
export const DESIGN_MAX_VOXELS = 20000;
/** Designs' items are numbered from here. */
export const FIRST_DESIGN_ITEM = 20000;
/** Kinds of ingredient a recipe can take (as many as a crafting table's slots). */
export const DESIGN_MAX_INPUTS = 7;

/**
 * What designs can be built of: the solid materials players have, and the metals. (Not water, not
 * explosives, and not the built-in objects' own materials: a click on those means those objects.)
 */
export const DESIGN_MATERIALS: readonly MaterialId[] = [
  Material.Planks,
  Material.Wood,
  Material.Cobblestone,
  Material.Stone,
  Material.DarkMetal,
  Material.LightMetal,
  Material.Dirt,
  Material.Grass,
  Material.Sand,
  Material.DesertSand,
  Material.Snow,
  Material.Ice,
  Material.Leaves,
  Material.Needles,
  Material.JungleLeaves,
  Material.AcaciaLeaves,
  Material.Meadow,
  Material.JungleFloor,
  Material.DryGrass,
  Material.TaigaFloor,
  Material.Tundra,
];

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const isName = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** A design's id made from its name: "Oak bench" → "oak-bench". */
export function designSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'design';
}

/**
 * A design from untrusted JSON (a request, a file), checked: or why it isn't one. Every voxel must
 * be a size a block grid can use, on its own grid (so it's inside one block), inside the box, of a
 * design material, and not overlap another; every state must have something in it.
 */
export function parseDesign(raw: unknown): ObjectDesign | string {
  if (typeof raw !== 'object' || raw === null) return 'not a design';
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== 'string' || !ID.test(d.id)) return 'its id must be lower case letters, digits and dashes (up to 40)';
  if (!isName(d.name, 40)) return 'it needs a name (up to 40 characters)';
  if (!Array.isArray(d.size) || d.size.length !== 3 || !d.size.every((n) => isInt(n, 1, DESIGN_MAX_BLOCKS))) return `its size must be 1 to ${DESIGN_MAX_BLOCKS} blocks each way`;
  if (!isInt(d.item, FIRST_DESIGN_ITEM, Number.MAX_SAFE_INTEGER)) return 'it has no item number';
  const size = d.size as [number, number, number];
  const [W, H, D] = size.map((n) => n * BLOCK_SIZE) as [number, number, number];
  if (!Array.isArray(d.states) || d.states.length < 1 || d.states.length > DESIGN_MAX_STATES) return `it needs 1 to ${DESIGN_MAX_STATES} states`;
  const states: DesignState[] = [];
  for (const [i, s] of (d.states as unknown[]).entries()) {
    const st = s as Record<string, unknown> | null;
    if (typeof st !== 'object' || st === null || !isName(st.name, 24)) return `state ${i + 1} needs a name (up to 24 characters)`;
    if (!Array.isArray(st.voxels) || st.voxels.length === 0) return `state "${st.name}" is empty`;
    if (st.voxels.length > DESIGN_MAX_VOXELS) return `state "${st.name}" has over ${DESIGN_MAX_VOXELS} voxels`;
    const taken = new Uint8Array(W * H * D);
    const voxels: BlockVoxel[] = [];
    for (const raw of st.voxels as unknown[]) {
      const v = raw as Record<string, unknown> | null;
      if (typeof v !== 'object' || v === null || !isGridSize(v.size as number)) return `state "${st.name}": a voxel of no size a block can hold`;
      const sz = v.size as number;
      if (!isInt(v.x, 0, W - sz) || !isInt(v.y, 0, H - sz) || !isInt(v.z, 0, D - sz)) return `state "${st.name}": a voxel outside the box`;
      const vx = v.x, vy = v.y, vz = v.z;
      if (vx % sz || vy % sz || vz % sz) return `state "${st.name}": a voxel off its grid`;
      if (!DESIGN_MATERIALS.includes(v.material as MaterialId)) return `state "${st.name}": a voxel of a material designs can't use`;
      for (let y = vy; y < vy + sz; y++)
        for (let z = vz; z < vz + sz; z++)
          for (let x = vx; x < vx + sz; x++) {
            const k = (y * D + z) * W + x;
            if (taken[k]) return `state "${st.name}": voxels overlap`;
            taken[k] = 1;
          }
      voxels.push({ x: vx, y: vy, z: vz, size: sz, material: v.material as MaterialId });
    }
    states.push({ name: st.name.trim(), voxels });
  }
  let recipe: DesignRecipe | null = null;
  if (d.recipe !== null && d.recipe !== undefined) {
    const r = d.recipe as Record<string, unknown>;
    if (typeof r !== 'object' || !Array.isArray(r.inputs) || r.inputs.length < 1 || r.inputs.length > DESIGN_MAX_INPUTS) return `its recipe needs 1 to ${DESIGN_MAX_INPUTS} ingredients`;
    const inputs: [ItemId, number][] = [];
    for (const e of r.inputs as unknown[]) {
      if (!Array.isArray(e) || e.length !== 2 || !isInt(e[1], 1, 64)) return 'each ingredient needs an amount (1 to 64)';
      const id = e[0] as ItemId;
      if (!ALL_ITEMS.includes(id) || (isBlock(id) && id === Material.Water)) return `its recipe takes something there isn't (${String(id)})`;
      if (inputs.some(([i]) => i === id)) return 'an ingredient is in its recipe twice';
      inputs.push([id, e[1]]);
    }
    if (!isInt(r.count, 1, 64)) return 'its recipe must make 1 to 64';
    recipe = { inputs, count: r.count, table: r.table === true };
  }
  if (d.role !== undefined && d.role !== null && !DESIGN_ROLES.includes(d.role as DesignRole)) return 'it stands in for something there isn\'t';
  return { id: d.id, name: d.name.trim(), size: [...size], states, item: d.item, recipe, ...(d.role ? { role: d.role as DesignRole } : {}) };
}

/** Quarter turns clockwise (seen from above) of each facing. */
const TURNS = { n: 0, e: 1, s: 2, w: 3 } as const;
type Facing = keyof typeof TURNS;

/** The box a design takes facing `facing`, in blocks along x, y and z (east and west: turned, x and z swap). */
export function designSpan(design: ObjectDesign, facing: Facing): [number, number, number] {
  const [w, h, d] = design.size;
  return TURNS[facing] % 2 ? [d, h, w] : [w, h, d];
}

/**
 * The voxels of state `state` of a design facing `facing`, in units from its least corner, turned
 * a quarter turn clockwise (seen from above) for each step from north: its front toward whoever
 * placed it (facing the way they looked).
 */
export function designVoxels(design: ObjectDesign, state: number, facing: Facing): BlockVoxel[] {
  let out = design.states[state]?.voxels ?? [];
  let depth = design.size[2] * BLOCK_SIZE, width = design.size[0] * BLOCK_SIZE;
  for (let t = 0; t < TURNS[facing]; t++) {
    const d = depth;
    out = out.map((v) => ({ ...v, x: d - v.z - v.size, z: v.x }));
    [width, depth] = [depth, width];
  }
  return out;
}

/**
 * Each block of a design placed facing `facing` (offsets from its least corner, every block of
 * its box, empty ones too) with its voxels (block-local).
 */
export function designBlocks(design: ObjectDesign, state: number, facing: Facing): { dx: number; dy: number; dz: number; voxels: BlockVoxel[] }[] {
  const [w, h, d] = designSpan(design, facing);
  const blocks = Array.from({ length: w * h * d }, (_, i) => ({ dx: i % w, dz: Math.floor(i / w) % d, dy: Math.floor(i / (w * d)), voxels: [] as BlockVoxel[] }));
  const B = BLOCK_SIZE;
  for (const v of designVoxels(design, state, facing)) {
    const dx = Math.floor(v.x / B), dy = Math.floor(v.y / B), dz = Math.floor(v.z / B);
    blocks[(dy * d + dz) * w + dx]!.voxels.push({ ...v, x: v.x - dx * B, y: v.y - dy * B, z: v.z - dz * B });
  }
  return blocks;
}

/**
 * The least corner (blocks) of a design placed at block (bx, by, bz), facing `facing`: that block
 * is the middle of its front row, at the bottom, so it stands there and runs back the way the
 * placer looked.
 */
export function designOrigin(design: ObjectDesign, facing: Facing, bx: number, by: number, bz: number): { x: number; y: number; z: number } {
  // Facing north: the front row is z = d - 1, its middle x = (w - 1) / 2 (the left of two).
  let [w, , d] = design.size;
  let ax = Math.floor((w - 1) / 2), az = d - 1;
  for (let t = 0; t < TURNS[facing]; t++) {
    [ax, az] = [d - 1 - az, ax];
    [w, d] = [d, w];
  }
  return { x: bx - ax, y: by, z: bz - az };
}

/** The material most of a design (its first state) is made of: its colour in inventories. */
export function designMaterial(design: ObjectDesign): MaterialId {
  const volume = new Map<MaterialId, number>();
  for (const v of design.states[0]?.voxels ?? []) volume.set(v.material, (volume.get(v.material) ?? 0) + v.size ** 3);
  let best: MaterialId = Material.Planks, most = -1;
  for (const [m, n] of volume) if (n > most) [best, most] = [m, n];
  return best;
}

/** The recipe id of a design's recipe. */
export const designRecipeId = (design: ObjectDesign) => `design:${design.id}`;

const designs = new Map<string, ObjectDesign>();
const byItem = new Map<ItemId, ObjectDesign>();

/**
 * Sets the designs in play (the library, as the server keeps it and clients are sent it),
 * replacing those before: their items and recipes become known (itemName, ALL_ITEMS, RECIPES).
 */
export function setDesigns(list: readonly ObjectDesign[]): void {
  designs.clear();
  byItem.clear();
  for (const d of list) {
    designs.set(d.id, d);
    byItem.set(designItem(d), d);
  }
  // (Those standing in for a station are its: no item or recipe of their own; the station's item
  // and recipe are in play, the crafting table's always.)
  const own = list.filter((d) => !d.role);
  const stations = STATIONS.filter((s) => s.role !== 'crafting-table' && list.some((d) => d.role === s.role));
  setExtraItems([...stations.map((s) => [s.item, s.name] as const), ...own.map((d) => [d.item, d.name] as const)]);
  const group: RecipeGroup = 'building';
  setExtraRecipes([
    ...stations.flatMap((s): Recipe[] => (s.recipe ? [{ id: s.role, group, inputs: s.recipe.inputs, output: [s.item, 1], table: s.recipe.table }] : [])),
    ...own.flatMap((d): Recipe[] => (d.recipe ? [{ id: designRecipeId(d), group: 'objects', inputs: d.recipe.inputs, output: [d.item, d.recipe.count], table: d.recipe.table }] : [])),
  ]);
}

export function designById(id: string): ObjectDesign | undefined {
  return designs.get(id);
}

/** The design an item places, if it's one (the crafting table item: the design that's the crafting table, if any). */
export function designOfItem(item: ItemId): ObjectDesign | undefined {
  return byItem.get(item);
}

/** The item a design is in inventories: its own, or (standing in for something) that thing's. */
export function designItem(design: ObjectDesign): ItemId {
  return design.role ? stationOf(design.role).item : design.item;
}

/** The designs in play, in the order they were set. */
export function allDesigns(): ObjectDesign[] {
  return [...designs.values()];
}
