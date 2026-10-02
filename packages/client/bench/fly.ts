/**
 * Flight benchmark: a headless client (the real ChunkManager and TileManager) flying east across
 * the seam of a running server. Meshing runs for real on 4 node worker threads.
 * Usage: npx tsx bench/fly.ts port|wss://host/ws speed@row ... (m/s, and the row to fly along: km from the equator, + is south)
 */
import * as THREE from 'three';
import { Worker } from 'node:worker_threads';
import { BinaryTag, CHUNK_SIZE, tileKey, tileSizeUnits, PROTOCOL_VERSION, UNITS_PER_METER, decodeServerMessage, encodeMessage, type ClientMessage, type WorldConfig } from '@super-vox/shared';
import { ChunkManager } from '../src/chunkManager.js';
import { TileManager } from '../src/tileManager.js';
import * as lod from '../src/lod.js';
import type { MeshWorkerPool } from '../src/workerPool.js';

/** A port on this machine, or a server's ws(s):// address. */
const target = process.argv[2] ?? '8799';
const runs = process.argv.slice(3).map((a) => a.split('@').map(Number) as [number, number]);
const DETAIL = Number(process.env.DETAIL ?? 4), VIEW = Number(process.env.VIEW ?? 5440) * UNITS_PER_METER, WORKERS = Number(process.env.WORKERS ?? 4);

/** Real meshing on WORKERS node threads, one job per worker at a time. Jobs may carry `current()`. */
function realPool() {
  const workers = Array.from({ length: WORKERS }, () => new Worker(new URL('./meshWorker.ts', import.meta.url), { execArgv: process.execArgv }));
  const idle = [...workers];
  const queue: { job: { current?: () => boolean }; resolve: (r: unknown) => void }[] = [];
  let ran = 0, skipped = 0, nextId = 1, ms = 0;
  const next = () => {
    while (idle.length && queue.length) {
      const q = queue.shift()!;
      if (q.job.current && !q.job.current()) { skipped++; q.resolve({ id: 0, buffers: null, ms: 0, skipped: true }); continue; }
      const w = idle.pop()!;
      ran++;
      const { current: _c, ...job } = q.job as Record<string, unknown>;
      w.once('message', (res: { ms: number }) => { ms += res.ms; idle.push(w); q.resolve(res); next(); });
      w.postMessage({ ...job, id: nextId++ });
    }
  };
  return {
    pool: { run: (job: object, current?: () => boolean) => new Promise((resolve) => { queue.push({ job: { ...job, ...(current ? { current } : {}) }, resolve }); next(); }) } as unknown as MeshWorkerPool,
    stats: () => ({ ran, skipped, queued: queue.length, ms }),
    close: () => workers.forEach((w) => void w.terminate()),
  };
}

const ws = new WebSocket(/^wss?:/.test(target) ? target : `ws://127.0.0.1:${target}/ws`);
ws.binaryType = 'arraybuffer';
let sent = { chunk: 0, tile: 0, column: 0, cancel: 0 }, got = { chunk: 0, tile: 0 };
const send = (m: ClientMessage) => {
  if (m.type === 'requestChunk') sent.chunk++; else if (m.type === 'requestTile') sent.tile++; else if (m.type === 'requestColumn') sent.column++; else if ((m.type as string) === 'cancel') sent.cancel++;
  ws.send(encodeMessage(m));
};
let world!: WorldConfig, chunks!: ChunkManager, tiles!: TileManager, pools!: ReturnType<typeof realPool>;
const scene = new THREE.Scene(), mat = new THREE.MeshBasicMaterial();
const ready = new Promise<void>((resolve) => {
  ws.onopen = () => ws.send(encodeMessage({ type: 'hello', protocolVersion: PROTOCOL_VERSION, tolerance: 1 }));
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      const f = new Uint8Array(ev.data);
      if (f[0] === BinaryTag.Chunk) { got.chunk++; chunks.onChunkBytes(f.subarray(1)); } else if (f[0] === BinaryTag.Tile) { got.tile++; tiles.onTileBytes(f.subarray(1)); }
      return;
    }
    const msg = decodeServerMessage(ev.data as string);
    if (!msg) return;
    if (msg.type === 'welcome') {
      world = msg.world;
      pools = realPool();
      chunks = new ChunkManager(world, scene, mat, mat, send, pools.pool, 64, () => {}, process.env.COLUMNS ? Number(process.env.COLUMNS) : undefined);
      tiles = new TileManager(scene, mat, mat, send, pools.pool, 32, () => {});
      console.log(`world ${world.widthUnits / UNITS_PER_METER / 1000}x${world.depthUnits / UNITS_PER_METER / 1000} km, tolerance ${msg.tolerance}`);
      resolve();
    } else if (msg.type === 'column') chunks.onColumn(msg);
    else if (msg.type === 'chunkUnavailable') chunks.onChunkUnavailable(msg);
    else if (msg.type === 'tileUnavailable') tiles.onTileUnavailable(msg);
  };
});

