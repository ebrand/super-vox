import { UNITS_PER_METER, type ClimateGrid } from '@super-vox/shared';
import { materialColor, materialName } from './materials.js';
import { climateTintColors } from './tintColors.js';

/** Top-down surface samples for the whole world (see the server's /api/world/map). */
export interface MapData {
  cols: number;
  rows: number;
  /** Units between samples; sample (i, j) is at ((i + 0.5) * step, (j + 0.5) * step). */
  step: number;
  seaLevel: number | null;
  heights: Int16Array;
  materials: Uint8Array;
  /** Optional colour per sample (linear RGB triples) overriding its material's; NaN: the material's. */
  colors?: Float32Array;
}

export function decodeWorldMap(buf: ArrayBuffer): MapData {
  const v = new DataView(buf);
  const cols = v.getUint16(0, true), rows = v.getUint16(2, true), step = v.getUint32(4, true);
  const sea = v.getInt32(8, true);
  const n = cols * rows;
  if (buf.byteLength !== 12 + n * 3) throw new Error(`map is ${buf.byteLength} bytes, expected ${12 + n * 3}`);
  const heights = new Int16Array(n);
  for (let i = 0; i < n; i++) heights[i] = v.getInt16(12 + i * 2, true);
  return { cols, rows, step, seaLevel: sea === -(2 ** 31) ? null : sea, heights, materials: new Uint8Array(buf, 12 + n * 2, n).slice() };
}

// These mirror what the game draws: voxelMaterial.ts's sun and lighting, three.js's
// linear -> sRGB output, and main.ts's sea plane (colour and opacity).
const SUN = (() => {
  const l = Math.hypot(0.4, 0.8, 0.3);
  return [0.4 / l, 0.8 / l, 0.3 / l] as const;
})();
const SEA_RGB = [0x2f / 255, 0x6d / 255, 0x9c / 255] as const;
const SEA_OPACITY = 0.6;

/** Linear to sRGB with the constants three.js's output shader uses on the GPU. */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** 0.41666 - 0.055;
}

/**
 * sRGB colour (0..1) of a surface seen from above: the material's colour lit
 * like the game lights a face with the given surface normal, with the sea
 * plane blended over it when it's under water.
 */
export function mapColor(material: number, normal: readonly [number, number, number], underwater: boolean, color: readonly [number, number, number] = materialColor(material)): [number, number, number] {
  const light = 0.55 + 0.45 * Math.max(0, normal[0] * SUN[0] + normal[1] * SUN[1] + normal[2] * SUN[2]);
  const base = color.map((c) => linearToSrgb(Math.min(1, c * light))) as [number, number, number];
  if (!underwater) return base;
  return base.map((c, k) => SEA_OPACITY * SEA_RGB[k]! + (1 - SEA_OPACITY) * c) as [number, number, number];
}

/** RGBA pixels for the whole map, row-major, one pixel per sample. */
export function renderMap(map: MapData): Uint8ClampedArray<ArrayBuffer> {
  const { cols, rows, step, heights, materials, seaLevel, colors } = map;
  const px = new Uint8ClampedArray(cols * rows * 4);
  const h = (i: number, j: number) => heights[Math.max(0, Math.min(cols - 1, i)) + cols * Math.max(0, Math.min(rows - 1, j))]!;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      // Surface normal from neighbouring heights (all in units).
      const dx = (h(i + 1, j) - h(i - 1, j)) / (2 * step);
      const dz = (h(i, j + 1) - h(i, j - 1)) / (2 * step);
      const len = Math.hypot(dx, 1, dz);
      const k = i + cols * j;
      const own = colors && !Number.isNaN(colors[k * 3]!) ? ([colors[k * 3]!, colors[k * 3 + 1]!, colors[k * 3 + 2]!] as const) : undefined;
      const c = mapColor(materials[k]!, [-dx / len, 1 / len, -dz / len], seaLevel !== null && heights[k]! < seaLevel, own);
      px.set([c[0] * 255, c[1] * 255, c[2] * 255, 255], k * 4);
    }
  }
  return px;
}

export interface MapMarker {
  /** World units. */
  x: number;
  z: number;
  /** Radians; 0 faces -Z (north on the map), as FlyControls' yaw. */
  yaw?: number;
}

/**
 * Full-screen world map overlay: the colour map, a 1 km grid, a scale bar,
 * the player (with facing) and spawn. Hovering shows the position, height and
 * surface under the cursor; clicking asks to teleport there.
 */
export class WorldMapOverlay {
  private readonly root: HTMLDivElement;
  private readonly image: HTMLCanvasElement;
  private readonly marks: HTMLCanvasElement;
  private readonly info: HTMLDivElement;
  private map: MapData | null = null;
  private climate: ClimateGrid | null = null;
  private loading: Promise<void> | null = null;
  isOpen = false;

  constructor(
    private readonly worldSize: { width: number; depth: number },
    private readonly player: () => MapMarker,
    private readonly spawn: MapMarker,
    private readonly teleport: (x: number, z: number, surfaceY: number) => void,
    private readonly url = '/api/world/map?width=1024',
  ) {
    this.root = document.createElement('div');
    this.root.id = 'worldmap';
    this.root.innerHTML = '<div class="frame"><canvas class="image"></canvas><canvas class="marks"></canvas></div><div class="info">loading map…</div>';
    document.body.appendChild(this.root);
    this.image = this.root.querySelector('canvas.image')!;
    this.marks = this.root.querySelector('canvas.marks')!;
    this.info = this.root.querySelector('div.info')!;
    this.marks.addEventListener('mousemove', (e) => this.hover(e));
    this.marks.addEventListener('mouseleave', () => this.showInfo(null));
    this.marks.addEventListener('click', (e) => {
      const p = this.at(e);
      if (p) {
        this.teleport(p.x, p.z, p.height);
        this.close();
      }
    });
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.show();
  }

