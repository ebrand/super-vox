import { describe, expect, it } from 'vitest';
import { emptyChunk, packVoxel, type Chunk } from './chunk.js';
import { BLOCK_VOLUME, HOTBAR_SLOTS, STARTER_KIT, canPlace, chunkVolumes, dropOf, formatBlocks, isGameMode, starterHotbar, volumeChange } from './items.js';
import { Material, waterMaterial } from './materials.js';

function chunkWith(...blocks: Chunk['blocks']): Chunk {
  const c = emptyChunk({ cx: 0, cy: 0, cz: 0 });
  blocks.forEach((b, i) => (c.blocks[i] = b));
  return c;
}

describe('items', () => {
  it('measure material by volume, whatever the voxel size', () => {
    expect(BLOCK_VOLUME).toBe(4096);
    const grid = new Uint16Array(8).fill(Material.Dirt);
    grid[0] = Material.Stone;
    grid[1] = 0;
    const c = chunkWith(
      { kind: 'uniform', size: 16, material: Material.Stone },
      { kind: 'grid', size: 8, materials: grid },
      { kind: 'voxels', packed: new Uint16Array([packVoxel(0, 0, 0, 4), packVoxel(4, 0, 0, 1)]), materials: new Uint16Array([Material.Wood, Material.Wood]) },
      null,
    );
    expect(chunkVolumes(c)).toEqual(new Map([[Material.Stone, 4096 + 512], [Material.Dirt, 6 * 512], [Material.Wood, 64 + 1]]));
  });

  it('report what an edit changed, both ways', () => {
    const before = chunkWith({ kind: 'uniform', size: 16, material: Material.Stone });
    const grid = new Uint16Array(8).fill(Material.Stone);
    grid[3] = 0;
    grid[4] = Material.Wood;
    const after = chunkWith({ kind: 'grid', size: 8, materials: grid });
    expect(volumeChange([before], [after])).toEqual(new Map([[Material.Stone, -1024], [Material.Wood, 512]]));
    expect(volumeChange([before], [before])).toEqual(new Map());
  });

  it('drop Minecraft-like: stone gives cobblestone, grassy grounds dirt, leaves and water nothing', () => {
    expect(dropOf(Material.Stone)).toBe(Material.Cobblestone);
    expect(dropOf(Material.Grass)).toBe(Material.Dirt);
    expect(dropOf(Material.Tundra)).toBe(Material.Dirt);
    expect(dropOf(Material.Wood)).toBe(Material.Wood);
    expect(dropOf(Material.Leaves)).toBeNull();
    expect(dropOf(Material.Water)).toBeNull();
    expect(dropOf(waterMaterial(3))).toBeNull();
  });

  it('let survival place only solid materials', () => {
    expect(canPlace(Material.Stone, 'survival')).toBe(true);
    expect(canPlace(Material.Water, 'survival')).toBe(false);
    expect(canPlace(Material.Water, 'creative')).toBe(true);
    expect(canPlace(waterMaterial(2), 'creative')).toBe(false); // flowing water isn't an item
    expect(canPlace(999, 'creative')).toBe(false);
  });

  it('start survival players with a few basic blocks on the hotbar', () => {
    expect(STARTER_KIT.map(([m, v]) => [m, v / BLOCK_VOLUME])).toEqual([[Material.Dirt, 16], [Material.Stone, 16], [Material.Wood, 16]]);
    expect(starterHotbar()).toEqual([Material.Dirt, Material.Stone, Material.Wood, ...Array(HOTBAR_SLOTS - 3).fill(null)]);
    expect(isGameMode('survival')).toBe(true);
    expect(isGameMode('hardcore')).toBe(false);
  });

  it('format amounts in blocks', () => {
    expect(formatBlocks(16 * 4096)).toBe('16');
    expect(formatBlocks(4096 * 2.5)).toBe('2.5');
    expect(formatBlocks(4096 * 12.25)).toBe('12.3');
    expect(formatBlocks(64)).toBe('0.016');
    expect(formatBlocks(512)).toBe('0.13');
  });
});
