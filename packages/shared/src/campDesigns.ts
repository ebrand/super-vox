import { Material, type MaterialId } from './materials.js';
import type { ObjectDesign } from './designs.js';
import { voxelsOfBoxes } from './stationDesign.js';
import { BLOCK_SIZE } from './chunk.js';
import { cottageStage, type Cottage } from './villages.js';

type Box = [number, number, number, number, number, number, MaterialId];

/**
 * An outlaw camp's pieces as designs (roles 'campfire' and 'lean-to': see STATIONS), to change in the
 * designer. Their frames (m): the campfire's middle is the fire's, x and z 0..3; the lean-to's x 0
 * is two metres east of the fire's middle (facing it), z 0..3 centred on it. y 0 is the ground's top
 * block for both (a metre under where you'd stand): a camp's built with its pieces' voxels.
 */
export function campfireDesign(): ObjectDesign {
  const boxes: Box[] = [
    // A ring of cobblestone round coal sunk into the ground, flames on it.
    [0, 3, 1, 2, 0, 1, Material.Cobblestone],
    [0, 3, 1, 2, 2, 3, Material.Cobblestone],
    [0, 1, 1, 2, 1, 2, Material.Cobblestone],
    [2, 3, 1, 2, 1, 2, Material.Cobblestone],
    [1, 2, 0, 1, 1, 2, Material.Coal],
    [1.25, 1.75, 1, 1.25, 1.25, 1.75, Material.TorchFlame],
    [1.375, 1.625, 1.25, 1.5, 1.375, 1.625, Material.TorchFlame],
  ];
  return { id: 'outlaw-campfire', name: 'Outlaw campfire', size: [3, 2, 3], states: [{ name: 'alight', voxels: voxelsOfBoxes(boxes) }], item: 0, recipe: null, role: 'campfire' };
}

export function leanToDesign(): ObjectDesign {
  const boxes: Box[] = [
    // Posts: the front (by the fire) three metres up, the back two; a roof of planks sloping back.
    [0, 1, 1, 4, 0, 1, Material.Wood],
    [0, 1, 1, 4, 2, 3, Material.Wood],
    [1, 2, 1, 3, 0, 1, Material.Wood],
    [1, 2, 1, 3, 2, 3, Material.Wood],
    [0, 1, 4, 5, 0, 3, Material.Planks],
    [1, 2, 3, 4, 0, 3, Material.Planks],
    [2, 3, 2, 3, 0, 3, Material.Planks],
  ];
  return { id: 'outlaw-lean-to', name: 'Outlaw lean-to', size: [3, 5, 3], states: [{ name: 'standing', voxels: voxelsOfBoxes(boxes) }], item: 0, recipe: null, role: 'lean-to' };
}

/**
 * The thatched cottage (role 'cottage') as a design, to change in the designer: timber-framed (oak
 * posts, sill, rails and top plate round plank walls), glazed windows in frames, an open doorway in
 * the middle of its front (+z), a plank floor, a thatched roof (its ridge along x) overhanging half a
 * metre all round, plank gables and a stone chimney. In quarter metres; its bottom at y 0, on the
 * ground (villages sit it on the ground's lowest point under it: see designedCottage).
 */
