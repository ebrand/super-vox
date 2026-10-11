import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Boat, ChunkCoord, PlacedObject, StationState, Track } from '@super-vox/shared';

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
  /** The world's laid track (see Track). */
  loadTracks?(): Track[];
  saveTracks?(tracks: Track[]): void;
  /** The world's trains (see TrainYard), as they were left: as kept, unchecked (the yard checks). */
  loadTrains?(): unknown;
  saveTrains?(trains: unknown): void;
  /** Players' wheat (see World.crops): by farmland block ("bx,by,bz"), when it was sown. */
  loadCrops?(): Record<string, number>;
  saveCrops?(crops: Record<string, number>): void;
  /** Players' saplings (see World.saplings): by the block each is in ("bx,by,bz"), its item and when it was planted. */
  loadSaplings?(): Record<string, [number, number]>;
  saveSaplings?(saplings: Record<string, [number, number]>): void;
  /** The world's villages and villagers (see VillageSim), as kept: unchecked. */
  loadVillages?(): unknown;
  saveVillages?(villages: unknown): void;
  loadOutlaws?(): unknown;
  saveOutlaws?(outlaws: unknown): void;
}

const FILE = /^(-?\d+)_(-?\d+)_(-?\d+)\.chunk$/;
const OBJECTS = 'objects.json';
const STATIONS = 'stations.json';
const BOATS = 'boats.json';
const TRACKS = 'tracks.json';
const TRAINS = 'trains.json';
const VILLAGES = 'villages.json';
const OUTLAWS = 'outlaws.json';
const CROPS = 'crops.json';
const SAPLINGS = 'saplings.json';

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

  /** Laid track, in tracks.json beside the chunks (any that don't look like track: left out). */
  loadTracks(): Track[] {
    const path = join(this.dir, TRACKS);
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (t): t is Track =>
        typeof t === 'object' && t !== null && Number.isInteger(t.id) && Array.isArray(t.points) && Array.isArray(t.columns) &&
        t.points.every((p: Record<string, unknown>) => [p.x, p.y, p.z, p.heading, p.s].every((v) => typeof v === 'number' && Number.isFinite(v))),
    );
  }

  saveTracks(tracks: Track[]): void {
    this.write(TRACKS, JSON.stringify(tracks));
  }

  /** The trains, in trains.json beside the chunks. */
  loadTrains(): unknown {
    const path = join(this.dir, TRAINS);
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : null;
  }

  saveTrains(trains: unknown): void {
    this.write(TRAINS, JSON.stringify(trains));
  }

  /** Players' wheat, in crops.json beside the chunks (what doesn't look like it, left out). */
  loadCrops(): Record<string, number> {
    const path = join(this.dir, CROPS);
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown, out: Record<string, number> = {};
    if (typeof raw === 'object' && raw !== null) for (const [k, v] of Object.entries(raw)) if (/^-?\d+,-?\d+,-?\d+$/.test(k) && typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    return out;
  }

  saveCrops(crops: Record<string, number>): void {
    this.write(CROPS, JSON.stringify(crops));
  }

  /** Players' saplings, in saplings.json beside the chunks (what doesn't look like them, left out). */
  loadSaplings(): Record<string, [number, number]> {
    const path = join(this.dir, SAPLINGS);
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown, out: Record<string, [number, number]> = {};
    if (typeof raw === 'object' && raw !== null)
      for (const [k, v] of Object.entries(raw)) if (/^-?\d+,-?\d+,-?\d+$/.test(k) && Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n))) out[k] = [v[0], v[1]];
    return out;
  }

  saveSaplings(saplings: Record<string, [number, number]>): void {
    this.write(SAPLINGS, JSON.stringify(saplings));
  }

  /** The villages, in villages.json beside the chunks. */
  loadVillages(): unknown {
    const path = join(this.dir, VILLAGES);
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : null;
  }

  saveVillages(villages: unknown): void {
    this.write(VILLAGES, JSON.stringify(villages));
  }

  /** The outlaws and their camps, in outlaws.json beside the chunks. */
  loadOutlaws(): unknown {
    const path = join(this.dir, OUTLAWS);
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : null;
  }

  saveOutlaws(outlaws: unknown): void {
    this.write(OUTLAWS, JSON.stringify(outlaws));
  }

  private write(name: string, data: string | Uint8Array): void {
    // Write then rename so a crash never leaves a half-written file.
    const tmp = join(this.dir, `${name}.tmp`);
    writeFileSync(tmp, data);
    renameSync(tmp, join(this.dir, name));
  }
}
