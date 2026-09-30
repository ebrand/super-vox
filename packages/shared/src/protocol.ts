import type { WorldConfig } from './world.js';

/** Bumped whenever a message shape changes incompatibly. */
export const PROTOCOL_VERSION = 2;

export type ClientMessage =
  | { type: 'hello'; protocolVersion: number }
  | { type: 'requestChunk'; cx: number; cy: number; cz: number };

export type ServerMessage =
  | { type: 'welcome'; protocolVersion: number; world: WorldConfig }
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
    return { type: 'hello', protocolVersion: msg.protocolVersion };
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