export function cottageDesign(): ObjectDesign {
  // (The house 6 m by 5 m, at 0.5 m in: its roof overhangs it to the design's edges, 7 by 6.)
  const W = 6, D = 5, o = 0.5, eave = 2.75, run = D / 2 + o, boxes: Box[] = [];
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, m: MaterialId) => boxes.push([x0 + o, x1 + o, y0, y1, z0 + o, z1 + o, m]);
  // Floor; walls (planks, a quarter metre thick) to the eaves.
  box(0, W, 0, 0.25, 0, D, Material.Planks);
  box(0, W, 0.25, eave, 0, 0.25, Material.Planks);
  box(0, W, 0.25, eave, D - 0.25, D, Material.Planks);
  box(0, 0.25, 0.25, eave, 0, D, Material.Planks);
  box(W - 0.25, W, 0.25, eave, 0, D, Material.Planks);
  // The frame: sill, rail at 1 m, top plate; corner posts half a metre square, and posts between.
  for (const [y0, y1] of [[0, 0.25], [1, 1.25], [eave - 0.25, eave]] as const) {
    box(0, W, y0, y1, 0, 0.25, Material.Wood);
    box(0, W, y0, y1, D - 0.25, D, Material.Wood);
    box(0, 0.25, y0, y1, 0, D, Material.Wood);
    box(W - 0.25, W, y0, y1, 0, D, Material.Wood);
  }
  for (const x of [0, W - 0.5]) for (const z of [0, D - 0.5]) box(x, x + 0.5, 0, eave, z, z + 0.5, Material.Wood);
  for (const x of [2, 3.75]) for (const z of [0, D - 0.25]) box(x, x + 0.25, 0, eave, z, z + 0.25, Material.Wood);
  for (const z of [2.375]) for (const x of [0, W - 0.25]) box(x, x + 0.25, 0, eave, z, z + 0.25, Material.Wood);
  // Windows: framed glass, front and back either side of the middle, two in the west end, one in the east (the chimney's); a sill out front.
  const window = (x0: number, x1: number, z0: number, z1: number) => {
    // (Its frame round it along the wall it's in: across x in the front and back, z in the ends.)
    const ex = x1 - x0 > z1 - z0 ? 0.25 : 0, ez = 0.25 - ex;
    box(x0 - ex, x1 + ex, 1, 2.25, z0 - ez, z1 + ez, Material.Wood);
    box(x0, x1, 1.25, 2, z0, z1, Material.Glass);
  };
  for (const z of [0, D - 0.25]) for (const x0 of [0.75, 4.5]) window(x0, x0 + 0.75, z, z + 0.25);
  window(0, 0.25, 1, 1.75);
  window(0, 0.25, 3.25, 4);
  window(W - 0.25, W, 1, 1.75);
  for (const x0 of [0.5, 4.25]) box(x0, x0 + 1.25, 1, 1.25, D, D + 0.25, Material.Wood);
  // The doorway: open, a metre wide and two high, framed, a step of planks before it.
  box(2.25, 3.75, 0.25, 2.5, D - 0.25, D, Material.Wood);
  box(2.5, 3.5, 0.25, 2.25, D - 0.25, D, Material.Air);
  box(2.5, 3.5, 0, 0.25, D, D + 0.25, Material.Planks);
  // Gables: planks up under the roof, each end.
  for (let y = eave; y < eave + run; y += 0.25) {
    const inset = y - eave + 0.25 - o;
    if (inset >= D / 2) break;
    for (const x of [0, W - 0.25]) box(x, x + 0.25, y, y + 0.25, Math.max(0, inset), Math.min(D, D - inset), Material.Planks);
  }
  // The roof: thatch half a metre thick, stepped a quarter metre up each quarter in, to the ridge; a ridge cap.
  for (let i = 0; i < run * 4; i++) {
    const y = eave + i * 0.25;
    box(-o, W + o, y, y + 0.5, -o + i * 0.25, -o + (i + 1) * 0.25, Material.Thatch);
    box(-o, W + o, y, y + 0.5, D + o - (i + 1) * 0.25, D + o - i * 0.25, Material.Thatch);
  }
  const ridge = eave + run;
  box(-o, W + o, ridge + 0.25, ridge + 0.5, D / 2 - 0.25, D / 2 + 0.25, Material.Thatch);
  // The chimney: stone, inside the east end, up through the thatch; a hearth at its foot.
  box(W - 1.25, W - 0.25, 0.25, ridge + 1, 3, 3.75, Material.StoneBricks);
  box(W - 1, W - 0.5, 0.25, 0.75, 3, 3.5, Material.Air);
  box(W - 1, W - 0.5, 0.25, 0.5, 3.25, 3.5, Material.Coal);
  const voxels = voxelsOfBoxes(boxes).filter((v) => v.material !== Material.Air);
  return { id: 'thatched-cottage', name: 'Thatched cottage', size: [W + 1, Math.ceil(ridge + 1), D + 1], states: [{ name: 'built', voxels }], item: 0, recipe: null, role: 'cottage' };
}

/** The thatched cottage as it first came (1 m blocks, see cottageStage): a library still holding it as it came has it replaced with cottageDesign. */
export function oldCottageDesign(): ObjectDesign {
  const B = BLOCK_SIZE, c: Cottage = { bx: 1, bz: 1, w: 5, d: 4, floor: 1, door: 2, stage: 0, work: 0 };
  const voxels = [1, 2, 3].flatMap((stage) => cottageStage(c, stage, () => 0).place).map((p) => ({ x: p.x, y: p.y, z: p.z, size: B, material: p.material }));
  return { id: 'thatched-cottage', name: 'Thatched cottage', size: [7, 7, 6], states: [{ name: 'built', voxels }], item: 0, recipe: null, role: 'cottage' };
}

