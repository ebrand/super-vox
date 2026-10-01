import type { DayClock } from './clock.js';
import type { Edit } from './edit.js';
import { isValidTileLevel } from './tile.js';
import { CHUNK_SIZE, type WorldConfig } from './world.js';

/** Bumped whenever a message shape changes incompatibly. */
export const PROTOCOL_VERSION = 17;

export type ClientMessage =
  | {
      type: 'hello';
      protocolVersion: number;
      /**
       * Development only: ask for terrain voxelized with this tolerance
       * (integer units, 0..16). Servers in production ignore it.
       */
      tolerance?: number;
      /** Which world to join (see WORLD_NAME_PATTERN); the server's default when omitted. */
      world?: string;
    }
  | { type: 'requestChunk'; cx: number; cy: number; cz: number }
  /** Low-detail tile for distant terrain; answered with a Tile binary frame. */
  | { type: 'requestTile'; level: number; tx: number; tz: number }
  /**
   * Ground height range of a chunk column; answered with a `column` message, followed by the
   * column's chunks in the layers the reply names (`sent`), as if each had been requested.
   */
  | { type: 'requestColumn'; cx: number; cz: number }
  /**
   * Requests (as sent: chunks [cx, cy, cz], tiles [level, tx, tz], columns [cx, cz]) the client no
   * longer wants. The server drops those it hasn't answered yet; answers already sent still arrive.
   */
  | { type: 'cancel'; chunks?: [number, number, number][]; tiles?: [number, number, number][]; columns?: [number, number][] }
  /** A voxel edit; answered with `editResult`. `id` is chosen by the client to match the reply. */
  | { type: 'edit'; id: number; edit: Edit }
  /** Where the player is (world units) and faces (radians, 0 = -Z); sent a couple of times a second, not answered. */
  | { type: 'pose'; x: number; y: number; z: number; yaw: number };

export type ServerMessage =
  | {
      type: 'welcome';
      protocolVersion: number;
      world: WorldConfig;
      /** Suggested starting point in world units: on the ground at the world's centre. */
      spawn: { x: number; y: number; z: number };
      /** Tolerance actually used for this connection's terrain; null for non-adaptive worlds. */
      tolerance: number | null;
      /** Y (units) of the sea surface; null if the world has no sea. */
      seaLevel: number | null;
      /** The world's time of day, and the server's time now (epoch ms) to read it against. */
      clock: DayClock;
      serverTime: number;
    }
  /** The world's clock was changed (time set, stopped, or a new day length). */
  | { type: 'clock'; clock: DayClock; serverTime: number }
  /**
   * A column's ground height range; minY/maxY are null for columns outside the world. In reply to
   * requestColumn, `sent` names the chunk layers (inclusive) the server sends next; a column sent
   * for another reason (an edit changed it) has none.
   */
  | { type: 'column'; cx: number; cz: number; minY: number | null; maxY: number | null; sent?: { lo: number; hi: number } }
  /** Reply to requestTile for a tile entirely outside the world. */
  | { type: 'tileUnavailable'; level: number; tx: number; tz: number }
  /** Reply to requestChunk for a chunk outside the world. */
  | { type: 'chunkUnavailable'; cx: number; cy: number; cz: number }
  | { type: 'editResult'; id: number; ok: true }
  | { type: 'editResult'; id: number; ok: false; error: string }
  | { type: 'error'; code: string; message: string };

/**
 * Binary server frames start with a one-byte tag. The rest of the frame is
 * the payload for that tag.
 */
export const BinaryTag = {
  /** Payload: an encoded chunk (see chunkcodec.ts). */
  Chunk: 1,
  /** Payload: an encoded tile (see tile.ts). */
  Tile: 2,
} as const;

