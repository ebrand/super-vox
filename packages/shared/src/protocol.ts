import type { WorldConfig } from './world.js';

/** Bumped whenever a message shape changes incompatibly. */
export const PROTOCOL_VERSION = 5;

export type ClientMessage =
  | {
      type: 'hello';
      protocolVersion: number;
      /**
       * Development only: ask for terrain voxelized with this tolerance
       * (integer units, 0..16). Servers in production ignore it.
       */
      tolerance?: number;
    }
  | { type: 'requestChunk'; cx: number; cy: number; cz: number };

export type ServerMessage =
  | {
      type: 'welcome';
      protocolVersion: number;
      world: WorldConfig;
      /** Suggested starting point in world units: on the ground at the world's centre. */
      spawn: { x: number; y: number; z: number };
      /** Tolerance actually used for this connection's terrain; null for non-adaptive worlds. */
      tolerance: number | null;
    }
  /** Reply to requestChunk for a chunk outside the world. */
  | { type: 'chunkUnavailable'; cx: number; cy: number; cz: number }
  | { type: 'error'; code: string; message: string };

/**
 * Binary server frames start with a one-byte tag. The rest of the frame is
 * the payload for that tag.
 */
export const BinaryTag = {
  /** Payload: an encoded chunk (see chunkcodec.ts). */
  Chunk: 1,
} as const;

export function encodeMessage(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

/** Largest tolerance a client may request (1 m). */
export const MAX_REQUESTED_TOLERANCE = 16;

export function isValidTolerance(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_REQUESTED_TOLERANCE;
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
    if (msg.tolerance === undefined) return { type: 'hello', protocolVersion: msg.protocolVersion };
    if (!isValidTolerance(msg.tolerance)) return null;
    return { type: 'hello', protocolVersion: msg.protocolVersion, tolerance: msg.tolerance };
  }
  if (msg.type === 'requestChunk' && isInt32(msg.cx) && isInt32(msg.cy) && isInt32(msg.cz)) {
    return { type: 'requestChunk', cx: msg.cx, cy: msg.cy, cz: msg.cz };
  }
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
