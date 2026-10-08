import type { DayClock } from './clock.js';
import type { Edit } from './edit.js';
import { isValidTileLevel } from './tile.js';
import type { ColumnRange } from './chunk.js';
import { HOTBAR_SLOTS, type GameMode } from './items.js';
import { MAX_MATERIAL_ID } from './materials.js';
import type { DebrisPiece } from './debris.js';
import type { DeathCause } from './survival.js';
import { isFacing, type Facing, type PlacedObject } from './objects.js';
import { isDesignOffset, type ObjectDesign } from './designs.js';
import type { Boat } from './boats.js';
import type { ArrowShot } from './arrows.js';
import type { EntityKind } from './mobs.js';
import type { StationKind, StationState } from './stations.js';
import { UNITS_PER_METER } from './units.js';
import { CHUNK_SIZE, type WorldConfig } from './world.js';

/** Bumped whenever a message shape changes incompatibly. */
export const PROTOCOL_VERSION = 40;

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
  /**
   * Place an object (an item that places one: fence, gate, door) in block (x, y, z) (1 m block
   * coordinates), facing `facing` (a torch: on the floor, or `wall`: on the wall that way);
   * answered with `editResult` (`id` as for edits).
   */
  | { type: 'placeObject'; id: number; item: number; x: number; y: number; z: number; facing: Facing; wall?: boolean; /** A design: off the 1 m grid by this (units, see isDesignOffset). */ offset?: [number, number, number] }
  /**
   * A bucket at block (x, y, z) (1 m block coordinates): `fill` takes up to 1 m of water from it,
   * otherwise pours up to 1 m into it (see PouredWater); answered with `editResult`.
   */
  | { type: 'bucket'; id: number; x: number; y: number; z: number; fill: boolean }
  /**
   * Boats (see boats.ts): putting one in the water (from the boat item) with its hull's bottom at
   * (x, y, z) (units) pointing `yaw`; getting into one; taking one (back into the inventory). Each
   * answered with `editResult` (`id` as for edits).
   */
  | { type: 'boatLaunch'; id: number; x: number; y: number; z: number; yaw: number }
  | { type: 'boatBoard'; id: number; boat: number }
  | { type: 'boatTake'; id: number; boat: number }
  /** Where the boat we're in is now (a few times a second while it moves; no answer); `leave`: and we've got out. */
  | { type: 'boatMove'; boat: number; x: number; y: number; z: number; yaw: number; leave?: boolean }
  /** Shoots an arrow (a bow in hand, see arrows.ts): from the eye at (x, y, z) (units) along (dx, dy, dz), drawn `charge` (0..1). */
  | { type: 'shoot'; x: number; y: number; z: number; dx: number; dy: number; dz: number; charge: number }
  /** A sword's sweep (`sword`: the item) cutting leaves around block (x, y, z); answered with `editResult`. */
  | { type: 'cut'; id: number; sword: number; x: number; y: number; z: number }
  /**
   * Survival: starting to mine what's at unit (x, y, z) (a voxel, or a dig box's corner); the
   * edit that removes it is accepted once it's been mined long enough (see minedLongEnough), with
   * `tool` (the item in hand, if it's a tool: see tools.ts) as fast as that makes it, and giving
   * what that gives.
   */
  | { type: 'mine'; x: number; y: number; z: number; tool?: number }
  /** Light the TNT with a voxel at unit (x, y, z); answered with `editResult`. */
  | { type: 'ignite'; id: number; x: number; y: number; z: number }
  /** Use (open or close) the object with a voxel at unit (x, y, z); answered with `editResult`. */
  | { type: 'use'; id: number; x: number; y: number; z: number }
  /**
   * A furnace or stove (see stations.ts), the one taking block (x, y, z): open it (answered with
   * `station`, and again whenever it changes, until closed); put `amount` of `item` (stored terms:
   * blocks by volume, items by count) from the inventory in a slot; take `amount` of a slot's
   * contents (default: all of it) into the inventory. Refusals come as an `error` with code 'station'.
   */
  | { type: 'stationOpen'; x: number; y: number; z: number }
  | { type: 'stationPut'; x: number; y: number; z: number; slot: 'fuel' | 'input'; item: number; amount: number }
  | { type: 'stationTake'; x: number; y: number; z: number; slot: 'fuel' | 'input' | 'output'; amount?: number }
  | { type: 'stationClose' }
  /** Hit a mob (`target`, an entity id) with what's in hand (`weapon`: an item id, null for a bare hand). */
  | { type: 'attack'; target: number; weapon: number | null }
  /** Survival: landed from a fall at `speed` (m/s, downward); see fallDamage. */
  | { type: 'fell'; speed: number }
  /** Survival: eat one of `item` (a food; see FOODS). */
  | { type: 'eat'; item: number }
  /** Make something (a recipe id, see RECIPES); answered with the new inventory, or an error. */
  | { type: 'craft'; recipe: string }
  /** The player's hotbar arrangement (HOTBAR_SLOTS item ids, null for empty), kept with their inventory. */
  | { type: 'setHotbar'; hotbar: (number | null)[] }
  /** Survival: throw away `amount` of `item` (stored amounts: blocks by volume, items by count). */
  | { type: 'discard'; item: number; amount: number }
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
      /** The world's weather (see weather.ts: worked out from this and the server's time); absent from servers before weather. */
      weather?: { seed: number };
      /** Who this connection is signed in as (null: not signed in). */
      player: { name: string; admin: boolean } | null;
      /** Whether this connection may edit (signing in is required where the server has accounts). */
      canEdit: boolean;
      /** The world's game mode (absent from servers before modes were told here: treat as creative). */
      mode?: GameMode;
    }
  /**
   * The player's inventory in this world (after welcome, and whenever it changes): the world's
   * game mode; in survival, what they have (materials as unit-voxel volumes, see BLOCK_VOLUME;
   * items counted); and their hotbar. Not sent to players who aren't signed in.
   */
  | { type: 'inventory'; mode: GameMode; items: [number, number][]; hotbar: (number | null)[] }
  /** The library of designed objects (see designs.ts): after welcome, and whenever an admin changes it. */
  | { type: 'designs'; designs: ObjectDesign[] }
  /**
   * The designed objects placed in the world (after welcome, and whenever one is placed, taken down
   * or changes state), so clients know a click on one means it (they're built of ordinary materials).
   */
  | { type: 'objects'; objects: PlacedObject[] }
  /** The world's boats (see Boat), on joining and whenever one's put in, taken, got into or out of. */
  | { type: 'boats'; boats: Boat[] }
  /** An arrow shot (see ArrowShot): everyone near flies it, from now. */
  | { type: 'arrow'; arrow: ArrowShot }
  /** Where an arrow stopped: stuck in the world, in water, in a mob or a player, or gone (flown its time). */
  | { type: 'arrowHit'; id: number; x: number; y: number; z: number; what: 'world' | 'water' | 'mob' | 'player' | 'gone' }
  /** A boat someone's in has moved. */
  | { type: 'boatMoved'; id: number; x: number; y: number; z: number; yaw: number }
  /**
   * Everything moving near the player (mobs and other players, see EntitySnapshot), as it is now;
   * sent a few times a second. Anything not listed has gone (out of range, or gone for good).
   */
  | { type: 'entities'; entities: EntitySnapshot[] }
  /**
   * Survival: the player's health (of `max`), food (of MAX_FOOD) and breath (bubbles, of MAX_AIR),
   * after any changes; at 0 health they've died and come back (see `respawn`).
   */
  | { type: 'health'; health: number; max: number; food: number; air: number }
  /**
   * Signed-in players coming back to a world: where they were when they last left it (eye, units;
   * yaw, radians), sent once their inventory has loaded. Not sent the first time in a world.
   */
  | { type: 'returnTo'; x: number; y: number; z: number; yaw: number }
  /**
   * The player died (how, if known) and comes back at (x, y, z) (feet, units): at their bed
   * (`bed: 'here'`), or at the spawn point, their bed having been taken down (`'gone'`) or built
   * over (`'blocked'`); no `bed`: they never had one.
   */
  | { type: 'respawn'; x: number; y: number; z: number; cause?: DeathCause; bed?: 'here' | 'gone' | 'blocked' }
  /**
   * The furnace or stove open (see `stationOpen`): its origin block (x, y, z), what it is, and what's
   * in it as of `serverTime` (ms); `state` null: it's gone (taken down).
   */
  | { type: 'station'; x: number; y: number; z: number; kind: StationKind; name: string; state: StationState | null; serverTime: number }
  /** TNT lit: the voxel at (x, y, z) of `size` (units) blows in `ms`. */
  | { type: 'fuse'; x: number; y: number; z: number; size: number; ms: number }
  /**
   * An explosion centred at (x, y, z) (units) of `radius` (units), for its flash, dust (from
   * `seed`, thrown toward `open`: see openDirection) and sound; sent before the chunks it changed,
   * so clients can see what it blew apart.
   */
  | { type: 'explosion'; x: number; y: number; z: number; radius: number; seed: number; open: [number, number, number] }
  /** An explosion's debris: each piece's flight (see DebrisPiece), from now. */
  | { type: 'debris'; pieces: DebrisPiece[] }
  /** The world's clock was changed (time set, stopped, or a new day length). */
  | { type: 'clock'; clock: DayClock; serverTime: number }
  /**
   * What a column holds (see ColumnRange); minY/maxY are null for columns outside the world. In
   * reply to requestColumn, `sent` names the chunk layers (inclusive spans) the server sends next:
   * those columnSpans renders from above the water, and one either side. A column sent for another
   * reason (an edit changed it) has none.
   */
  | {
      type: 'column';
      cx: number;
      cz: number;
      minY: number | null;
      maxY: number | null;
      solidTop?: number;
      water?: { min: number; max: number };
      sent?: Span[];
    }
  /** Reply to requestTile for a tile entirely outside the world. */
  | { type: 'tileUnavailable'; level: number; tx: number; tz: number }
  /** Reply to requestChunk for a chunk outside the world. */
  | { type: 'chunkUnavailable'; cx: number; cy: number; cz: number }
  | { type: 'editResult'; id: number; ok: true; note?: string }
  | { type: 'editResult'; id: number; ok: false; error: string }
  | { type: 'error'; code: string; message: string };

