import { afterEach, describe, expect, it } from 'vitest';
import {
  ALL_ITEMS,
  FIRST_DESIGN_ITEM,
  Item,
  Material,
  RECIPES,
  designAnchor,
  designBlocks,
  designVoxelBox,
  designOfItem,
  designOrigin,
  designSpan,
  designVoxels,
  itemName,
  objectBlocks,
  objectCells,
  objectItem,
  parseDesign,
  recipeById,
  setDesigns,
  stationAmong,
  usable,
  type ObjectDesign,
  type PlacedObject,
} from './index.js';

const P = Material.Planks;

/** A bench 2 m wide (x), 1 m tall, 1 m deep: a seat across, a leg at each end, a 1/16 m mark at its back-left. */
function bench(): ObjectDesign {
  return {
    id: 'bench',
    name: 'Bench',
    size: [2, 1, 1],
    item: FIRST_DESIGN_ITEM,
    recipe: { inputs: [[P, 3]], count: 1, table: true },
    states: [
      {
        name: 'plain',
        voxels: [
          ...[0, 8, 16, 24].map((x) => ({ x, y: 8, z: 0, size: 8, material: P })),
          ...[0, 8, 16, 24].map((x) => ({ x, y: 8, z: 8, size: 8, material: P })),
          { x: 0, y: 0, z: 8, size: 8, material: Material.Stone },
          { x: 24, y: 0, z: 8, size: 8, material: Material.Stone },
        ],
      },
      { name: 'marked', voxels: [{ x: 0, y: 0, z: 0, size: 1, material: Material.DarkMetal }] },
    ],
  };
}

afterEach(() => setDesigns([]));