/**
 * The furnace and the stove (roles 'furnace' and 'stove') as they come, to change in the designer: so
 * a world has them (and their recipes) before anyone's designed one. Each is a metre across, its
 * front (+z) toward whoever places it, open there on its fire.
 */
export function furnaceDesign(): ObjectDesign {
  const boxes: Box[] = [
    // A cobblestone box, its fire-hole in the front (coal in it); a chimney at the back.
    [0, 1, 0, 0.25, 0, 1, Material.Cobblestone],
    [0, 1, 0.75, 1, 0, 1, Material.Cobblestone],
    [0, 0.25, 0.25, 0.75, 0, 1, Material.Cobblestone],
    [0.75, 1, 0.25, 0.75, 0, 1, Material.Cobblestone],
    [0.25, 0.75, 0.25, 0.75, 0, 0.5, Material.Cobblestone],
    [0.25, 0.75, 0.25, 0.5, 0.5, 0.75, Material.Coal],
    [0.25, 0.5, 1, 1.75, 0.25, 0.5, Material.Cobblestone],
  ];
  return { id: 'furnace', name: 'Furnace', size: [1, 2, 1], states: [{ name: 'standing', voxels: voxelsOfBoxes(boxes) }], item: 0, recipe: null, role: 'furnace' };
}

export function stoveDesign(): ObjectDesign {
  const boxes: Box[] = [
    // A cobblestone oven (coal in its front), under a plank top with an iron plate in it.
    [0, 1, 0, 0.25, 0, 1, Material.Cobblestone],
    [0, 0.25, 0.25, 0.75, 0, 1, Material.Cobblestone],
    [0.75, 1, 0.25, 0.75, 0, 1, Material.Cobblestone],
    [0.25, 0.75, 0.25, 0.75, 0, 0.5, Material.Cobblestone],
    [0.25, 0.75, 0.25, 0.5, 0.5, 0.75, Material.Coal],
    [0, 1, 0.75, 1, 0, 1, Material.Planks],
    [0.25, 0.75, 0.75, 1, 0.25, 0.75, Material.DarkMetal],
  ];
  return { id: 'stove', name: 'Stove', size: [1, 1, 1], states: [{ name: 'standing', voxels: voxelsOfBoxes(boxes) }], item: 0, recipe: null, role: 'stove' };
}

/** The anvil (role 'anvil') as it comes: dark iron, a foot, a waist, and a face with a horn out front (+z). */
export function anvilDesign(): ObjectDesign {
  const boxes: Box[] = [
    [0.25, 0.75, 0, 0.25, 0, 1, Material.DarkMetal],
    [0.25, 0.75, 0.25, 0.5, 0.25, 0.75, Material.DarkMetal],
    [0, 1, 0.5, 0.75, 0, 1, Material.DarkMetal],
    [0.25, 0.75, 0.75, 1, 0, 0.75, Material.DarkMetal],
    [0.25, 0.75, 0.75, 1, 0.75, 1, Material.LightMetal],
  ];
  return { id: 'anvil', name: 'Anvil', size: [1, 1, 1], states: [{ name: 'standing', voxels: voxelsOfBoxes(boxes) }], item: 0, recipe: null, role: 'anvil' };
}

/** The smithing table (role 'smithing-table') as it comes: a plank bench on legs, an iron plate and tongs on its top. */
export function smithingTableDesign(): ObjectDesign {
  const boxes: Box[] = [
    [0, 0.25, 0, 0.75, 0, 0.25, Material.Wood],
    [0.75, 1, 0, 0.75, 0, 0.25, Material.Wood],
    [0, 0.25, 0, 0.75, 0.75, 1, Material.Wood],
    [0.75, 1, 0, 0.75, 0.75, 1, Material.Wood],
    [0, 1, 0.5, 0.75, 0, 1, Material.Planks],
    [0, 1, 0.75, 1, 0, 1, Material.Planks],
    [0.25, 0.75, 0.75, 1, 0.25, 0.75, Material.DarkMetal],
  ];
  return { id: 'smithing-table', name: 'Smithing table', size: [1, 1, 1], states: [{ name: 'standing', voxels: voxelsOfBoxes(boxes) }], item: 0, recipe: null, role: 'smithing-table' };
}
