import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import { gunzipSync, gzip } from 'node:zlib';
import type { PlateStages, TerrainStroke, WorldConfig } from '@super-vox/shared';
import type { WorldSpec } from './worldFile.js';

/**
 * Plate worlds' builds kept on disk (each world's build/ folder: one file, the stages a build
 * made; see PlateStageCache), so a world opened again after the server restarts (a deploy, say)
 * loads its build in a moment instead of making it again. A file is named for everything that
 * decides what the build holds: the world's settings and shape, its terraforming, and the code
 * that builds worlds (the shared package's files). Change any of them and it's another file;
 * the old ones go when a new one is saved.
 */

/** Bumped if what's in a build file changes form. */
const FORMAT = 1;

let code: string | null = null;
/** A hash of the code that builds worlds: every file of the shared package, as this server runs it (its build, or in development its sources). */
export function codeVersion(): string {
  if (code) return code;
  const h = createHash('sha256');
  const root = dirname(createRequire(import.meta.url).resolve('@super-vox/shared'));
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|ts)$/.test(f) && !/\.test\.ts$/.test(f) && !f.endsWith('.d.ts')) h.update(f).update(readFileSync(p));
    }
  };
  walk(root);
  return (code = h.digest('hex').slice(0, 16));
}

/** The build file of world `name` made from `spec` (on `config`) with `strokes`. */
export function buildFile(dataRoot: string, name: string, spec: WorldSpec, config: WorldConfig, strokes: readonly TerrainStroke[]): string {
  const key = createHash('sha256').update(JSON.stringify({ FORMAT, code: codeVersion(), spec, config, strokes })).digest('hex').slice(0, 20);
  return join(dataRoot, name, 'build', `${key}.v8.gz`);
}

/** A build's stages from `file`, or null if there's none (or it can't be read: it's made again). */
export function loadBuild(file: string): PlateStages | null {
  if (!existsSync(file)) return null;
  try {
    const stages = deserialize(gunzipSync(readFileSync(file))) as PlateStages;
    return Array.isArray(stages) ? stages : null;
  } catch {
    return null;
  }
}

const gzipAsync = promisify(gzip);

/**
 * Saves a build's stages as `file` (compressed off the main thread; written whole, then renamed
 * into place, so a reader never sees half of one), and deletes the world's other build files.
 */
export async function saveBuild(file: string, stages: PlateStages): Promise<void> {
  const bytes = await gzipAsync(serialize(stages), { level: 1 });
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
  // (Another save's file in the writing, from the last minute, is left be.)
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (p !== file && !(f.endsWith('.tmp') && Date.now() - statSync(p).mtimeMs < 60_000)) rmSync(p, { force: true });
  }
}