describe('parseDesign', () => {
  it('takes a good design as it is', () => {
    expect(parseDesign(JSON.parse(JSON.stringify(bench())))).toEqual(bench());
  });

  it('says what is wrong with a bad one', () => {
    const bad = (change: (d: Record<string, any>) => void) => {
      const d = JSON.parse(JSON.stringify(bench()));
      change(d);
      return parseDesign(d);
    };
    expect(bad((d) => (d.id = 'Bad Id'))).toMatch(/id/);
    expect(bad((d) => (d.name = ' '))).toMatch(/name/);
    expect(bad((d) => (d.size = [17, 1, 1]))).toMatch(/size/);
    expect(bad((d) => (d.size = [0, 1, 1]))).toMatch(/size/);
    expect(bad((d) => (d.states = []))).toMatch(/states/);
    expect(bad((d) => (d.states[1].voxels = []))).toMatch(/empty/);
    expect(bad((d) => (d.states[0].voxels[0].size = 3))).toMatch(/no size/);
    expect(bad((d) => (d.states[0].voxels[0].x = 4))).toMatch(/off its grid/);
    expect(bad((d) => (d.states[0].voxels[0].x = 32))).toMatch(/outside/); // 2 m wide: 32 is past it
    expect(bad((d) => (d.states[0].voxels[0].y = 16))).toMatch(/outside/); // 1 m tall
    expect(bad((d) => (d.states[0].voxels[0].x = 8))).toMatch(/overlap/);
    expect(bad((d) => d.states[0].voxels.push({ x: 4, y: 12, z: 4, size: 1, material: P }))).toMatch(/overlap/); // inside a 1/2 m one
    expect(bad((d) => (d.states[0].voxels[0].material = Material.TNT))).toMatch(/material/);
    expect(bad((d) => (d.states[0].voxels[0].material = Material.Water))).toMatch(/material/);
    expect(bad((d) => (d.states[0].voxels[0].material = Material.DoorWood))).toMatch(/material/);
    expect(bad((d) => (d.recipe.inputs = []))).toMatch(/ingredients/);
    expect(bad((d) => (d.recipe.inputs = [[P, 1], [P, 2]]))).toMatch(/twice/);
    expect(bad((d) => (d.recipe.inputs = [[999999, 1]]))).toMatch(/there isn't/);
    expect(bad((d) => (d.recipe.count = 0))).toMatch(/make/);
    expect(bad((d) => (d.item = 5))).toMatch(/item/);
    // No recipe: fine (creative only).
    expect(bad((d) => (d.recipe = null))).toMatchObject({ recipe: null });
  });
});

describe('placing designs', () => {
  it('turns with its facing: its box (x and z swap east and west) and its voxels', () => {
    const d = bench();
    expect(designSpan(d, 'n')).toEqual([2, 1, 1]);
    expect(designSpan(d, 'e')).toEqual([1, 1, 2]);
    expect(designSpan(d, 's')).toEqual([2, 1, 1]);
    // The 1/16 m mark at the back-left corner (x 0, z 0: facing north, the back is -z)...
    const mark = (f: 'n' | 'e' | 's' | 'w') => designVoxels(d, 1, f)[0];
    expect(mark('n')).toMatchObject({ x: 0, z: 0 });
    // ...turned clockwise (seen from above) once: back-left is now at the far +x, least z.
    expect(mark('e')).toMatchObject({ x: 15, z: 0 });
    expect(mark('s')).toMatchObject({ x: 31, z: 15 });
    expect(mark('w')).toMatchObject({ x: 0, z: 31 });
    // Every voxel stays inside the turned box, and none overlap (the volume is the same).
    for (const f of ['n', 'e', 's', 'w'] as const) {
      const [w, h, dd] = designSpan(d, f);
      const vs = designVoxels(d, 0, f);
      for (const v of vs) {
        expect(v.x).toBeGreaterThanOrEqual(0);
        expect(v.x + v.size).toBeLessThanOrEqual(w * 16);
        expect(v.y + v.size).toBeLessThanOrEqual(h * 16);
        expect(v.z + v.size).toBeLessThanOrEqual(dd * 16);
      }
      expect(parseDesign({ ...d, size: designSpan(d, f), states: [{ name: 'x', voxels: vs }] })).not.toBeTypeOf('string');
    }
  });

  it('splits into its blocks (every one, empty ones too), block-local', () => {
    const blocks = designBlocks(bench(), 0, 'e'); // 1 x 1 x 2
    expect(blocks.map((b) => [b.dx, b.dy, b.dz])).toEqual([
      [0, 0, 0],
      [0, 0, 1],
    ]);
    for (const b of blocks) {
      expect(b.voxels.length).toBe(5);
      for (const v of b.voxels) expect(v.x >= 0 && v.z >= 0 && v.x + v.size <= 16 && v.z + v.size <= 16).toBe(true);
    }
    const tall = { ...bench(), size: [1, 3, 1] as [number, number, number], states: [{ name: 'a', voxels: [{ x: 0, y: 40, z: 0, size: 8, material: P }] }] };
    const t = designBlocks(tall, 0, 'n');
    expect(t.map((b) => b.voxels.length)).toEqual([0, 0, 1]);
    expect(t[2]).toMatchObject({ dy: 2, voxels: [{ x: 0, y: 8, z: 0, size: 8 }] });
  });

  it('stands with the middle of its front row in the block placed at, running away from the placer', () => {
    const d = { ...bench(), size: [3, 1, 2] as [number, number, number] };
    // Facing north (looking -z): front row z = 1 (nearest the placer, at +z), middle x = 1.
    expect(designOrigin(d, 'n', 10, 5, 10)).toEqual({ x: 9, y: 5, z: 9 });
    // Facing south (looking +z): box 3 x 2 still, its front at its least z.
    expect(designOrigin(d, 's', 10, 5, 10)).toEqual({ x: 9, y: 5, z: 10 });
    // Facing east (looking +x): box 2 x 3, front at least x.
    expect(designOrigin(d, 'e', 10, 5, 10)).toEqual({ x: 10, y: 5, z: 9 });
    expect(designOrigin(d, 'w', 10, 5, 10)).toEqual({ x: 9, y: 5, z: 9 });
    // The front of the turned voxels is where the origin says: facing east, a voxel at the north
    // design's front (z = 31) lands in the least-x column.
    const front = { ...d, states: [{ name: 'a', voxels: [{ x: 0, y: 0, z: 31, size: 1, material: P }] }] };
    expect(designVoxels(front, 0, 'e')[0]!.x).toBe(0);
    expect(designVoxels(front, 0, 's')[0]!.z).toBe(0);
    expect(designVoxels(front, 0, 'w')[0]!.x).toBe(31);
  });

  it('is known by its item and recipe once set, and forgotten when not', () => {
    const d = bench();
    setDesigns([d]);
    expect(designOfItem(d.item)).toBe(d);
    expect(itemName(d.item)).toBe('Bench');
    expect(ALL_ITEMS).toContain(d.item);
    expect(recipeById('design:bench')).toEqual({ id: 'design:bench', group: 'objects', inputs: [[P, 3]], output: [d.item, 1], table: true });
    expect(RECIPES.at(-1)!.id).toBe('design:bench');
    setDesigns([]);
    expect(designOfItem(d.item)).toBeUndefined();
    expect(ALL_ITEMS).not.toContain(d.item);
    expect(recipeById('design:bench')).toBeUndefined();
    expect(recipeById('planks')).toBeDefined(); // the built-in ones stay
    expect(ALL_ITEMS).toContain(Item.Stick);
  });

  it('as a placed object: its cells, blocks, item and use', () => {
    const d = bench();
    setDesigns([d]);
    const o: PlacedObject = { kind: 'design', design: 'bench', state: 1, x: 0, y: 0, z: 0, facing: 'e', open: false, span: [1, 1, 2] };
    expect(objectCells(o)).toEqual([
      [0, 0, 0],
      [0, 0, 1],
    ]);
    expect(objectBlocks(o).flatMap((b) => b.voxels)).toEqual([{ x: 15, y: 0, z: 0, size: 1, material: Material.DarkMetal }]);
    expect(objectItem(o)).toBe(d.item);
    expect(usable(o)).toBe(true);
    // Changed in the library to another size: it can't be redrawn (but it still takes its cells).
    setDesigns([{ ...d, size: [3, 1, 1] }]);
    expect(objectBlocks(o)).toEqual([]);
    expect(objectCells(o).length).toBe(2);
    // Gone from the library: nothing to give back; one state: nothing to use.
    setDesigns([{ ...d, states: [d.states[0]!] }]);
    expect(usable(o)).toBe(false);
    setDesigns([]);
    expect(objectItem(o)).toBeNull();
    // Built-in objects as before.
    expect(objectCells({ kind: 'door', x: 0, y: 0, z: 0, facing: 'n', open: false })).toEqual([
      [0, 0, 0],
      [0, 1, 0],
    ]);
    expect(objectItem({ kind: 'gate', x: 0, y: 0, z: 0, facing: 'n', open: false })).toBe(Item.Gate);
  });

  it('one can be the crafting table: placed by its item, giving it back, and counting as a table', () => {
    const table = { ...bench(), id: 'my-table', name: 'My table', role: 'crafting-table' as const };
    expect(parseDesign(JSON.parse(JSON.stringify(table)))).toEqual(table);
    expect(parseDesign({ ...table, role: 'spaceship' })).toMatch(/stands in/);
    setDesigns([table]);
    // The crafting table item places it; it has no item or recipe of its own.
    expect(designOfItem(Item.CraftingTable)).toBe(table);
    expect(designOfItem(table.item)).toBeUndefined();
    expect(ALL_ITEMS).not.toContain(table.item);
    expect(recipeById('design:my-table')).toBeUndefined();
    expect(recipeById('crafting-table')!.output).toEqual([Item.CraftingTable, 1]);
    const o: PlacedObject = { kind: 'design', design: 'my-table', state: 0, x: 100, y: 0, z: 100, facing: 'n', open: false, span: [2, 1, 1] };
    expect(objectItem(o)).toBe(Item.CraftingTable);
    // Within 5 m (by block) of either of its blocks: near; further: not.
    const at = (bx: number) => [bx * 16 + 8, 8, 100 * 16 + 8] as const;
    expect(stationAmong([o], 'crafting-table', ...at(106), 80)).toBe(true); // 5 blocks past x 101
    expect(stationAmong([o], 'crafting-table', ...at(107), 80)).toBe(false);
    expect(stationAmong([o], 'crafting-table', ...at(95), 80)).toBe(true);
    expect(stationAmong([o], 'crafting-table', ...at(94), 80)).toBe(false);
    // Other designs aren't tables; the built-in table is.
    setDesigns([bench()]);
    expect(stationAmong([{ ...o, design: 'bench' }], 'crafting-table', ...at(101), 80)).toBe(false);
    expect(stationAmong([{ kind: 'table', x: 100, y: 0, z: 100, facing: 'n', open: false }], 'crafting-table', ...at(101), 80)).toBe(true);
    // Round worlds: across the seam (1000 blocks around: 999 is beside 0).
    setDesigns([table]);
    expect(stationAmong([{ ...o, x: 0 }], 'crafting-table', 999 * 16 + 8, 8, 100 * 16 + 8, 80, 1000)).toBe(true);
    expect(stationAmong([{ ...o, x: 0 }], 'crafting-table', 999 * 16 + 8, 8, 100 * 16 + 8, 80)).toBe(false);
  });

  it('stands in for the other stations too: their items and recipes in play only then, each near only itself', () => {
    const furnace = { ...bench(), id: 'my-furnace', role: 'furnace' as const };
    const anvil = { ...bench(), id: 'my-anvil', item: FIRST_DESIGN_ITEM + 1, role: 'anvil' as const };
    expect(ALL_ITEMS).not.toContain(Item.Furnace);
    expect(recipeById('furnace')).toBeUndefined();
    setDesigns([furnace, anvil]);
    expect(designOfItem(Item.Furnace)).toBe(furnace);
    expect(designOfItem(Item.Anvil)).toBe(anvil);
    expect(ALL_ITEMS).toEqual(expect.arrayContaining([Item.Furnace, Item.Anvil]));
    expect(ALL_ITEMS).not.toContain(Item.Stove);
    expect(itemName(Item.Furnace)).toBe('furnace');
    expect(recipeById('furnace')).toEqual({ id: 'furnace', group: 'building', inputs: [[Material.Cobblestone, 8]], output: [Item.Furnace, 1], table: true });
    expect(recipeById('anvil')).toBeUndefined(); // (no metal yet)
    const o: PlacedObject = { kind: 'design', design: 'my-furnace', state: 0, x: 100, y: 0, z: 100, facing: 'n', open: false, span: [2, 1, 1] };
    expect(objectItem(o)).toBe(Item.Furnace);
    expect(stationAmong([o], 'furnace', 100 * 16, 8, 100 * 16, 80)).toBe(true);
    expect(stationAmong([o], 'crafting-table', 100 * 16, 8, 100 * 16, 80)).toBe(false);
    expect(parseDesign({ ...furnace, role: 'smithing-table' })).toMatchObject({ role: 'smithing-table' });
    setDesigns([]);
    expect(ALL_ITEMS).not.toContain(Item.Furnace);
    expect(recipeById('furnace')).toBeUndefined();
  });
});

describe('VoxelOccupancy', () => {
  it('tells whether a voxel would overlap: the same cell, inside a bigger one, or holding smaller ones', async () => {
    const { VoxelOccupancy } = await import('./index.js');
    const occ = new VoxelOccupancy([{ x: 16, y: 0, z: 0, size: 16, material: P }, { x: 4, y: 4, z: 4, size: 2, material: P }]);
    expect(occ.overlaps({ x: 16, y: 0, z: 0, size: 16 })).toBe(true); // the same
    expect(occ.overlaps({ x: 24, y: 8, z: 8, size: 4 })).toBe(true); // inside the 1 m one
    expect(occ.overlaps({ x: 0, y: 0, z: 0, size: 8 })).toBe(true); // holds the small one
    expect(occ.overlaps({ x: 0, y: 0, z: 0, size: 16 })).toBe(true); // holds it too
    expect(occ.overlaps({ x: 6, y: 4, z: 4, size: 2 })).toBe(false); // beside it
    expect(occ.overlaps({ x: 0, y: 16, z: 0, size: 16 })).toBe(false); // above
    expect(occ.overlaps({ x: 32, y: 0, z: 0, size: 1 })).toBe(false);
  });
});

describe('big designs and pieces of a keep', () => {
  it('can be up to 16 m a side, checked quickly; and a piece of a keep, not also a station', async () => {
    const { DESIGN_MAX_BLOCKS } = await import('./index.js');
    expect(DESIGN_MAX_BLOCKS).toBe(16);
    // A wall section 16 m wide, 8 high, 2 deep, of 1/4 m stone blocks: 16384 voxels.
    const voxels = [];
    for (let y = 0; y < 128; y += 4) for (let z = 0; z < 32; z += 4) for (let x = 0; x < 256; x += 4) voxels.push({ x, y, z, size: 4, material: Material.Cobblestone });
    const wall = { id: 'wall-section', name: 'Wall section', size: [16, 8, 2], item: FIRST_DESIGN_ITEM, recipe: null, piece: 'wall', states: [{ name: 'built', voxels }] };
    const t0 = Date.now();
    const parsed = parseDesign(wall) as ObjectDesign;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(parsed.piece).toBe('wall');
    expect(parsed.states[0]!.voxels).toHaveLength(16384);
    // Overlapping ones are still caught.
    expect(parseDesign({ ...wall, states: [{ name: 'built', voxels: [...voxels, { x: 0, y: 0, z: 0, size: 8, material: Material.Cobblestone }] }] })).toMatch(/overlap/);
    expect(parseDesign({ ...wall, piece: 'moat' })).toMatch(/piece/);
    expect(parseDesign({ ...wall, role: 'furnace' })).toMatch(/not both/);
  });
});

describe('designs off the grid', () => {
  it('are aimed to the 1/4 m: against the face, standing on a floor, centred on the point across it', () => {
    // A floor's top at y = 8 (a 1/2 m slab), hit at (100.3, 8, 52.9): the 1 m around that point, on it.
    expect(designAnchor([100, 7, 52], [0, 1, 0], [100.3, 8, 52.9])).toEqual([92, 8, 44]);
    // A wall's east face at x = 24 (cell 23), hit at z = 69.2: off it, on its 1 m block's level.
    expect(designAnchor([23, 21, 69], [1, 0, 0], [24, 21.5, 69.2])).toEqual([24, 16, 60]);
    // Its west face (cell 16): the 1 m block ending at it.
    expect(designAnchor([16, 21, 69], [-1, 0, 0], [16, 21.5, 69.2])).toEqual([0, 16, 60]);
    // A ceiling: the 1 m under it.
    expect(designAnchor([40, 32, 40], [0, -1, 0], [40.5, 32, 40.5])).toEqual([32, 16, 32]);
    // On the 1 m grid, aimed at a block's middle: as ever.
    expect(designAnchor([24, 15, 24], [0, 1, 0], [24, 16, 24])).toEqual([16, 16, 16]);
  });

  it('keep every voxel inside a block, splitting those that would cross', () => {
    const d = { id: 'x', name: 'X', size: [1, 1, 1] as [number, number, number], item: 0, recipe: null, states: [{ name: 's', voxels: [{ x: 0, y: 0, z: 0, size: 8, material: 1 }, { x: 8, y: 8, z: 8, size: 8, material: 2 }, { x: 0, y: 8, z: 0, size: 2, material: 3 }] }] };
    for (const offset of [[0, 0, 0], [4, 0, 0], [8, 8, 8], [12, 4, 0]] as [number, number, number][]) {
      const blocks = designBlocks(d, 0, 'n', offset);
      expect(blocks.length).toBe([0, 1, 2].reduce((n, a) => n * (offset[a]! > 0 ? 2 : 1), 1));
      const vs = blocks.flatMap((b) => b.voxels);
      expect(vs.every((v) => v.x % v.size === 0 && v.y % v.size === 0 && v.z % v.size === 0 && v.x + v.size <= 16 && v.y + v.size <= 16 && v.z + v.size <= 16)).toBe(true);
      for (const m of [1, 2, 3]) expect(vs.filter((v) => v.material === m).reduce((n, v) => n + v.size ** 3, 0)).toBe([512, 512, 8][m - 1]);
    }
    // On the grid, as it was drawn.
    expect(designBlocks(d, 0, 'n', [0, 0, 0])[0]!.voxels.map((v) => v.size)).toEqual([8, 8, 2]);
    // 1/2 m off: 1/2 m voxels still whole.
    expect(designBlocks(d, 0, 'n', [8, 8, 8]).flatMap((b) => b.voxels).filter((v) => v.material !== 3).map((v) => v.size)).toEqual([8, 8]);
  });
});

describe('designVoxelBox', () => {
  it('is the box around its voxels, turned the way it faces', () => {
    // 2 x 1 x 1 m, drawn facing north: a 1/8 m slab across the back (z 0..2), the left 1 1/2 m of it.
    const d = { id: 'x', name: 'X', size: [2, 1, 1] as [number, number, number], item: 0, recipe: null, states: [{ name: 's', voxels: [0, 8, 16].map((x) => ({ x, y: 0, z: 0, size: 2, material: 1 })).concat([{ x: 16, y: 0, z: 0, size: 8, material: 1 }]) }] };
    expect(designVoxelBox(d, 'n')).toEqual({ x0: 0, y0: 0, z0: 0, x1: 24, y1: 8, z1: 8 });
    // A quarter turn: x and z swap (its back now to the east).
    expect(designVoxelBox(d, 'e')).toEqual({ x0: 8, y0: 0, z0: 0, x1: 16, y1: 8, z1: 24 });
    expect(designVoxelBox({ ...d, states: [{ name: 's', voxels: [] }] }, 'n')).toBeNull();
  });
});
