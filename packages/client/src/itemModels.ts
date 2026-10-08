import * as THREE from 'three';
import { designMaterial, designOfItem, isBlock, type ItemId } from '@super-vox/shared';
import { heldSvg, iconSvg } from './icons.js';
import { materialColor } from './materials.js';

/**
 * Models of items as held (in your hand, and in other players'): each from its icon (see icons.ts),
 * as Minecraft does with its textures: the icon's pixels made voxels, a pixel deep, coloured as
 * the icon is (front, back, and the sides where a pixel has no neighbour). Blocks: a cube of the
 * material; designed objects (no icon): a cube of what they're mostly made of. Made once each;
 * an icon's model is ready a moment after it's first asked for (the icon's drawn first).
 */

/** Pixels across an icon's model. */
const PIXELS = 24;

/** The shading of each face of a voxel (lit from above and a little in front). */
const SHADE = { front: 1, back: 0.72, up: 0.95, down: 0.6, side: 0.8 };

const cache = new Map<ItemId, THREE.BufferGeometry | Promise<THREE.BufferGeometry>>();

/**
 * An item's model geometry, centred on its middle, 1 across (scale it to size), facing +z (its
 * icon's front); with vertex colours. A promise while its icon's being read.
 */
export function itemGeometry(item: ItemId): THREE.BufferGeometry | Promise<THREE.BufferGeometry> {
  const have = cache.get(item);
  if (have) return have;
  const made = make(item);
  cache.set(item, made);
  if (made instanceof Promise) void made.then((g) => cache.set(item, g));
  return made;
}

/** Whether an item's model is a cube (a block, or a designed object): held as one, not as a flat thing. */
export function isCubeModel(item: ItemId): boolean {
  return isBlock(item) || !iconSvg(item);
}

function make(item: ItemId): THREE.BufferGeometry | Promise<THREE.BufferGeometry> {
  const svg = heldSvg(item);
  if (isBlock(item) || !svg) {
    const design = isBlock(item) ? undefined : designOfItem(item);
    const c = isBlock(item) ? materialColor(item) : design ? materialColor(designMaterial(design)) : ([0.6, 0.4, 0.3] as const);
    return cube(new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace));
  }
  // (No page to draw the icon on, as in tests: a plain cube.)
  if (typeof Image === 'undefined' || typeof document === 'undefined') return cube(new THREE.Color(0.5, 0.5, 0.5));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = PIXELS;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return resolve(cube(new THREE.Color(0.5, 0.5, 0.5)));
      ctx.drawImage(img, 0, 0, PIXELS, PIXELS);
      resolve(pixelModel(ctx.getImageData(0, 0, PIXELS, PIXELS).data));
    };
    img.onerror = () => resolve(cube(new THREE.Color(0.5, 0.5, 0.5)));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace('width="100%" height="100%"', `width="${PIXELS}" height="${PIXELS}"`))}`;
  });
}

/** A cube, 1 across, shaded per face. */
function cube(color: THREE.Color): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const shades = [SHADE.side, SHADE.side, SHADE.up, SHADE.down, SHADE.front, SHADE.back];
  const col = new Float32Array(g.getAttribute('position').count * 3);
  for (let i = 0; i < col.length / 3; i++) {
    const s = shades[Math.floor(i / 6)]!;
    col.set([color.r * s, color.g * s, color.b * s], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * The icon's pixels (RGBA, PIXELS square, top row first) as voxels: each opaque one a cube a
 * pixel across and deep; faces between two of them left out.
 */
export function pixelModel(rgba: Uint8ClampedArray): THREE.BufferGeometry {
  const n = PIXELS, px = 1 / n, solid = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && rgba[(y * n + x) * 4 + 3]! > 100;
  const pos: number[] = [], col: number[] = [];
  const c = new THREE.Color();
  // A quad (two triangles) from four corners, in order round it.
  const quad = (corners: number[][], shade: number) => {
    for (const i of [0, 1, 2, 0, 2, 3]) pos.push(...corners[i]!);
    for (let k = 0; k < 6; k++) col.push(c.r * shade, c.g * shade, c.b * shade);
  };
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (!solid(x, y)) continue;
      const i = (y * n + x) * 4;
      c.setRGB(rgba[i]! / 255, rgba[i + 1]! / 255, rgba[i + 2]! / 255, THREE.SRGBColorSpace);
      // (Up is up: the image's rows go down.)
      const x0 = x * px - 0.5, x1 = x0 + px, y1 = 0.5 - y * px, y0 = y1 - px, z0 = -px / 2, z1 = px / 2;
      quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], SHADE.front);
      quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], SHADE.back);
      if (!solid(x, y - 1)) quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], SHADE.up);
      if (!solid(x, y + 1)) quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], SHADE.down);
      if (!solid(x - 1, y)) quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], SHADE.side);
      if (!solid(x + 1, y)) quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], SHADE.side);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
