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
 * The thatched cottage (role 'cottage') as a design, to change in the designer: the one villages
 * built before there were designs (see cottageStage), its door in the middle of its front (+z), its
 * floor at y 0, the thatch overhanging a block all round.
 */
export function cottageDesign(): ObjectDesign {
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
