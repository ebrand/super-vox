import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROUND_WORLD_16x8KM, defaultPlateTerrain, defaultVoxelize, encodeChunk, type TerrainStroke } from '@super-vox/shared';
import { createWorld, generatorFor, type WorldSpec } from './worldFile.js';
import { FileWorldCatalog } from './worlds.js';

const config = ROUND_WORLD_16x8KM;
const spec: WorldSpec = { generator: 'plates', plates: defaultPlateTerrain(9, config), voxelize: defaultVoxelize(), shape: 'round-16x8' };
const stroke: TerrainStroke = { kind: 'raise', x: 7000, z: 3000, radius: 30, amount: 10, softness: 0.5 };

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'builds-'));
  dirs.push(d);
  return d;
};
const builds = (root: string, name: string) => (existsSync(join(root, name, 'build')) ? readdirSync(join(root, name, 'build')).filter((f) => !f.endsWith('.tmp')) : []);
const until = async (f: () => boolean, ms = 20_000) => {
  for (let i = 0; i < ms / 20 && !f(); i++) await new Promise((r) => setTimeout(r, 20));
  if (!f()) throw new Error(`timed out: ${f.toString().slice(0, 100)}`);
};
/** Some chunks of world `name` as `catalog` makes them, and as a fresh build (with `strokes`) does. */
const same = async (catalog: FileWorldCatalog, name: string, strokes: TerrainStroke[] = []) => {
  const world = catalog.get(name)!, fresh = generatorFor(spec, config, strokes).generator;
  for (const c of [{ cx: 437, cy: 0, cz: 187 }, { cx: 436, cy: -1, cz: 188 }, { cx: 100, cy: 0, cz: 60 }]) {
    expect(await world.encodedChunk(c)).toEqual(encodeChunk(fresh.generateChunk(c)));
  }
};

describe('plate builds kept on disk', () => {
  it('are made when a world is made, loaded instead of built after a restart, and the same', async () => {
    const root = tmp();
    // Made through the catalog: built in the background, before anyone plays it.
    const first = new FileWorldCatalog(root, 'home', { dev: true, diskCache: true });
    first.create!('isle', spec.plates, 'round-16x8');
    await first.buildsDone();
    expect(builds(root, 'isle')).toHaveLength(1);
    expect(first.get('isle')).not.toBeNull();
    expect(first.builtFrom('isle')).toBe('disk');
    await same(first, 'isle');
    // A restart: loaded again.
    const again = new FileWorldCatalog(root, 'home', { dev: true, diskCache: true });
    await again.buildsDone();
    again.get('isle');
    expect(again.builtFrom('isle')).toBe('disk');
    await same(again, 'isle');
  }, 30_000);

  it('are made on first use when there is none, then saved; worlds made outside the catalog are built at start', async () => {
    const root = tmp();
    createWorld(root, 'isle', spec);
    // Opened at once (before the background build at start is done): made here, and saved.
    const catalog = new FileWorldCatalog(root, 'isle', { dev: true, diskCache: true });
    catalog.get('isle');
    expect(catalog.builtFrom('isle')).toBe('here');
    await catalog.buildsDone();
    await until(() => builds(root, 'isle').length === 1);
    await same(catalog, 'isle');
    const again = new FileWorldCatalog(root, 'isle', { dev: true, diskCache: true });
    again.get('isle');
    expect(again.builtFrom('isle')).toBe('disk');
  }, 30_000);

  it('follow terraforming: a new build (the old one goes), with the strokes', async () => {
    const root = tmp();
    createWorld(root, 'isle', spec);
    const catalog = new FileWorldCatalog(root, 'isle', { dev: true, diskCache: true });
    await catalog.buildsDone();
    const before = builds(root, 'isle');
    expect(before).toHaveLength(1);
    catalog.get('isle');
    catalog.terraform!('isle', 0, [stroke]);
    await catalog.buildsDone();
    const after = builds(root, 'isle');
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
    const again = new FileWorldCatalog(root, 'isle', { dev: true, diskCache: true });
    again.get('isle');
    expect(again.builtFrom('isle')).toBe('disk');
    await same(again, 'isle', [stroke]);
  }, 30_000);

  it("are made again if the file can't be read; not kept at all without the disk cache", async () => {
    const root = tmp();
    createWorld(root, 'isle', spec);
    const catalog = new FileWorldCatalog(root, 'isle', { dev: true, diskCache: true });
    await catalog.buildsDone();
    const [file] = builds(root, 'isle');
    writeFileSync(join(root, 'isle', 'build', file!), 'not a build');
    const again = new FileWorldCatalog(root, 'isle', { dev: true, diskCache: true });
    again.get('isle');
    expect(again.builtFrom('isle')).toBe('here');
    await same(again, 'isle');
    const off = tmp();
    createWorld(off, 'isle', spec);
    const plain = new FileWorldCatalog(off, 'isle', { dev: true });
    plain.get('isle');
    expect(plain.builtFrom('isle')).toBe('here');
    await new Promise((r) => setTimeout(r, 200));
    expect(builds(off, 'isle')).toHaveLength(0);
  }, 30_000);
});
