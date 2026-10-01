import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChunkCoord, PlacedObject } from '@super-vox/shared';

/** Persists edited chunks, and the world's placed objects (fences, gates, doors). */
export interface ChunkStore {
  loadAll(): { coord: ChunkCoord; bytes: Uint8Array }[];
  save(coord: ChunkCoord, bytes: Uint8Array): void;
  loadObjects?(): PlacedObject[];
  saveObjects?(objects: PlacedObject[]): void;
}

const FILE = /^(-?\d+)_(-?\d+)_(-?\d+)\.chunk$/;
const OBJECTS = 'objects.json';

/** One file per edited chunk, `<cx>_<cy>_<cz>.chunk`, in a directory. */
export class FileChunkStore implements ChunkStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  loadAll(): { coord: ChunkCoord; bytes: Uint8Array }[] {
    const out: { coord: ChunkCoord; bytes: Uint8Array }[] = [];
    for (const name of readdirSync(this.dir)) {
      const m = FILE.exec(name);
      if (!m) continue;
      out.push({ coord: { cx: Number(m[1]), cy: Number(m[2]), cz: Number(m[3]) }, bytes: new Uint8Array(readFileSync(join(this.dir, name))) });
    }
    return out;
  }

  save(coord: ChunkCoord, bytes: Uint8Array): void {
    this.write(`${coord.cx}_${coord.cy}_${coord.cz}.chunk`, bytes);
  }

  /** Placed objects, in objects.json beside the chunks. */
  loadObjects(): PlacedObject[] {
    const path = join(this.dir, OBJECTS);
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as PlacedObject[]) : [];
  }

  saveObjects(objects: PlacedObject[]): void {
    this.write(OBJECTS, JSON.stringify(objects));
  }

  private write(name: string, data: string | Uint8Array): void {
    // Write then rename so a crash never leaves a half-written file.
    const tmp = join(this.dir, `${name}.tmp`);
    writeFileSync(tmp, data);
    renameSync(tmp, join(this.dir, name));
  }
}
