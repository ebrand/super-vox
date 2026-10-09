import { BLOCK_SIZE, UNITS_PER_METER, type ClimateGrid } from '@super-vox/shared';
import { materialColor, materialName } from './materials.js';
import { climateTintColors } from './tintColors.js';
import { TILE, detailTiles, fitView, niceLength, pan, screenToWorld, zoomAt, type MapView, type MapWorld } from './mapView.js';
import { DEFAULT_EXAGGERATION, WorldRelief } from './worldRelief.js';

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

/** A map tile: a closer look at part of the map (see the server's /api/world/map/area), drawn over the whole map. */
interface Tile {
  /** Where it starts (units; x within a wrapping world). */
  x0: number;
  z0: number;
  map: MapData;
  image: HTMLCanvasElement;
}

/** Tiles kept (least recently drawn dropped first), and fetched at once. */
const MAX_TILES = 150;
const MAX_FETCHES = 4;

/**
 * Full-screen world map overlay: the colour map, a grid, a scale bar, the player (with facing)
 * and spawn. The wheel zooms (about the cursor), dragging pans (round worlds wrap east-west), 0
 * shows the whole world again; zoomed in, sharper pictures of what's in view are fetched. Hovering
 * shows the position, height and surface under the cursor; ⌘-clicking (Ctrl-clicking; without
 * dragging) asks to teleport there, where travel is allowed (see canTravel).
 */
export class WorldMapOverlay {
  private readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly base: HTMLCanvasElement = document.createElement('canvas');
  private readonly info: HTMLDivElement;
  private map: MapData | null = null;
  private climate: ClimateGrid | null = null;
  private loading: Promise<void> | null = null;
  private view: MapView | null = null;
  /** Tiles by step, x0, z0 (oldest first). */
  private readonly tiles = new Map<string, Tile>();
  /** Tiles still to fetch for the current view (nearest the middle first), and how many are on their way. */
  private wanted: { key: string; x0: number; z0: number; step: number }[] = [];
  private readonly fetching = new Set<string>();
  private detailTimer: ReturnType<typeof setTimeout> | null = null;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private readonly world: MapWorld;
  private readonly frameEl: HTMLDivElement;
  private readonly modeButton: HTMLButtonElement;
  private readonly heightControl: HTMLLabelElement;
  private readonly miniatureControl: HTMLLabelElement;
  /** The 3D view (made the first time it's asked for), whether it's showing, and its frame loop. */
  private relief: WorldRelief | null = null;
  private in3d = false;
  private loop = 0;
  isOpen = false;
  /** Whether ⌘-clicking goes there (not in survival, where you walk). */
  canTravel = true;
  /**
   * More drawn over the map (each frame it's drawn): `g` in device pixels, `toX`/`toZ` world units
   * to them (`near`: a world x at its copy nearest the view's middle), `dpr` the pixel ratio.
   */
  drawMore: ((g: CanvasRenderingContext2D, toX: (x: number) => number, toZ: (z: number) => number, near: (x: number) => number, dpr: number) => void) | null = null;
  /** A plain click on the map (not a drag, not ⌘): where (world units); true if it was taken (nothing else done). */
  clicked: ((at: { x: number; z: number }, e: MouseEvent) => boolean) | null = null;
  /** Where more controls go (the bar over the map). */
  get bar(): HTMLDivElement {
    return this.root.querySelector('div.bar')!;
  }
  /** The map's own element (for panels over it). */
  get element(): HTMLDivElement {
    return this.root;
  }

