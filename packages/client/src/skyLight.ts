import { BLOCK_SIZE, BLOCKS_PER_AXIS } from '@super-vox/shared';

/**
 * Light, like Minecraft's. Sky light: 15 in every block open to the sky (nothing that stops light
 * above it, see chunkOpacity), one less for each block away from that (through blocks that let
 * light through), so caves and overhangs go dark. Block light: from blocks that give it (torches,
 * see chunkLighting), spreading the same way. Light reaches 15 blocks at most, so a chunk's light
 * is found exactly from the chunks around it (3 x 3 x 3, a box of 48 blocks): every chunk works
 * out the same light where they meet, and shading has no seams between chunks.
 */
export const SKY_LIGHT = 15;

const N = BLOCKS_PER_AXIS;
/** The box: the chunk and those around it, in blocks; the chunk is [N, 2N) on each axis. */
export const BOX = 3 * N;
const boxIndex = (x: number, y: number, z: number) => x + BOX * (z + BOX * y);

/**
 * What a chunk's light is worked out from: per chunk around it (27, index (dx + 1) + 3 * ((dz +
 * 1) + 3 * (dy + 1)), the chunk itself 13) which blocks stop light (blockIndex order, 1 = stops
 * it), or 0 for none and 1 for all; per block column of the box (x + BOX * z), 1 where something
 * above the box stops light; and per chunk the blocks giving light (see chunkLighting), if any.
 */
export interface LightInput {
  opaque: (Uint8Array | 0 | 1)[];
  above: Uint8Array;
  glow?: (Uint16Array | null)[];
}

/** A chunk's light: sky and block light in its box (boxIndex order; null: all full, or none). */
export interface LightFields {
  sky: Uint8Array | null;
  block: Uint8Array | null;
}

/** Index into LightInput.opaque of the chunk at offset (dx, dy, dz). */
export const aroundIndex = (dx: number, dy: number, dz: number) => dx + 1 + 3 * (dz + 1 + 3 * (dy + 1));

/**
 * The sky light in the box (boxIndex order), or null when every block the chunk's faces are lit
 * by (the chunk and the blocks next to it) is open to the sky: all at full light.
 */
export function skyLight(input: LightInput): Uint8Array | null {
  return lightFields(input).sky;
}

/** A chunk's sky and block light (see LightFields). */
export function lightFields(input: LightInput): LightFields {
  const opaque = new Uint8Array(BOX * BOX * BOX);
  for (let dy = -1; dy <= 1; dy++)
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const o = input.opaque[aroundIndex(dx, dy, dz)]!;
        if (o === 0) continue;
        const x0 = (dx + 1) * N, y0 = (dy + 1) * N, z0 = (dz + 1) * N;
        for (let y = 0; y < N; y++)
          for (let z = 0; z < N; z++) {
            const row = boxIndex(x0, y0 + y, z0 + z);
            if (o === 1) opaque.fill(1, row, row + N);
            else for (let x = 0; x < N; x++) opaque[row + x] = o[x + N * (z + N * y)]!;
          }
      }
  // Open to the sky: down each column from the top until something stops the light.
  const light = new Uint8Array(BOX * BOX * BOX);
  for (let z = 0; z < BOX; z++)
    for (let x = 0; x < BOX; x++) {
      if (input.above[x + BOX * z]) continue;
      for (let y = BOX - 1; y >= 0; y--) {
        const i = boxIndex(x, y, z);
        if (opaque[i]) break;
        light[i] = SKY_LIGHT;
      }
    }
  // All the chunk's faces see is open to the sky? (The chunk and one block round it.)
  let dark = false;
  for (let y = N - 1; y <= 2 * N && !dark; y++)
    for (let z = N - 1; z <= 2 * N && !dark; z++)
      for (let x = N - 1; x <= 2 * N; x++) {
        const i = boxIndex(x, y, z);
        if (!opaque[i] && !light[i]) {
          dark = true;
          break;
        }
      }
  const sky = dark ? spread(opaque, light) : null;
  return { sky, block: blockLight(input, opaque) };
}

/** Light from the blocks giving it, spread through the box; null if none in it. */
function blockLight(input: LightInput, opaque: Uint8Array): Uint8Array | null {
  if (!input.glow?.some((g) => g)) return null;
  const light = new Uint8Array(BOX * BOX * BOX);
  for (let dy = -1; dy <= 1; dy++)
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const g = input.glow[aroundIndex(dx, dy, dz)];
        if (!g) continue;
        for (const v of g) {
          const b = v >> 4, l = v & 15;
          const x = (dx + 1) * N + (b % N), z = (dz + 1) * N + (Math.floor(b / N) % N), y = (dy + 1) * N + Math.floor(b / (N * N));
          const i = boxIndex(x, y, z);
          light[i] = Math.max(light[i]!, l);
        }
      }
  return spread(opaque, light);
}