  show(): void {
    this.isOpen = true;
    this.root.classList.add('open');
    if (!this.map) void this.load();
    this.update();
  }

  close(): void {
    this.isOpen = false;
    this.root.classList.remove('open');
  }

  /** Redraws markers; call each frame while open. */
  update(): void {
    if (!this.isOpen || !this.map) return;
    const c = this.marks;
    const rect = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(rect.width * dpr)) {
      c.width = Math.round(rect.width * dpr);
      c.height = Math.round(rect.height * dpr);
    }
    const g = c.getContext('2d')!;
    const sx = c.width / this.worldSize.width, sz = c.height / this.worldSize.depth;
    g.clearRect(0, 0, c.width, c.height);
    // 1 km grid.
    g.strokeStyle = 'rgba(255,255,255,0.15)';
    g.lineWidth = 1;
    const km = 1000 * UNITS_PER_METER;
    for (let x = km; x < this.worldSize.width; x += km) { g.beginPath(); g.moveTo(x * sx, 0); g.lineTo(x * sx, c.height); g.stroke(); }
    for (let z = km; z < this.worldSize.depth; z += km) { g.beginPath(); g.moveTo(0, z * sz); g.lineTo(c.width, z * sz); g.stroke(); }
    // Scale bar: 1 km.
    g.fillStyle = 'white';
    g.fillRect(12 * dpr, c.height - 16 * dpr, km * sx, 3 * dpr);
    g.font = `${11 * dpr}px ui-monospace, monospace`;
    g.fillText('1 km', 12 * dpr, c.height - 22 * dpr);
    // Spawn and player.
    g.strokeStyle = 'white';
    g.lineWidth = 2 * dpr;
    g.beginPath(); g.arc(this.spawn.x * sx, this.spawn.z * sz, 5 * dpr, 0, Math.PI * 2); g.stroke();
    const p = this.player();
    const yaw = p.yaw ?? 0;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const px = p.x * sx, pz = p.z * sz, r = 9 * dpr;
    g.fillStyle = '#ff3b30';
    g.beginPath();
    g.moveTo(px + fx * r, pz + fz * r);
    g.lineTo(px - fx * r * 0.6 - fz * r * 0.6, pz - fz * r * 0.6 + fx * r * 0.6);
    g.lineTo(px - fx * r * 0.6 + fz * r * 0.6, pz - fz * r * 0.6 - fx * r * 0.6);
    g.closePath();
    g.fill();
    g.stroke();
  }

  /** Blends biome colours on the map as in the game (see climateTintColors). */
  setClimate(climate: ClimateGrid): void {
    this.climate = climate;
    if (this.map) this.paint();
  }

  private paint(): void {
    const map = this.map!;
    if (this.climate && !map.colors) map.colors = climateTintColors(map, this.climate);
    this.image.width = map.cols;
    this.image.height = map.rows;
    this.image.getContext('2d')!.putImageData(new ImageData(renderMap(map), map.cols, map.rows), 0, 0);
  }

  private async load(): Promise<void> {
    this.loading ??= (async () => {
      const t0 = performance.now();
      const res = await fetch(this.url);
      if (!res.ok) throw new Error(`map request failed: ${res.status}`);
      const map = decodeWorldMap(await res.arrayBuffer());
      this.map = map;
      this.paint();
      this.info.textContent = `map ${map.cols} x ${map.rows} (${(map.step / UNITS_PER_METER).toFixed(1)} m per pixel), ${Math.round(performance.now() - t0)} ms · hover for details, click to go there · M or Esc to close`;
      this.update();
    })().catch((err) => {
      this.info.textContent = String(err);
      this.loading = null;
    });
    return this.loading;
  }

  /** World position, height, and material under the mouse, or null outside the map. */
  private at(e: MouseEvent): { x: number; z: number; height: number; material: number } | null {
    const m = this.map;
    if (!m) return null;
    const rect = this.marks.getBoundingClientRect();
    const u = (e.clientX - rect.left) / rect.width, v = (e.clientY - rect.top) / rect.height;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
    const i = Math.min(m.cols - 1, Math.floor(u * m.cols)), j = Math.min(m.rows - 1, Math.floor(v * m.rows));
    const k = i + m.cols * j;
    return { x: (i + 0.5) * m.step, z: (j + 0.5) * m.step, height: m.heights[k]!, material: m.materials[k]! };
  }

  private hover(e: MouseEvent): void {
    this.showInfo(this.at(e));
  }

  private showInfo(p: { x: number; z: number; height: number; material: number } | null): void {
    if (!this.map) return;
    if (!p) {
      this.info.textContent = 'hover for details, click to go there · M or Esc to close';
      return;
    }
    const m = (u: number) => (u / UNITS_PER_METER).toFixed(0);
    const sea = this.map.seaLevel;
    const under = sea !== null && p.height < sea ? ` · ${m(sea - p.height)} m under the sea` : '';
    this.info.textContent = `x ${m(p.x)} m, z ${m(p.z)} m · ground ${m(p.height)} m · ${materialName(p.material)}${under} · click to go there`;
  }
}
