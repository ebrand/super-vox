import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChunkCoord } from '@super-vox/shared';

/** Persists edited chunks. */
export interface ChunkStore {
  loadAll(): { coord: ChunkCoord; bytes: Uint8Array }[];
  save(coord: ChunkCoord, bytes: Uint8Array): void;
}

const FILE = /^(-?\d+)_(-?\d+)_(-?\d+)\.chunk$/;

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
    const name = `${coord.cx}_${coord.cy}_${coord.cz}.chunk`;
    // Write then rename so a crash never leaves a half-written chunk.
    const tmp = join(this.dir, `${name}.tmp`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, join(this.dir, name));
  }
}
