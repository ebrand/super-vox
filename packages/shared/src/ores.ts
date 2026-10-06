import { BLOCK_SIZE } from './chunk.js';
import { Material, type MaterialId } from './materials.js';
import { hash2 } from './noise.js';

/**
 * Ore in the rock: small veins of coal from 4 m down, and of iron (rarer) from 12 m down, in 1 m
 * blocks of deep stone. A vein is a 2 m cell picked at random (by depth), about half of its eight
 * blocks ore. The same everywhere for a given block (pure hashing: no state, cheap to generate).
 */
export const ORES: readonly { material: MaterialId; minDepth: number; chance: number; salt: number }[] = [
  // (Iron first: where both pick a cell, iron wins, being rarer.)
  { material: Material.IronOre, minDepth: 12 * BLOCK_SIZE, chance: 0.015, salt: 0x1f0e },
  { material: Material.CoalOre, minDepth: 4 * BLOCK_SIZE, chance: 0.03, salt: 0xc0a1 },
];
/** Of a vein's cell, the share of its blocks that are ore. */
export const VEIN_FILL = 0.55;

const hash3 = (x: number, y: number, z: number, salt: number) => hash2(x, z, Math.imul(y | 0, 0x2c1b3c6d) ^ salt);

/** Iron alone (worlds with geology, where coal is in seams: see geology.ts). */
export const IRON_ONLY = ORES.filter((o) => o.material === Material.IronOre);

/**
 * What the 1 m block at (bx, by, bz) (block coordinates) is, if it's `rock` (stone, unless said)
 * `depth` units below the ground's surface: an ore (of `ores`), or the rock.
 */
export function oreAt(bx: number, by: number, bz: number, depth: number, rock: MaterialId = Material.Stone, ores = ORES): MaterialId {
  const cx = bx >> 1, cy = by >> 1, cz = bz >> 1;
  for (const o of ores) {
    if (depth < o.minDepth) continue;
    if (hash3(cx, cy, cz, o.salt) < o.chance && hash3(bx, by, bz, o.salt + 1) < VEIN_FILL) return o.material;
  }
  return rock;
}