  constructor(
    worldSize: { width: number; depth: number; wrapX?: boolean },
    private readonly player: () => MapMarker,
    private readonly spawn: MapMarker,
    private readonly teleport: (x: number, z: number, surfaceY: number) => void,
    private readonly url = '/api/world/map?width=1024',
    /** Where to fetch a closer look (see /api/world/map/area). */
    private readonly areaUrl: (a: { x0: number; z0: number; step: number; cols: number; rows: number }) => string = (a) =>
      `/api/world/map/area?x0=${a.x0}&z0=${a.z0}&step=${a.step}&cols=${a.cols}&rows=${a.rows}`,
  ) {
    this.world = { width: worldSize.width, depth: worldSize.depth, wrapX: !!worldSize.wrapX };
    this.root = document.createElement('div');
    this.root.id = 'worldmap';
    this.root.innerHTML =
      '<div class="bar"><button type="button" class="mode">3D view</button>' +
      `<label class="height" hidden>height × <input type="range" min="1" max="12" step="0.5" value="${DEFAULT_EXAGGERATION}"><span>${DEFAULT_EXAGGERATION}</span></label>` +
      '<label class="miniature" hidden><input type="checkbox" checked> miniature</label>' +
      // TEMPORARY (cave map): see drawCaves.
      '<label class="caves" hidden><input type="checkbox" checked> caves</label></div>' +
      '<div class="frame"><canvas class="marks"></canvas></div><div class="info">loading map…</div>';
    document.body.appendChild(this.root);
    this.canvas = this.root.querySelector('canvas.marks')!;
    this.info = this.root.querySelector('div.info')!;
    // The world's own proportions (a round world is twice as wide as it is deep).
    const frame = (this.frameEl = this.root.querySelector('div.frame') as HTMLDivElement), ratio = worldSize.width / worldSize.depth;
    frame.style.aspectRatio = `${worldSize.width} / ${worldSize.depth}`;
    frame.style.width = `min(92vw, ${88 * ratio}vh)`;
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const px = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1);
      this.setView(zoomAt(this.currentView(), this.world, r.width, r.height, e.clientX - r.left, e.clientY - r.top, Math.exp(-px * 0.002)));
    }, { passive: false });
    c.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.drag = { x: e.clientX, y: e.clientY, moved: false };
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (!this.drag.moved && Math.hypot(dx, dy) < 4) return; // still a click
      this.drag = { x: e.clientX, y: e.clientY, moved: true };
      const r = c.getBoundingClientRect();
      this.setView(pan(this.currentView(), this.world, r.width, r.height, dx, dy));
    });
    window.addEventListener('mouseup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (d && !d.moved && e.button === 0 && this.isOpen && !travelClick(e) && this.clicked && !this.in3d) {
        const at = this.at(e) ?? this.pointAt(e);
        if (at && this.clicked({ x: at.x, z: at.z }, e)) return this.update();
      }
      if (!d || d.moved || e.button !== 0 || !this.isOpen || !this.canTravel || !travelClick(e)) return;
      const p = this.at(e);
      if (p) {
        this.teleport(p.x, p.z, p.height);
        this.close();
      }
    });
    c.addEventListener('mousemove', (e) => {
      if (!this.drag?.moved) this.showInfo(this.at(e));
    });
    c.addEventListener('mouseleave', () => this.showInfo(null));
    // (Ctrl-click is a right-click on Macs: no menu.)
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen || e.code !== 'Digit0') return;
      if (this.in3d) this.relief?.reset();
      else this.setView(null);
    });
    this.modeButton = this.root.querySelector('button.mode')!;
    this.heightControl = this.root.querySelector('label.height')!;
    this.modeButton.addEventListener('click', () => this.set3d(!this.in3d));
    const slider = this.heightControl.querySelector('input')!, shown = this.heightControl.querySelector('span')!;
    slider.addEventListener('input', () => {
      shown.textContent = slider.value;
      this.relief?.setExaggeration(Number(slider.value));
    });
    this.miniatureControl = this.root.querySelector('label.miniature')!;
    const mini = this.miniatureControl.querySelector('input')!;
    mini.addEventListener('change', () => {
      if (this.relief) this.relief.miniature = mini.checked;
    });
    this.cavesControl = this.root.querySelector('label.caves')!;
    const cavesBox = this.cavesControl.querySelector('input')!;
    cavesBox.addEventListener('change', () => this.update());
    // Keys typed on the controls stay with them (not the game).
    for (const el of [slider, mini, cavesBox, this.modeButton]) el.addEventListener('keydown', (e) => e.stopPropagation());
  }

  /**
   * TEMPORARY (cave map): the world's caving regions (where caves may be under the ground) shaded,
   * and its cave entrances ringed (see /api/world/caves). Fetched once, with the map.
   */
  private caves: { cell: number; image: HTMLCanvasElement; entrances: [number, number][] } | null = null;
  private readonly cavesControl: HTMLLabelElement;

  private async loadCaves(): Promise<void> {
    const res = await fetch(this.url.replace(/^\/api\/world\/map\?width=\d+/, '/api/world/caves?'));
    if (!res.ok) return;
    const { caves } = (await res.json()) as { caves: { cell: number; cols: number; rows: number; regions: string; entrances: [number, number][] } | null };
    if (!caves) return;
    const bits = Uint8Array.from(atob(caves.regions), (ch) => ch.charCodeAt(0));
    const image = document.createElement('canvas');
    image.width = caves.cols;
    image.height = caves.rows;
    const g = image.getContext('2d')!, px = g.createImageData(caves.cols, caves.rows);
    for (let i = 0; i < caves.cols * caves.rows; i++) {
      if (!(bits[i >> 3]! & (1 << (i & 7)))) continue;
      px.data.set([170, 90, 255, 90], i * 4);
    }
    g.putImageData(px, 0, 0);
    this.caves = { cell: caves.cell * BLOCK_SIZE, image, entrances: caves.entrances };
    this.cavesControl.hidden = false;
    this.info.textContent += ` · caves: ${caves.entrances.length} entrances (rings), caving regions purple`;
    this.update();
  }

  /** Draws the caves (see loadCaves) over the map: `a`, `tx`, `ty` world units to device pixels; `copies`: x offsets of the world in view. */
  private drawCaves(g: CanvasRenderingContext2D, a: number, tx: number, ty: number, copies: number[], left: number, right: number, top: number, bottom: number): void {
    const caves = this.caves;
    if (!caves || !this.cavesControl.querySelector('input')!.checked) return;
    const dpr = window.devicePixelRatio || 1;
    for (const off of copies) {
      g.setTransform(a, 0, 0, a, tx + a * off, ty);
      g.drawImage(caves.image, 0, 0, caves.image.width * caves.cell, caves.image.height * caves.cell);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.strokeStyle = '#ffd34d';
    g.fillStyle = '#ffd34d';
    g.lineWidth = 1.5 * dpr;
    const r = Math.max(2.5, Math.min(7, a * 24 * BLOCK_SIZE / dpr)) * dpr;
    for (const off of copies)
      for (const [bx, bz] of caves.entrances) {
        const x = bx * BLOCK_SIZE + off, z = bz * BLOCK_SIZE;
        if (x < left || x > right || z < top || z > bottom) continue;
        const sx = tx + a * x, sz = ty + a * z;
        g.beginPath(); g.arc(sx, sz, r, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.arc(sx, sz, 1.2 * dpr, 0, Math.PI * 2); g.fill();
      }
  }

  /** Whether the 3D view is showing (the game needn't draw itself behind it meanwhile). */
  get showing3d(): boolean {
    return this.isOpen && this.in3d;
  }

  /** Switches between the flat map and the 3D view. */
  private set3d(on: boolean): void {
    if (on && !this.map) {
      this.info.textContent = 'the map is still loading';
      return;
    }
    this.in3d = on;
    this.modeButton.textContent = on ? 'Flat map' : '3D view';
    this.heightControl.hidden = this.miniatureControl.hidden = !on;
    this.canvas.hidden = on;
    this.frameEl.classList.toggle('in3d', on);
    if (on && !this.relief) {
      const relief = (this.relief = new WorldRelief(this.map!, this.world, this.player, this.spawn));
      relief.miniature = this.miniatureControl.querySelector('input')!.checked;
      relief.setExaggeration(Number(this.heightControl.querySelector('input')!.value));
      this.frameEl.append(relief.canvas);
      this.wire3d(relief);
    }
    if (this.relief) this.relief.canvas.hidden = !on;
    this.info.textContent = this.hint(on);
    this.run3d();
  }

  /** Draws the 3D view each frame while it's showing. */
  private run3d(): void {
    cancelAnimationFrame(this.loop);
    if (!this.showing3d || !this.relief) return;
    const tick = () => {
      if (!this.showing3d || !this.relief) return;
      this.relief.render();
      this.loop = requestAnimationFrame(tick);
    };
    this.loop = requestAnimationFrame(tick);
  }

  /** Hovering shows what's there; a click (not a drag) goes there. */
  private wire3d(relief: WorldRelief): void {
    const c = relief.canvas;
    let down: { x: number; y: number } | null = null;
    let hover: { x: number; y: number } | null = null;
    c.addEventListener('pointerdown', (e) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY };
    });
    c.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (!d || e.button !== 0 || !this.canTravel || !travelClick(e) || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      const r = c.getBoundingClientRect();
      const p = relief.pick(e.clientX - r.left, e.clientY - r.top);
      if (p) {
        this.teleport(p.x, p.z, p.height);
        this.close();
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const r = c.getBoundingClientRect();
      // At most one look-up a frame.
      if (!hover) requestAnimationFrame(() => {
        if (hover) this.showInfo(relief.pick(hover.x, hover.y), this.hint(true));
        hover = null;
      });
      hover = { x: e.clientX - r.left, y: e.clientY - r.top };
    });
    c.addEventListener('pointerleave', () => this.showInfo(null, this.hint(true)));
    c.addEventListener('contextmenu', (e) => e.preventDefault());
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
    this.run3d();
  }

  close(): void {
    this.isOpen = false;
    this.drag = null;
    this.root.classList.remove('open');
    cancelAnimationFrame(this.loop);
  }

  /** The frame's size in CSS pixels. */
  private frameSize(): { w: number; h: number } {
    const r = this.canvas.getBoundingClientRect();
    return { w: r.width || 1, h: r.height || 1 };
  }

  private currentView(): MapView {
    const { w, h } = this.frameSize();
    return this.view ?? fitView(this.world, w, h);
  }

  /** Moves the view (null: the whole world), and asks for a sharper picture once it settles. */
  private setView(v: MapView | null): void {
    this.view = v;
    if (this.detailTimer) clearTimeout(this.detailTimer);
    this.detailTimer = setTimeout(() => this.planTiles(), 150);
    this.update();
  }

  /** Redraws the map and markers; call each frame while open. */
  update(): void {
    if (!this.isOpen || !this.map || this.in3d) return;
    const c = this.canvas;
    const { w, h } = this.frameSize();
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const v = this.currentView();
    const g = c.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#05070a';
    g.fillRect(0, 0, c.width, c.height);
    // World units to device pixels; on a wrapping world, every copy of it in view.
    const a = dpr * v.scale, tx = dpr * (w / 2 - v.cx * v.scale), ty = dpr * (h / 2 - v.cz * v.scale);
    const left = v.cx - w / 2 / v.scale, right = v.cx + w / 2 / v.scale;
    const W = this.world.width;
    const copies = this.world.wrapX ? range(Math.floor(left / W), Math.floor(right / W)).map((k) => k * W) : [0];
    g.imageSmoothingEnabled = false;
    // Tiles in view, coarsest first so the sharpest show.
    const top0 = v.cz - h / 2 / v.scale, bottom0 = v.cz + h / 2 / v.scale;
    const inView = [...this.tiles.values()].sort((p, q) => q.map.step - p.map.step);
    for (const off of copies) {
      g.setTransform(a, 0, 0, a, tx + a * off, ty);
      g.drawImage(this.base, 0, 0, this.map.cols * this.map.step, this.map.rows * this.map.step);
      for (const t of inView) {
        const size = t.map.cols * t.map.step;
        if (t.x0 + off >= right || t.x0 + off + size <= left || t.z0 >= bottom0 || t.z0 + size <= top0) continue;
        g.drawImage(t.image, t.x0, t.z0, size, t.map.rows * t.map.step);
      }
    }
    this.drawCaves(g, a, tx, ty, copies, left, right, top0, bottom0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    const toX = (x: number) => tx + a * x, toZ = (z: number) => ty + a * z;
    // Grid: lines about 120 px apart, at round distances.
    const spacing = niceLength(120 / v.scale);
    g.strokeStyle = 'rgba(255,255,255,0.15)';
    g.lineWidth = 1;
    for (let x = Math.ceil(left / spacing) * spacing; x < right; x += spacing) {
      g.beginPath(); g.moveTo(toX(x), 0); g.lineTo(toX(x), c.height); g.stroke();
    }
    const top = v.cz - h / 2 / v.scale, bottom = v.cz + h / 2 / v.scale;
    for (let z = Math.max(spacing, Math.ceil(top / spacing) * spacing); z < Math.min(bottom, this.world.depth); z += spacing) {
      g.beginPath(); g.moveTo(0, toZ(z)); g.lineTo(c.width, toZ(z)); g.stroke();
    }
    // Scale bar: the grid spacing.
    const meters = spacing / UNITS_PER_METER;
    g.fillStyle = 'white';
    g.fillRect(12 * dpr, c.height - 16 * dpr, spacing * a, 3 * dpr);
    g.font = `${11 * dpr}px ui-monospace, monospace`;
    g.fillText(meters >= 1000 ? `${meters / 1000} km` : `${meters} m`, 12 * dpr, c.height - 22 * dpr);
    // Spawn and player, at their copies nearest the middle of the view.
    const near = (x: number) => (this.world.wrapX ? x + Math.round((v.cx - x) / W) * W : x);
    g.strokeStyle = 'white';
    g.lineWidth = 2 * dpr;
    g.beginPath(); g.arc(toX(near(this.spawn.x)), toZ(this.spawn.z), 5 * dpr, 0, Math.PI * 2); g.stroke();
    const p = this.player();
    const yaw = p.yaw ?? 0;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const px = toX(near(p.x)), pz = toZ(p.z), r = 9 * dpr;
    g.fillStyle = '#ff3b30';
    g.beginPath();
    g.moveTo(px + fx * r, pz + fz * r);
    g.lineTo(px - fx * r * 0.6 - fz * r * 0.6, pz - fz * r * 0.6 + fx * r * 0.6);
    g.lineTo(px - fx * r * 0.6 + fz * r * 0.6, pz - fz * r * 0.6 - fx * r * 0.6);
    g.closePath();
    g.fill();
    g.stroke();
    this.drawMore?.(g, toX, toZ, near, dpr);
  }

  /** Where on the world (units) a mouse event is, whether there's map there yet or not. */
  private pointAt(e: MouseEvent): { x: number; z: number } | null {
    const r = this.canvas.getBoundingClientRect();
    const [x, z] = screenToWorld(this.currentView(), r.width, r.height, e.clientX - r.left, e.clientY - r.top);
    const W = this.world.width;
    return z < 0 || z >= this.world.depth ? null : { x: this.world.wrapX ? ((x % W) + W) % W : x, z };
  }

  /** Blends biome colours on the map as in the game (see climateTintColors). */
  setClimate(climate: ClimateGrid): void {
    this.climate = climate;
    if (this.map) this.paint(this.map, this.base);
    this.relief?.recolor();
    for (const t of this.tiles.values()) this.paint(t.map, t.image);
  }

  private paint(map: MapData & { x0?: number; z0?: number }, image: HTMLCanvasElement): void {
    if (this.climate && !map.colors) map.colors = climateTintColors(map, this.climate);
    image.width = map.cols;
    image.height = map.rows;
    image.getContext('2d')!.putImageData(new ImageData(renderMap(map), map.cols, map.rows), 0, 0);
  }

  private async load(): Promise<void> {
    this.loading ??= (async () => {
      const t0 = performance.now();
      const res = await fetch(this.url);
      if (!res.ok) throw new Error(`map request failed: ${res.status}`);
      const map = decodeWorldMap(await res.arrayBuffer());
      this.map = map;
      this.paint(map, this.base);
      this.info.textContent = `map ${map.cols} x ${map.rows} (${(map.step / UNITS_PER_METER).toFixed(1)} m per pixel), ${Math.round(performance.now() - t0)} ms · ${this.hint(false)}`;
      this.update();
      void this.loadCaves().catch(() => {});
    })().catch((err) => {
      this.info.textContent = String(err);
      this.loading = null;
    });
    return this.loading;
  }

  /** Works out the tiles the current view wants (see detailTiles) and starts fetching them. */
  private planTiles(): void {
    if (!this.isOpen || !this.map) return;
    const { w, h } = this.frameSize();
    const d = detailTiles(this.currentView(), this.world, w, h, this.map.step);
    this.wanted = (d?.tiles ?? [])
      .map(({ x0, z0 }) => {
        const nx = this.world.wrapX ? mod(x0, this.world.width) : x0;
        return { key: `${d!.step}:${nx}:${z0}`, x0: nx, z0, step: d!.step };
      })
      .filter((t) => {
        const hit = this.tiles.get(t.key);
        if (hit) {
          // In use again: the newest.
          this.tiles.delete(t.key);
          this.tiles.set(t.key, hit);
        }
        return !hit && !this.fetching.has(t.key);
      });
    this.pumpTiles();
  }

  private pumpTiles(): void {
    while (this.fetching.size < MAX_FETCHES && this.wanted.length > 0) {
      const t = this.wanted.shift()!;
      this.fetching.add(t.key);
      const cols = Math.min(TILE, Math.ceil((this.world.width - (this.world.wrapX ? 0 : t.x0)) / t.step));
      const rows = Math.min(TILE, Math.ceil((this.world.depth - t.z0) / t.step));
      void fetch(this.areaUrl({ x0: t.x0, z0: t.z0, step: t.step, cols: this.world.wrapX ? TILE : cols, rows }))
        .then(async (res) => {
          if (!res.ok) throw new Error(`map request failed: ${res.status}`);
          const map: MapData & { x0: number; z0: number } = { ...decodeWorldMap(await res.arrayBuffer()), x0: t.x0, z0: t.z0 };
          const image = document.createElement('canvas');
          this.paint(map, image);
          this.tiles.set(t.key, { x0: t.x0, z0: t.z0, map, image });
          while (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value!);
          this.update();
        })
        .catch((err: unknown) => {
          this.info.textContent = String(err);
        })
        .finally(() => {
          this.fetching.delete(t.key);
          this.pumpTiles();
        });
    }
  }

  /** World position, height, and material under the mouse (from the sharpest picture there), or null outside the world. */
  private at(e: MouseEvent): { x: number; z: number; height: number; material: number } | null {
    const m = this.map;
    if (!m) return null;
    const r = this.canvas.getBoundingClientRect();
    let [x, z] = screenToWorld(this.currentView(), r.width, r.height, e.clientX - r.left, e.clientY - r.top);
    if (this.world.wrapX) x = mod(x, this.world.width);
    if (x < 0 || x >= this.world.width || z < 0 || z >= this.world.depth) return null;
    for (const p of [...this.tiles.values()].sort((a, b) => a.map.step - b.map.step)) {
      const i = Math.floor((x - p.x0) / p.map.step), j = Math.floor((z - p.z0) / p.map.step);
      if (i < 0 || j < 0 || i >= p.map.cols || j >= p.map.rows) continue;
      const k = i + p.map.cols * j;
      return { x: p.x0 + (i + 0.5) * p.map.step, z: p.z0 + (j + 0.5) * p.map.step, height: p.map.heights[k]!, material: p.map.materials[k]! };
    }
    const i = Math.min(m.cols - 1, Math.floor(x / m.step)), j = Math.min(m.rows - 1, Math.floor(z / m.step));
    const k = i + m.cols * j;
    return { x: (i + 0.5) * m.step, z: (j + 0.5) * m.step, height: m.heights[k]!, material: m.materials[k]! };
  }

  /** The help line (for the 3D view or the flat one). */
  private hint(in3d: boolean): string {
    const h = in3d ? HINT_3D : HINT;
    return this.canTravel ? h : h.replace(', ⌘-click to go there', '');
  }

  private showInfo(p: { x: number; z: number; height: number; material: number } | null, hint = this.hint(false)): void {
    if (!this.map) return;
    if (!p) {
      this.info.textContent = hint;
      return;
    }
    const m = (u: number) => (u / UNITS_PER_METER).toFixed(0);
    const sea = this.map.seaLevel;
    const under = sea !== null && p.height < sea ? ` · ${m(sea - p.height)} m under the sea` : '';
    this.info.textContent = `x ${m(p.x)} m, z ${m(p.z)} m · ground ${m(p.height)} m · ${materialName(p.material)}${under}${this.canTravel ? ' · ⌘-click to go there' : ''}`;
  }
}

const HINT = 'wheel: zoom · drag: move · 0: whole world · hover for details, ⌘-click to go there · M or Esc to close';
const HINT_3D = 'wheel: zoom · drag: move · right-drag: turn and tilt · 0: start again · hover for details, ⌘-click to go there · M or Esc to close';

/** Only a ⌘-click (Ctrl-click elsewhere) goes somewhere: plain clicks and drags just look around. */
export function travelClick(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.metaKey || e.ctrlKey;
}

const mod = (v: number, m: number) => ((v % m) + m) % m;

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