/** Something moving that a player sees: where its feet are (units), which way it faces, how hurt. */
export interface EntitySnapshot {
  id: number;
  kind: EntityKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Health left and the most it can have (mobs). */
  health?: number;
  max?: number;
  /** Hurt just now (for a flash). */
  hurt?: boolean;
  /** Players: their name. */
  name?: string;
}

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

/** Inclusive range of chunk layers. */
export interface Span {
  lo: number;
  hi: number;
}

/**
 * How far down through water (units) the ground is worth drawing: light from deeper is all but
 * absorbed (about 1% left in blue, the clearest; see WATER_ABSORB) whether seen from above the
 * surface or swimming.
 */
export const SEE_DEPTH = 96 * UNITS_PER_METER;

/**
 * The chunk layers to render for a column (sorted, disjoint spans), seen from height `viewY`
 * (units; above all water when omitted): the water's surface, the ground down to SEE_DEPTH below
 * the water or the viewer, whichever is lower, and, under water, the layer the viewer is in.
 * Chunks holding only deeper water or water between the two are skipped: they draw nothing.
 */
export function columnSpans(range: ColumnRange, viewY?: number): Span[] {
  const { minY, maxY, solidTop, water } = range;
  if (!water || solidTop === undefined) return [columnLayers(minY, maxY)];
  const spans: Span[] = [];
  const under = viewY !== undefined && viewY < water.max;
  const cutoff = Math.min(water.min, under ? viewY : Infinity) - SEE_DEPTH;
  if (solidTop >= cutoff) spans.push(columnLayers(Math.max(minY, cutoff), solidTop));
  spans.push(columnLayers(water.min, water.max));
  if (under && viewY > minY) spans.push(columnLayers(viewY, viewY));
  return mergeSpans(spans);
}

