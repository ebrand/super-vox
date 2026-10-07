import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Boat, ChunkCoord, PlacedObject, StationState } from '@super-vox/shared';

/** Persists edited chunks, and the world's placed objects (fences, gates, doors). */
export interface ChunkStore {
  loadAll(): { coord: ChunkCoord; bytes: Uint8Array }[];
  save(coord: ChunkCoord, bytes: Uint8Array): void;
  loadObjects?(): PlacedObject[];
  saveObjects?(objects: PlacedObject[]): void;
  /** What's in the world's furnaces and stoves, by their origin block ("x,y,z"). */
  loadStations?(): Record<string, unknown>;
  saveStations?(stations: Record<string, StationState>): void;
  /** The world's boats (see Boat), as they were left. */
  loadBoats?(): Boat[];
  saveBoats?(boats: Boat[]): void;
}

const FILE = /^(-?\d+)_(-?\d+)_(-?\d+)\.chunk$/;
const OBJECTS = 'objects.json';
const STATIONS = 'stations.json';
const BOATS = 'boats.json';

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

  /** Furnaces' and stoves' contents, in stations.json beside the chunks. */
  loadStations(): Record<string, unknown> {
    const path = join(this.dir, STATIONS);
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
  }

  saveStations(stations: Record<string, StationState>): void {
    this.write(STATIONS, JSON.stringify(stations));
  }

  /** Boats, in boats.json beside the chunks (those that don't look like boats: left out). */
  loadBoats(): Boat[] {
    const path = join(this.dir, BOATS);
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (b): b is Boat =>
        typeof b === 'object' && b !== null && Number.isInteger(b.id) && typeof b.design === 'string' && [b.x, b.y, b.z, b.yaw].every((v) => typeof v === 'number' && Number.isFinite(v)),
    );
  }

  saveBoats(boats: Boat[]): void {
    this.write(BOATS, JSON.stringify(boats));
  }

  private write(name: string, data: string | Uint8Array): void {
    // Write then rename so a crash never leaves a half-written file.
    const tmp = join(this.dir, `${name}.tmp`);
    writeFileSync(tmp, data);
    renameSync(tmp, join(this.dir, name));
  }
}