let fx = 0, fz = 0, lodColumn = '';
// The game's speed rule (main.ts), unless SPEED_DETAIL=off.
const speedDetail = process.env.SPEED_DETAIL === 'off' ? null : new lod.SpeedDetail(DETAIL, lod.DETAIL_SPEEDS, Number(process.env.GROW_MS ?? lod.DETAIL_GROW_MS));
let chunkRadius = DETAIL;
function updateLod(x: number, z: number, vx: number) {
  chunkRadius = speedDetail ? speedDetail.update(Math.abs(vx) / UNITS_PER_METER, performance.now()) : DETAIL;
  // The client's focus, led in the direction of flight (see main.ts).
  fx = x + lod.focusLead(vx, 0, chunkRadius).dx; fz = z;
  const column = `${Math.floor(fx / CHUNK_SIZE)},${Math.floor(fz / CHUNK_SIZE)},${chunkRadius}`;
  if (column === lodColumn) return;
  lodColumn = column;
  const sel = lod.selectLod(world, fx, fz, DETAIL, VIEW, chunkRadius);
  chunks.setRegion(sel.columns, fx, fz);
  tiles.setTiles(sel.tiles, fx, fz);
}

/** Columns within `r` chunks of the camera with ground drawn: chunks meshed, or a tile over them. */
function covered(camX: number, camZ: number, r: number): number {
  const tm = tiles as unknown as { meshes: Map<string, unknown> };
  const ccx = Math.floor(camX / CHUNK_SIZE), ccz = Math.floor(camZ / CHUNK_SIZE);
  let ok = 0, n = 0;
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    n++;
    if (readinessOf(ccx + dx, ccz + dz)) { ok++; continue; }
    for (let level = 1; level <= 6; level++) {
      const size = tileSizeUnits(level);
      const k = tileKey({ level, tx: Math.floor(((ccx + dx) * CHUNK_SIZE) / size), tz: Math.floor(((ccz + dz) * CHUNK_SIZE) / size) });
      if (tm.meshes.has(k)) { ok++; break; }
    }
  }
  return ok / n;
}

function readinessOf(cx: number, cz: number): boolean {
  const cm = chunks as unknown as { ranges: Map<string, unknown>; meshes: Map<string, unknown>; render: Set<string> };
  const range = cm.ranges.get(`${cx},${cz}`);
  if (range === undefined) return false;
  for (const k of cm.render) if (k.startsWith(`${cx},`) && k.endsWith(`,${cz}`) && !cm.meshes.has(k)) return false;
  return true;
}

/** Columns within `r` chunks (Chebyshev) of the camera that are fully meshed, as a fraction. */
function readiness(camX: number, camZ: number, r: number): number {
  const cm = chunks as unknown as { ranges: Map<string, { lo: number; hi: number } | null>; meshes: Map<string, unknown>; region: Set<string> };
  const ccx = Math.floor(camX / CHUNK_SIZE), ccz = Math.floor(camZ / CHUNK_SIZE);
  let ok = 0, n = 0;
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    n++;
    const key = `${ccx + dx},${ccz + dz}`;
    const range = cm.ranges.get(key);
    if (range === undefined) continue;
    let all = true;
    if (range) for (let cy = range.lo; cy <= range.hi && all; cy++) if (!cm.meshes.has(`${ccx + dx},${cy},${ccz + dz}`)) all = false;
    if (all) ok++;
  }
  return ok / n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nearReadyMs = 0;
async function settle(x: number, z: number, limit = 60_000): Promise<number> {
  const t0 = performance.now();
  nearReadyMs = NaN;
  updateLod(x, z, 0);
  // Settled: full detail back (see SpeedDetail) and everything loaded.
  while (!(chunkRadius === DETAIL && chunks.idle && tiles.idle) && performance.now() - t0 < limit) {
    await sleep(20);
    updateLod(x, z, 0);
    if (Number.isNaN(nearReadyMs) && chunkRadius >= 1 && readiness(x, z, 1) === 1) nearReadyMs = performance.now() - t0;
  }
  return performance.now() - t0;
}

