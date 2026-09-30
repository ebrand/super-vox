import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultPlateTerrain } from '@super-vox/shared';
import { generatorFor, openWorld, type WorldSpec } from './worldFile.js';

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
    const r = openWorld(root, 'dev', plates({ waterPercent: 60 }));
    expect(r.created).toBe(true);
    const file = JSON.parse(readFileSync(join(root, 'dev', 'world.json'), 'utf8'));
    expect(file).toMatchObject({ version: 1, name: 'dev', spec: plates({ waterPercent: 60 }) });
  });

  it('reopens an existing world with its original spec, ignoring new settings', () => {
    const root = tmp();
    openWorld(root, 'w1', plates({ waterPercent: 60 }));
    const again = openWorld(root, 'w1', plates({ waterPercent: 20, majorPlates: 3 }));
    expect(again.created).toBe(false);
    expect(again.ignored).toBe(true);
    expect(again.file.spec).toEqual(plates({ waterPercent: 60 }));
    expect(openWorld(root, 'w1', plates({ waterPercent: 60 })).ignored).toBe(false);
  });

  it('rejects bad names and invalid specs without creating anything', () => {
    const root = tmp();
    expect(() => openWorld(root, '../escape', plates())).toThrow(/name/);
    expect(() => openWorld(root, 'Bad Name', plates())).toThrow(/name/);
    expect(() => openWorld(root, 'bad', plates({ waterPercent: 150 }))).toThrow(/waterPercent/);
    expect(() => readFileSync(join(root, 'bad', 'world.json'))).toThrow();
  });
});

describe('generatorFor', () => {
  it('builds plate, noise, and flat generators with the right sea level', () => {
    expect(generatorFor(plates()).generator.seaLevel).toBe(0);
    expect(generatorFor({ generator: 'noise', seed: 1, voxelize: { minVoxelSize: 1, tolerance: 4 } }).generator.seaLevel).toBeNull();
    expect(generatorFor({ generator: 'flat', resolution: 16 }).generator.seaLevel).toBeNull();
  });
});
