import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROUND_WORLD_16x8KM, defaultPlateTerrain, defaultVoxelize } from '@super-vox/shared';
import { createWorld, generatorFor, type WorldSpec } from './worldFile.js';
import { FileWorldCatalog } from './worlds.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const config = ROUND_WORLD_16x8KM;
const spec: WorldSpec = { generator: 'plates', plates: defaultPlateTerrain(9, config), voxelize: defaultVoxelize(), shape: 'round-16x8' };

describe('closing idle worlds', () => {
  it("closes worlds nobody's asked for in a while and that aren't busy; they open again as they were", () => {
    const root = mkdtempSync(join(tmpdir(), 'super-vox-idle-'));
    dirs.push(root);
    createWorld(root, 'a', spec);
    createWorld(root, 'b', spec);
    const catalog = new FileWorldCatalog(root, 'a', { dev: true });
    const a = catalog.get('a')!, b = catalog.get('b')!;
    // An edit in b, saved as it's made: a dent in its ground.
    const x = 7000 * 16, z = 3000 * 16, y = generatorFor(spec, config).generator.surfaceHeightAt(x, z) - 8;
    expect(b.materialAtUnit(x, y, z)).toBeGreaterThan(0);
    b.applyEdit({ op: 'remove', x, y, z });
    expect(b.materialAtUnit(x, y, z)).toBe(0);
    const now = Date.now();
    // Just used: nothing closes.
    expect(catalog.closeIdle((w) => false, 10 * 60_000, now)).toEqual([]);
    // A while later: a's busy (someone's in it), b isn't.
    const later = now + 11 * 60_000;
    const closed = catalog.closeIdle((w) => w === a, 10 * 60_000, later);
    expect(closed).toEqual([b]);
    expect(catalog.openWorlds().map((o) => o.name)).toEqual(['a']);
    // b opens again when asked for: a new World, its edit still there.
    const again = catalog.get('b')!;
    expect(again).not.toBe(b);
    expect(again.materialAtUnit(x, y, z)).toBe(0);
    // Asked for just now: open, however long before it was idle.
    expect(catalog.closeIdle(() => false, 10 * 60_000, Date.now() + 60_000)).toEqual([]);
    expect(catalog.closeIdle(() => false, 10 * 60_000, Date.now() + 11 * 60_000).length).toBe(2);
    expect(catalog.openWorlds()).toEqual([]);
  });
});