export function encodeMessage(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

/** Largest tolerance a client may request (1 m). */
export const MAX_REQUESTED_TOLERANCE = 16;

export function isValidTolerance(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_REQUESTED_TOLERANCE;
}

/** World names: lower-case letters, digits, '-' and '_', starting with a letter or digit. */
export const WORLD_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isValidWorldName(v: unknown): v is string {
  return typeof v === 'string' && WORLD_NAME_PATTERN.test(v);
}

/** Most entries per list in a `cancel` message. */
export const MAX_CANCEL = 4096;

/**
 * Chunk layers (inclusive) holding the surface of a column whose ground spans [minY, maxY] (units):
 * the layers a client renders. Surface voxels occupy units up to maxY - 1; this allows 1 m either
 * way for voxelization rounding (tolerance <= 16 units).
 */
export function columnLayers(minY: number, maxY: number): { lo: number; hi: number } {
  return { lo: Math.floor((minY - 17) / CHUNK_SIZE), hi: Math.floor((maxY + 16) / CHUNK_SIZE) };
}

function isInt32(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= -(2 ** 31) && v < 2 ** 31;
}

/** Parses a client message, returning null for anything malformed. */
export function decodeClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const msg = data as Record<string, unknown>;
  if (msg.type === 'hello' && typeof msg.protocolVersion === 'number') {
    const hello: ClientMessage = { type: 'hello', protocolVersion: msg.protocolVersion };
    if (msg.tolerance !== undefined) {
      if (!isValidTolerance(msg.tolerance)) return null;
      hello.tolerance = msg.tolerance;
    }
    if (msg.world !== undefined) {
      if (!isValidWorldName(msg.world)) return null;
      hello.world = msg.world;
    }
    return hello;
  }
  if (msg.type === 'requestChunk' && isInt32(msg.cx) && isInt32(msg.cy) && isInt32(msg.cz)) {
    return { type: 'requestChunk', cx: msg.cx, cy: msg.cy, cz: msg.cz };
  }
  if (msg.type === 'requestTile' && isValidTileLevel(msg.level) && isInt32(msg.tx) && isInt32(msg.tz)) {
    return { type: 'requestTile', level: msg.level, tx: msg.tx, tz: msg.tz };
  }
  if (msg.type === 'requestColumn' && isInt32(msg.cx) && isInt32(msg.cz)) {
    return { type: 'requestColumn', cx: msg.cx, cz: msg.cz };
  }
  if (msg.type === 'cancel') {
    const list = (v: unknown, n: number): number[][] | null | undefined =>
      v === undefined ? undefined : Array.isArray(v) && v.length <= MAX_CANCEL && v.every((e) => Array.isArray(e) && e.length === n && e.every(isInt32)) ? (v as number[][]) : null;
    const chunks = list(msg.chunks, 3), tiles = list(msg.tiles, 3), columns = list(msg.columns, 2);
    if (chunks === null || tiles === null || columns === null) return null;
    return {
      type: 'cancel',
      ...(chunks ? { chunks: chunks as [number, number, number][] } : {}),
      ...(tiles ? { tiles: tiles as [number, number, number][] } : {}),
      ...(columns ? { columns: columns as [number, number][] } : {}),
    };
  }
  if (msg.type === 'pose' && [msg.x, msg.y, msg.z, msg.yaw].every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return { type: 'pose', x: msg.x as number, y: msg.y as number, z: msg.z as number, yaw: msg.yaw as number };
  }
  if (msg.type === 'edit' && typeof msg.id === 'number' && Number.isInteger(msg.id) && msg.id >= 0 && msg.id < 2 ** 32) {
    const edit = decodeEdit(msg.edit);
    if (edit) return { type: 'edit', id: msg.id, edit };
  }
  return null;
}

function decodeEdit(data: unknown): Edit | null {
  if (typeof data !== 'object' || data === null) return null;
  const e = data as Record<string, unknown>;
  if (!isInt32(e.x) || !isInt32(e.y) || !isInt32(e.z)) return null;
  const { x, y, z } = e;
  if (e.op === 'remove') return { op: 'remove', x, y, z };
  if (e.op === 'break' && isInt32(e.pieceSize)) return { op: 'break', x, y, z, pieceSize: e.pieceSize };
  if (e.op === 'place' && isInt32(e.size) && isInt32(e.material)) return { op: 'place', x, y, z, size: e.size, material: e.material };
  if (e.op === 'removeBox' && isInt32(e.size)) return { op: 'removeBox', x, y, z, size: e.size };
  return null;
}

/** Parses a server message. The server is trusted, so only the type tag is checked. */
export function decodeServerMessage(raw: string): ServerMessage | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data === 'object' && data !== null && 'type' in data) {
      return data as ServerMessage;
    }
  } catch {
    // fall through
  }
  return null;
}
