import { describe, expect, it } from 'vitest';
import { BLOCK_SIZE } from './chunk.js';
import { Material } from './materials.js';
import { oreAt } from './ores.js';

describe('ores', () => {
  it('lie in veins: coal from 4 m down, iron (rarer) from 12 m; none shallower; the same every time', () => {
    const count = (depth: number) => {
      const n = new Map<number, number>();
      for (let x = 0; x < 64; x++) for (let y = -40; y < 0; y++) for (let z = 0; z < 64; z++) {
        const m = oreAt(x, y, z, depth);
        n.set(m, (n.get(m) ?? 0) + 1);
      }
      return n;
    };
    const total = 64 * 40 * 64;
    const shallow = count(3 * BLOCK_SIZE);
    expect(shallow.get(Material.Stone)).toBe(total);
    const middle = count(8 * BLOCK_SIZE);
    expect(middle.get(Material.IronOre) ?? 0).toBe(0);
    const coal = (middle.get(Material.CoalOre) ?? 0) / total;
    expect(coal).toBeGreaterThan(0.01);
    expect(coal).toBeLessThan(0.025);
    const deep = count(20 * BLOCK_SIZE);
    const iron = (deep.get(Material.IronOre) ?? 0) / total;
    expect(iron).toBeGreaterThan(0.004);
    expect(iron).toBeLessThan(0.013);
    expect(iron).toBeLessThan((deep.get(Material.CoalOre) ?? 0) / total);
    expect(oreAt(17, -30, 9, 20 * BLOCK_SIZE)).toBe(oreAt(17, -30, 9, 20 * BLOCK_SIZE));
  });

  it('cluster: an ore block usually has another of its kind beside it', () => {
    let ore = 0, withNeighbour = 0;
    for (let x = 0; x < 64; x++) for (let y = -40; y < 0; y++) for (let z = 0; z < 64; z++) {
      const m = oreAt(x, y, z, 8 * BLOCK_SIZE);
      if (m !== Material.CoalOre) continue;
      ore++;
      const n = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => oreAt(x + dx!, y + dy!, z + dz!, 8 * BLOCK_SIZE) === m);
      if (n) withNeighbour++;
    }
    expect(withNeighbour / ore).toBeGreaterThan(0.7);
  });
});