/**
 * Spreads `light` (what's lit in it so far: the sources) one less per block through what lets it
 * through, brightest first (so each block is reached once, at its brightest); then marks the
 * blocks that stop it (OPAQUE: they don't count toward a corner, see faceLight). Returns `light`.
 */
function spread(opaque: Uint8Array, light: Uint8Array): Uint8Array {
  const STEP = [1, -1, BOX * BOX, -BOX * BOX, BOX, -BOX];
  const levels: number[][] = Array.from({ length: SKY_LIGHT + 1 }, () => []);
  for (let i = 0; i < light.length; i++) if (light[i]) levels[light[i]!]!.push(i);
  for (let l = SKY_LIGHT; l > 1; l--) {
    const next = levels[l - 1]!;
    for (const i of levels[l]!) {
      if (light[i] !== l) continue;
      const x = i % BOX, z = Math.floor(i / BOX) % BOX, y = Math.floor(i / (BOX * BOX));
      for (let d = 0; d < 6; d++) {
        // (Not off the box's sides.)
        if ((d === 0 && x === BOX - 1) || (d === 1 && x === 0) || (d === 2 && y === BOX - 1) || (d === 3 && y === 0) || (d === 4 && z === BOX - 1) || (d === 5 && z === 0)) continue;
        const j = i + STEP[d]!;
        if (opaque[j] || light[j]! >= l - 1) continue;
        light[j] = l - 1;
        next.push(j);
      }
    }
  }
  for (let i = 0; i < opaque.length; i++) if (opaque[i]) light[i] = OPAQUE;
  return light;
}

const OPAQUE = 255;

/** In-plane axes for faces perpendicular to each axis (as the mesher's). */
const U_AXIS = [1, 2, 0] as const;
const V_AXIS = [2, 0, 1] as const;

/**
 * The light (0..255 for 0..15; sky or block light) at the four corners (u, v), (u+du, v), (u+du, v+dv), (u, v+dv) of
 * a face in direction `dir` (0..5: +X, -X, +Y, -Y, +Z, -Z) on `plane` (chunk-local units): from
 * the blocks in front of it, at each block corner the average of the four around it that let
 * light through, and between block corners blended, so it shades smoothly.
 */
export function faceLight(
  light: Uint8Array,
  dir: number,
  plane: number,
  u: number,
  v: number,
  du: number,
  dv: number,
  /** The light where nothing in front lets it through (e.g. against the loaded area's edge). */
  closed = SKY_LIGHT,
): [number, number, number, number] {
  const axis = dir >> 1, sign = dir & 1 ? -1 : 1;
  const ua = U_AXIS[axis]!, va = V_AXIS[axis]!;
  // The layer of blocks in front of the face (box coordinates).
  const layer = Math.floor((plane + sign * 0.5) / BLOCK_SIZE) + N;
  const c = [0, 0, 0];
  c[axis] = layer;
  /** At block corner (i, j) (box block coordinates on U and V). */
  const atCorner = (i: number, j: number) => {
    let sum = 0, n = 0;
    for (let a = i - 1; a <= i; a++)
      for (let b = j - 1; b <= j; b++) {
        if (a < 0 || b < 0 || a >= BOX || b >= BOX) continue;
        c[ua] = a; c[va] = b;
        const l = light[boxIndex(c[0]!, c[1]!, c[2]!)]!;
        if (l === OPAQUE) continue;
        sum += l;
        n++;
      }
    return n ? sum / n : closed;
  };
  const at = (cu: number, cv: number) => {
    const fu = cu / BLOCK_SIZE + N, fv = cv / BLOCK_SIZE + N;
    const i = Math.floor(fu), j = Math.floor(fv), tu = fu - i, tv = fv - j;
    let l = atCorner(i, j) * (1 - tu) * (1 - tv);
    if (tu > 0) l += atCorner(i + 1, j) * tu * (1 - tv);
    if (tv > 0) l += atCorner(i, j + 1) * (1 - tu) * tv;
    if (tu > 0 && tv > 0) l += atCorner(i + 1, j + 1) * tu * tv;
    return Math.round((l / SKY_LIGHT) * 255);
  };
  return [at(u, v), at(u + du, v), at(u + du, v + dv), at(u, v + dv)];
}