await ready;
// As the game does (main.ts): drop replaced meshes once everything is in, or once covered again.
setInterval(() => {
  if (chunks.idle && tiles.idle) { chunks.retireStale(); tiles.retireStale(); }
  const covered = (f: { x0: number; z0: number; x1: number; z1: number }) => chunks.covers(f) && tiles.covers(f);
  chunks.retireCovered(covered, 30_000); tiles.retireCovered(covered, 30_000);
}, 500).unref();
for (const [speed, row] of runs) {
  // Starting 1 km west of the seam (use a different row each run: nothing cached).
  const z = world.depthUnits / 2 + row * 1000 * UNITS_PER_METER;
  let x = world.widthUnits - 1000 * UNITS_PER_METER;
  const s0 = await settle(x, z);
  sent = { chunk: 0, tile: 0, column: 0, cancel: 0 }; got = { chunk: 0, tile: 0 };
  const p0 = pools.stats();
  const near: number[] = [], region: number[] = [], ground: number[] = [], load: number[][] = [];
  // ROUTE=outback: out east for FLY_S, then back west along the same way (requests on the way back reported).
  const outback = process.env.ROUTE === 'outback';
  const FLY_S = Number(process.env.FLY_S ?? 8), DT = 50;
  const t0 = performance.now();
  let back: { chunk: number; column: number } | null = null;
  for (let t = 0; t < FLY_S * 1000 * (outback ? 2 : 1); t += DT) {
    const dir = outback && t >= FLY_S * 1000 ? -1 : 1;
    if (dir < 0 && !back) back = { chunk: sent.chunk, column: sent.column };
    x += dir * speed * UNITS_PER_METER * DT / 1000;
    updateLod(x, z, dir * speed * UNITS_PER_METER);
    await sleep(DT);
    near.push(readiness(x, z, 1)); region.push(readiness(x, z, DETAIL - 1)); ground.push(covered(x, z, 2));
    const c = chunks.stats, tl = tiles.stats;
    const cm = chunks as unknown as { columnRequested: Set<string>; columnQueue: unknown[]; queue: unknown[]; requested: Set<string> };
    load.push([c.inFlight, c.queued, tl.inFlight, tl.queued, chunks.staleCount + tiles.staleCount, tl.triangles, cm.columnRequested.size, cm.columnQueue.length, cm.queue.length, cm.requested.size]);
  }
  const wall = performance.now() - t0;
  if (back) console.log(`  on the way back: ${sent.column - back.column} column and ${sent.chunk - back.chunk} chunk requests (out: ${back.column} and ${back.chunk})`);
  const endRadius = chunkRadius;
  const settleMs = await settle(x, z);
  const p1 = pools.stats();
  const avg = (a: number[]) => (100 * a.reduce((s, v) => s + v, 0) / a.length).toFixed(0);
  const lastHalf = (a: number[]) => avg(a.slice(a.length / 2));
  const mean = (k: number) => Math.round(load.reduce((a, l) => a + l[k]!, 0) / load.length);
  const last = load[load.length - 1]!;
  console.log(`  ground drawn within 2 chunks: ${avg(ground)}% (2nd half ${lastHalf(ground)}%); voxel chunk radius at the end of the flight: ${endRadius}`);
  console.log(`  while flying (mean): chunks ${mean(0)} in flight / ${mean(1)} queued, tiles ${mean(2)} in flight / ${mean(3)} queued (columns asked ${mean(6)}, column queue ${mean(7)}, chunk queue ${mean(8)}, chunks requested ${mean(9)}) · at the end: ${last[4]} stale meshes, ${(last[5]! / 1e6).toFixed(1)} M far triangles`);
  console.log(`${speed} m/s @ ${row} km for ${(wall / 1000).toFixed(1)} s (initial settle ${(s0 / 1000).toFixed(1)} s): ` +
    `ready within 1 chunk ${avg(near)}% (2nd half ${lastHalf(near)}%), within ${DETAIL - 1} chunks ${avg(region)}% (2nd half ${lastHalf(region)}%) · ` +
    `settle after stopping ${(settleMs / 1000).toFixed(2)} s (voxels within 1 chunk after ${(nearReadyMs / 1000).toFixed(2)} s) · sent ${sent.column} col/${sent.chunk} chunk/${sent.tile} tile/${sent.cancel} cancel, got ${got.chunk} chunks/${got.tile} tiles · meshed ${p1.ran - p0.ran} in ${((p1.ms - p0.ms) / 1000).toFixed(1)} worker-s (skipped ${p1.skipped - p0.skipped})`);
}
ws.close();
pools.close();