/** Sorts spans and joins those that overlap or touch. */
export function mergeSpans(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((a, b) => a.lo - b.lo)) {
    const last = out[out.length - 1];
    if (last && s.lo <= last.hi + 1) last.hi = Math.max(last.hi, s.hi);
    else out.push({ ...s });
  }
  return out;
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
  const isId = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 2 ** 32;
  if (msg.type === 'placeObject' && isId(msg.id) && isInt32(msg.item) && isInt32(msg.x) && isInt32(msg.y) && isInt32(msg.z) && isFacing(msg.facing)) {
    if (msg.wall !== undefined && typeof msg.wall !== 'boolean') return null;
    if (msg.offset !== undefined && !isDesignOffset(msg.offset)) return null;
    return { type: 'placeObject', id: msg.id as number, item: msg.item, x: msg.x, y: msg.y, z: msg.z, facing: msg.facing, ...(msg.wall ? { wall: true } : {}), ...(msg.offset ? { offset: [...msg.offset] as [number, number, number] } : {}) };
  }
  if (msg.type === 'bucket' && isId(msg.id) && isInt32(msg.x) && isInt32(msg.y) && isInt32(msg.z) && typeof msg.fill === 'boolean') {
    return { type: 'bucket', id: msg.id as number, x: msg.x, y: msg.y, z: msg.z, fill: msg.fill };
  }
  if (msg.type === 'cut' && isId(msg.id) && isInt32(msg.sword) && isInt32(msg.x) && isInt32(msg.y) && isInt32(msg.z)) {
    return { type: 'cut', id: msg.id as number, sword: msg.sword, x: msg.x, y: msg.y, z: msg.z };
  }
  if (msg.type === 'mine' && isInt32(msg.x) && isInt32(msg.y) && isInt32(msg.z) && (msg.tool === undefined || isInt32(msg.tool))) {
    return { type: 'mine', x: msg.x, y: msg.y, z: msg.z, ...(msg.tool !== undefined ? { tool: msg.tool as number } : {}) };
  }
  if (msg.type === 'ignite' && isId(msg.id) && isInt32(msg.x) && isInt32(msg.y) && isInt32(msg.z)) {
    return { type: 'ignite', id: msg.id as number, x: msg.x, y: msg.y, z: msg.z };
  }
  if (msg.type === 'use' && isId(msg.id) && isInt32(msg.x) && isInt32(msg.y) && isInt32(msg.z)) {
    return { type: 'use', id: msg.id as number, x: msg.x, y: msg.y, z: msg.z };
  }
  if ((msg.type === 'stationOpen' || msg.type === 'stationPut' || msg.type === 'stationTake') && isInt32(msg.x) && isInt32(msg.y) && isInt32(msg.z)) {
    const at = { x: msg.x as number, y: msg.y as number, z: msg.z as number };
    if (msg.type === 'stationOpen') return { type: 'stationOpen', ...at };
    if (msg.type === 'stationTake' && (msg.slot === 'fuel' || msg.slot === 'input' || msg.slot === 'output') && (msg.amount === undefined || (Number.isSafeInteger(msg.amount) && (msg.amount as number) > 0))) {
      return { type: 'stationTake', ...at, slot: msg.slot, ...(msg.amount !== undefined ? { amount: msg.amount as number } : {}) };
    }
    if (msg.type === 'stationPut' && (msg.slot === 'fuel' || msg.slot === 'input') && isInt32(msg.item) && Number.isSafeInteger(msg.amount) && (msg.amount as number) > 0) {
      return { type: 'stationPut', ...at, slot: msg.slot, item: msg.item as number, amount: msg.amount as number };
    }
  }
  if (msg.type === 'stationClose') return { type: 'stationClose' };
  if (msg.type === 'attack' && isId(msg.target) && (msg.weapon === null || isInt32(msg.weapon))) {
    return { type: 'attack', target: msg.target as number, weapon: msg.weapon as number | null };
  }
  if (msg.type === 'fell' && typeof msg.speed === 'number' && Number.isFinite(msg.speed) && msg.speed >= 0) {
    return { type: 'fell', speed: msg.speed };
  }
  if (msg.type === 'eat' && isInt32(msg.item)) {
    return { type: 'eat', item: msg.item };
  }
  if (msg.type === 'craft' && typeof msg.recipe === 'string' && /^[a-z0-9:-]{1,64}$/.test(msg.recipe)) {
    return { type: 'craft', recipe: msg.recipe };
  }
  if (
    msg.type === 'setHotbar' &&
    Array.isArray(msg.hotbar) &&
    msg.hotbar.length === HOTBAR_SLOTS &&
    msg.hotbar.every((v) => v === null || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_MATERIAL_ID))
  ) {
    return { type: 'setHotbar', hotbar: msg.hotbar as (number | null)[] };
  }
  if (msg.type === 'discard' && Number.isInteger(msg.item) && (msg.item as number) >= 0 && (msg.item as number) <= MAX_MATERIAL_ID && Number.isInteger(msg.amount) && (msg.amount as number) > 0) {
    return { type: 'discard', item: msg.item as number, amount: msg.amount as number };
  }
  const finite = (...vs: unknown[]) => vs.every((v) => typeof v === 'number' && Number.isFinite(v));
  const isWhole = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 2 ** 32;
  if (msg.type === 'shoot' && finite(msg.x, msg.y, msg.z, msg.dx, msg.dy, msg.dz, msg.charge)) {
    return { type: 'shoot', x: msg.x as number, y: msg.y as number, z: msg.z as number, dx: msg.dx as number, dy: msg.dy as number, dz: msg.dz as number, charge: msg.charge as number };
  }
  if (msg.type === 'boatLaunch' && isWhole(msg.id) && finite(msg.x, msg.y, msg.z, msg.yaw)) {
    return { type: 'boatLaunch', id: msg.id as number, x: msg.x as number, y: msg.y as number, z: msg.z as number, yaw: msg.yaw as number };
  }
  if ((msg.type === 'boatBoard' || msg.type === 'boatTake') && isWhole(msg.id) && isWhole(msg.boat)) {
    return { type: msg.type, id: msg.id as number, boat: msg.boat as number };
  }
  if (msg.type === 'boatMove' && isWhole(msg.boat) && finite(msg.x, msg.y, msg.z, msg.yaw) && (msg.leave === undefined || typeof msg.leave === 'boolean')) {
    return { type: 'boatMove', boat: msg.boat as number, x: msg.x as number, y: msg.y as number, z: msg.z as number, yaw: msg.yaw as number, ...(msg.leave ? { leave: true } : {}) };
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
  if (e.op === 'fillBox' && isInt32(e.size) && isInt32(e.material)) return { op: 'fillBox', x, y, z, size: e.size, material: e.material };
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
