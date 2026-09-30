import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultPlateTerrain } from '@super-vox/shared';
import { WorldExistsError, createWorld, generatorFor, listWorlds, openWorld, readWorld, type WorldSpec } from './worldFile.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'super-vox-worlds-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const plates = (over = {}): WorldSpec => ({ generator: 'plates', plates: { ...defaultPlateTerrain(1), ...over }, voxelize: { minVoxelSize: 1, tolerance: 4 } });

describe('openWorld', () => {
  it('creates a world with the given spec and records it', () => {
    const root = tmp();
    const r = openWorld(root, 'dev', plates({ landPercent: 40 }));
    expect(r.created).toBe(true);
    const file = JSON.parse(readFileSync(join(root, 'dev', 'world.json'), 'utf8'));
    expect(file).toMatchObject({ version: 1, name: 'dev', spec: plates({ landPercent: 40 }) });
  });

  it('reopens an existing world with its original spec, ignoring new settings', () => {
    const root = tmp();
    openWorld(root, 'w1', plates({ landPercent: 40 }));
    const again = openWorld(root, 'w1', plates({ landPercent: 80, majorPlates: 3 }));
    expect(again.created).toBe(false);
    expect(again.ignored).toBe(true);
    expect(again.file.spec).toEqual(plates({ landPercent: 40 }));
    expect(openWorld(root, 'w1', plates({ landPercent: 40 })).ignored).toBe(false);
  });

  it('rejects bad names and invalid specs without creating anything', () => {
    const root = tmp();
    expect(() => openWorld(root, '../escape', plates())).toThrow(/name/);
    expect(() => openWorld(root, 'Bad Name', plates())).toThrow(/name/);
    expect(() => openWorld(root, 'bad', plates({ landPercent: 150 }))).toThrow(/landPercent/);
    expect(() => readFileSync(join(root, 'bad', 'world.json'))).toThrow();
  });
});

describe('readWorld / createWorld / listWorlds', () => {
  it('migrates worlds made before the current plate settings', () => {
    const root = tmp();
    mkdirSync(join(root, 'old'));
    const old = { seed: 4, majorPlates: 5, minorPlates: 12, waterPercent: 65, shoreFractal: 30, mountainHeight: 150 };
    writeFileSync(join(root, 'old', 'world.json'), JSON.stringify({ version: 1, name: 'old', createdAt: 'x', spec: { generator: 'plates', plates: old, voxelize: { minVoxelSize: 1, tolerance: 4 } } }));
    const spec = readWorld(root, 'old')!.spec;
    expect(spec).toMatchObject({ generator: 'plates' });
    if (spec.generator !== 'plates') throw new Error('unreachable');
    // Kept: its own settings. Water became land. Mountains are gone. New settings take defaults.
    expect(spec.plates).toEqual({ ...defaultPlateTerrain(4), majorPlates: 5, minorPlates: 12, landPercent: 35, shoreFractal: 30 });
  });

  it('refuses to create a world twice', () => {
    const root = tmp();
    createWorld(root, 'w', plates());
    expect(() => createWorld(root, 'w', plates({ majorPlates: 2 }))).toThrow(WorldExistsError);
    expect(readWorld(root, 'w')!.spec).toEqual(plates());
  });

  it('lists valid worlds by name and skips anything else', () => {
    const root = tmp();
    createWorld(root, 'zeta', plates());
    createWorld(root, 'alpha', plates({ seed: 2, terrainSeed: 2 }));
    mkdirSync(join(root, 'empty'));
    mkdirSync(join(root, 'broken'));
    writeFileSync(join(root, 'broken', 'world.json'), '{ not json');
    expect(listWorlds(root).map((w) => w.name)).toEqual(['alpha', 'zeta']);
    expect(listWorlds(join(root, 'missing'))).toEqual([]);
    expect(readWorld(root, 'nope')).toBeNull();
  });
});

describe('generatorFor', () => {
  it('builds plate, noise, and flat generators with the right sea level', () => {
    expect(generatorFor(plates()).generator.seaLevel).toBe(0);
    expect(generatorFor({ generator: 'noise', seed: 1, voxelize: { minVoxelSize: 1, tolerance: 4 } }).generator.seaLevel).toBeNull();
    expect(generatorFor({ generator: 'flat', resolution: 16 }).generator.seaLevel).toBeNull();
  });
});
