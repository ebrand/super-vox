import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { UNITS_PER_METER, decodeClimate } from '@super-vox/shared';
import { createAtmosphere, type Atmosphere } from './atmosphere.js';
import { DEFAULT_DIORAMA_LIGHT, dioramaLighting, type DioramaLight } from './dioramaLight.js';
import { createPackedMesh, disposePackedMesh, meshQuads } from './meshFactory.js';
import { MiniatureEffect } from './miniature.js';
import { createTint } from './tint.js';
import { Birds } from './birds.js';
import { createVoxelMaterial } from './voxelMaterial.js';
import { WATER_LAYER, WaterRenderer, createVoxelWaterMaterial } from './water.js';
import { SECTION_M, type DioramaPart } from './terraformArea.js';

/**
 * An area of a world up close, cut out like a diorama (see meshDioramaSection), drawn as the game
 * draws its terrain (its voxel look, water and biome colours). Orbit, zoom and pan around it.
 * Scene units are metres, at the area's true place in the world (the biome colours are looked up
 * by position). Controls as the 3D map's.
 */
const WHITE = new THREE.Color(0xffffff);
/** Trees' opacity when drawn see-through (see seeThroughTrees). */
const TREE_ALPHA = 0.75;
/** The brush ring's layer: drawn last, over the water (which is drawn over everything else). */
const OVERLAY_LAYER = 2;

export class Diorama {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: MapControls;
  private readonly material: ReturnType<typeof createVoxelMaterial>;
  private readonly treeMaterial: ReturnType<typeof createVoxelMaterial>;
  /** Whether trees are drawn see-through (see seeThroughTrees). */
  private treesSeeThrough = false;
  private readonly water: WaterRenderer;
  private readonly waterMaterial: THREE.Material;
  private readonly meshes = new THREE.Group();
  /** A finer look at part of it (see showDetail). */
  private readonly detail = new THREE.Group();
  private readonly miniatureFx: MiniatureEffect;
  private readonly atmosphere: Atmosphere;
  /** The miniature effect (the tilt-shift blur): a diorama is always seen close up, so all of it. */
  miniature = true;
  /** The ground as sampled (units), to find what's under the pointer; null before anything's shown. */
  private field: { heights: Int32Array; n: number; step: number; x0: number; z0: number } | null = null;
  /** The brush: a ring on the ground under the pointer (its radius in metres), or none. */
  private readonly brushRing: Line2;
  /** Under the ring: a wider dark line, so its dashes stand out on any ground. */
  private readonly brushShade: Line2;
  /** Where players have built (see setProtected): squares outlined on the ground. */
  private readonly protectedLines: LineSegments2;
  private protectedSquares: readonly { x0: number; z0: number; size: number }[] = [];
  private brushRadius: number | null = null;
  private brushAt: { x: number; z: number } | null = null;
  /**
   * Painting: a ⌘-press (Ctrl-press) and drag; with `paintsAlt`, a ⌘-right-drag too (`alt`). The
   * diorama doesn't move while painting; it calls this with each point (metres, and the ground's
   * height there) as it goes.
   */
  onPaint: ((phase: 'start' | 'move' | 'end', at: { x: number; y: number; z: number } | null, alt: boolean) => void) | null = null;
  /** Whether a ⌘-right-drag paints (the brush's other way: see onPaint) rather than turning the view. */
  paintsAlt = false;
  /** Measuring: a left-drag draws a line between two points of the ground, its length shown (see measure). */
  private measuringOn = false;
  /** The measurement shown (metres), if any. */
  private measured: { a: { x: number; y: number; z: number }; b: { x: number; y: number; z: number } } | null = null;
  private readonly measureLine: Line2;
  private readonly measureShade: Line2;
  private readonly measureLabel: HTMLDivElement;
  /** Flocks of birds crossing the view now and then (see Birds). */
  private readonly birds: Birds;
  /** The area's size (metres), for the birds. */
  private areaSize = 512;
  private lastFrame = performance.now();

  constructor(climate: Uint8Array | null, wrapX: boolean, seaLevel: number | null) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'diorama';
    // (Barely any haze: the whole diorama is close.)
    const atmosphere = (this.atmosphere = createAtmosphere(60_000, seaLevel === null ? 0 : seaLevel / UNITS_PER_METER));
    this.setLight(DEFAULT_DIORAMA_LIGHT);
    this.material = createVoxelMaterial(atmosphere);
    // The trees' see-through pass (see seeThroughTrees): drawn after everything solid, blended.
    this.treeMaterial = createVoxelMaterial(atmosphere);
    Object.assign(this.treeMaterial, { transparent: true, depthWrite: true });
    this.treeMaterial.uniforms.treePass!.value = 2;
    this.treeMaterial.uniforms.treeAlpha!.value = TREE_ALPHA;
    if (climate) for (const m of [this.material, this.treeMaterial]) m.setTint(createTint(decodeClimate(climate), wrapX));
    this.water = new WaterRenderer(this.renderer, atmosphere);
    this.waterMaterial = createVoxelWaterMaterial(this.water.uniforms);
    this.scene.background = new THREE.Color(0x0b0d10);
    this.scene.add(this.meshes, this.detail);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 40_000);
    this.camera.layers.enable(WATER_LAYER);
    // As the 3D map: drag to move over the ground, right-drag to turn and tilt, wheel to zoom.
    this.controls = new MapControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = false;
    // The middle button moves too.
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 12_000;
    // (Lines a few pixels wide: WebGL's own are one pixel, too faint to see on busy ground.)
    this.brushRing = new Line2(new LineGeometry(), new LineMaterial({ color: 0xffd34d, linewidth: 3, dashed: true, depthTest: false, transparent: true }));
    this.brushShade = new Line2(this.brushRing.geometry, new LineMaterial({ color: 0x000000, linewidth: 5, depthTest: false, transparent: true, opacity: 0.6 }));
    this.protectedLines = new LineSegments2(new LineSegmentsGeometry(), new LineMaterial({ color: 0xff5a4f, linewidth: 2, depthTest: false, transparent: true }));
    this.protectedLines.layers.set(OVERLAY_LAYER);
    this.protectedLines.renderOrder = 9;
    this.protectedLines.frustumCulled = false;
    this.protectedLines.visible = false;
    this.scene.add(this.protectedLines);
    // (Both transparent, so they're drawn in this order: the ring over its shade.)
    for (const [line, order] of [[this.brushShade, 10], [this.brushRing, 11]] as const) {
      line.layers.set(OVERLAY_LAYER);
      line.renderOrder = order;
      line.frustumCulled = false;
      line.visible = false;
      this.scene.add(line);
    }
    // The measuring line: yellow over a dark shade, over everything; its length in a label at its middle.
    this.measureLine = new Line2(new LineGeometry(), new LineMaterial({ color: 0xffd34d, linewidth: 3, depthTest: false, transparent: true }));
    this.measureShade = new Line2(this.measureLine.geometry, new LineMaterial({ color: 0x000000, linewidth: 6, depthTest: false, transparent: true, opacity: 0.6 }));
    for (const [line, order] of [[this.measureShade, 12], [this.measureLine, 13]] as const) {
      line.layers.set(OVERLAY_LAYER);
      line.renderOrder = order;
      line.frustumCulled = false;
      line.visible = false;
      this.scene.add(line);
    }
    this.measureLabel = document.createElement('div');
    this.measureLabel.className = 'measure-label';
    this.measureLabel.hidden = true;
    this.birds = new Birds({
      groundAt: (x, z) => this.groundAt(x, z),
      sunDir: () => this.atmosphere.uniforms.sunDir.value.clone(),
      target: () => this.controls.target.clone(),
      distance: () => this.camera.position.distanceTo(this.controls.target),
      areaSize: () => this.areaSize,
    });
    this.scene.add(this.birds.group);
    this.wireInput();
    // The scene (water and all, see WaterRenderer) into the effect's buffer, then the effect.
    const water = this.water, scene = this.scene, camera = this.camera;
    this.miniatureFx = new MiniatureEffect(
      this.renderer,
      new (class extends Pass {
        constructor() {
          super();
          this.needsSwap = false;
        }
        override render(r: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
          water.render(scene, camera, read);
          // The brush ring over it all.
          const layers = camera.layers.mask, autoClear = r.autoClear, background = scene.background;
          camera.layers.set(OVERLAY_LAYER);
          r.autoClear = false;
          scene.background = null;
          r.setRenderTarget(read);
          r.render(scene, camera);
          scene.background = background;
          r.autoClear = autoClear;
          camera.layers.mask = layers;
        }
      })(),
    );
  }

  /** Tints the ground by `climate` (see encodeClimate; null: no tint), as the world's settings have it now. */
  setClimate(climate: Uint8Array | null, wrapX: boolean): void {
    const tint = climate ? createTint(decodeClimate(climate), wrapX) : null;
    for (const m of [this.material, this.treeMaterial]) m.setTint(tint);
  }

  /**
   * Shows a diorama's parts (see terraform.worker.ts): `area` is its corner and size, base and top
   * (units), to frame the view on it.
   */
  show(parts: readonly DioramaPart[], area: { x0: number; z0: number; size: number; base: number; top: number }, keepView = false): void {
    this.clear();
    this.update(parts);
    this.areaSize = area.size / UNITS_PER_METER;
    if (keepView) return;
    // Look at the middle of the area from the south and above, all of it in view.
    const m = UNITS_PER_METER, size = area.size / m;
    const mid = new THREE.Vector3((area.x0 + area.size / 2) / m, (area.base + area.top) / 2 / m, (area.z0 + area.size / 2) / m);
    this.controls.target.copy(mid);
    this.camera.position.set(mid.x, mid.y + size * 0.8, mid.z + size * 1.25);
    this.controls.update();
  }

  /** The ground as sampled (see the worker's area reply), to find what's under the pointer. */
  setField(heights: Int32Array, n: number, step: number, x0: number, z0: number): void {
    this.field = { heights, n, step, x0, z0 };
    // (The ground's in steps of a sample: the water's foam is smoothed over them, see bottomStep.)
    this.water.uniforms.bottomStep.value = step / UNITS_PER_METER;
    this.placeBrush();
    this.placeProtected();
    this.placeOutlines();
  }

  /** Rectangles (metres: corners; e.g. claimed plots) outlined on the ground, each in its colour. */
  setOutlines(rects: readonly { x0: number; z0: number; x1: number; z1: number; color: number }[]): void {
    this.outlineRects = rects;
    this.placeOutlines();
  }

  private outlineRects: readonly { x0: number; z0: number; x1: number; z1: number; color: number }[] = [];
  private readonly outlines = new THREE.Group();

  private placeOutlines(): void {
    for (const l of [...this.outlines.children] as LineSegments2[]) {
      l.geometry.dispose();
      l.material.dispose();
      this.outlines.remove(l);
    }
    if (!this.field) return;
    if (!this.outlines.parent) this.scene.add(this.outlines);
    const y = (x: number, z: number) => (this.groundAt(x, z) ?? 0) + 0.6;
    for (const r of this.outlineRects) {
      const pts: number[] = [];
      const sides: [number, number, number, number][] = [[r.x0, r.z0, r.x1, r.z0], [r.x1, r.z0, r.x1, r.z1], [r.x1, r.z1, r.x0, r.z1], [r.x0, r.z1, r.x0, r.z0]];
      for (const [ax, az, bx, bz] of sides) {
        // In 2 m pieces, draped over the ground.
        const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 2));
        for (let k = 0; k < n; k++) {
          const px = ax + ((bx - ax) * k) / n, pz = az + ((bz - az) * k) / n, qx = ax + ((bx - ax) * (k + 1)) / n, qz = az + ((bz - az) * (k + 1)) / n;
          pts.push(px, y(px, pz), pz, qx, y(qx, qz), qz);
        }
      }
      const line = new LineSegments2(new LineSegmentsGeometry().setPositions(pts), new LineMaterial({ color: r.color, linewidth: 3, depthTest: false, transparent: true }));
      line.layers.set(OVERLAY_LAYER);
      line.renderOrder = 9;
      line.frustumCulled = false;
      this.outlines.add(line);
    }
  }

  /** Squares (metres: corner and size) where players have built, outlined in red on the ground. */
  setProtected(squares: readonly { x0: number; z0: number; size: number }[]): void {
    this.protectedSquares = squares;
    this.placeProtected();
  }

  private placeProtected(): void {
    const sq = this.protectedSquares;
    this.protectedLines.visible = sq.length > 0 && this.field !== null;
    if (!this.protectedLines.visible) return;
    const pts: number[] = [];
    const y = (x: number, z: number) => (this.groundAt(x, z) ?? 0) + 0.5;
    for (const { x0, z0, size } of sq) {
      // Each side in 4 m pieces, draped over the ground.
      const n = Math.max(1, Math.round(size / 4)), d = size / n;
      const sides: [number, number, number, number][] = [[x0, z0, d, 0], [x0 + size, z0, 0, d], [x0 + size, z0 + size, -d, 0], [x0, z0 + size, 0, -d]];
      for (const [sx, sz, dx, dz] of sides) {
        for (let k = 0; k < n; k++) {
          const ax = sx + dx * k, az = sz + dz * k, bx = ax + dx, bz = az + dz;
          pts.push(ax, y(ax, az), az, bx, y(bx, bz), bz);
        }
      }
    }
    this.protectedLines.geometry.dispose();
    this.protectedLines.geometry = new LineSegmentsGeometry().setPositions(pts);
  }

  /** The brush ring's radius (metres) and colour (drawn brighter, dashed); null hides it. */
  setBrush(radius: number | null, color = 0xffd34d): void {
    this.brushRadius = radius;
    this.brushRing.material.color.setHex(color).lerp(WHITE, 0.4);
    this.placeBrush();
  }

  /** The ground's height (metres) at (x, z) metres, from the samples; null outside the area. */
  groundAt(x: number, z: number): number | null {
    const f = this.field;
    if (!f) return null;
    const m = UNITS_PER_METER;
    const i = Math.floor((x * m - f.x0) / f.step), j = Math.floor((z * m - f.z0) / f.step);
    if (i < 0 || j < 0 || i >= f.n || j >= f.n) return null;
    return f.heights[i + f.n * j]! / m;
  }

  /** The ground under a point of the canvas (CSS pixels), metres; null if the ray misses the area. */
  pick(px: number, py: number): { x: number; y: number; z: number } | null {
    const f = this.field;
    if (!f) return null;
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((px / w) * 2 - 1, -(py / h) * 2 + 1), this.camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    const stepM = Math.max(0.25, f.step / UNITS_PER_METER / 2);
    const far = this.camera.far;
    const below = (t: number) => {
      const g = this.groundAt(o.x + d.x * t, o.z + d.z * t);
      return g === null ? null : o.y + d.y * t <= g;
    };
    let prev = 0;
    for (let t = stepM; t < far; t += Math.max(stepM, t * 0.002)) {
      const b = below(t);
      if (b) {
        let lo = prev, hi = t;
        for (let it = 0; it < 24; it++) {
          const mid = (lo + hi) / 2;
          if (below(mid)) hi = mid;
          else lo = mid;
        }
        const x = o.x + d.x * hi, z = o.z + d.z * hi;
        return { x, y: this.groundAt(x, z) ?? o.y + d.y * hi, z };
      }
      prev = t;
    }
    return null;
  }

  /** Hover moves the brush ring; ⌘-press (Ctrl-press) and drag paints (see onPaint). */
  private wireInput(): void {
    const c = this.canvas;
    /** The button painting (1 left, 2 right, as in `buttons`), or 0. */
    let painting = 0;
    const at = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return this.pick(e.clientX - r.left, e.clientY - r.top);
    };
    // Measuring: a left-drag from one point of the ground to another (the view stays still).
    let measuring = false;
    c.addEventListener('pointerdown', (e) => {
      if (!this.measuringOn || e.button !== 0 || e.metaKey || e.ctrlKey) return;
      const p = at(e);
      if (!p) return;
      measuring = true;
      this.controls.enabled = false;
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        // (Not a real pointer: fine.)
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      this.measured = { a: p, b: p };
      this.showMeasure();
    }, { capture: true });
    c.addEventListener('pointermove', (e) => {
      if (!measuring || !this.measured) return;
      const p = at(e);
      if (p) this.measured.b = p;
      this.showMeasure();
    });
    const endMeasure = () => {
      if (!measuring) return;
      measuring = false;
      this.controls.enabled = true;
    };
    c.addEventListener('pointerup', endMeasure);
    c.addEventListener('pointercancel', endMeasure);
    // (Capture: before the controls see it, so they stay still while painting.)
    c.addEventListener('pointerdown', (e) => {
      const alt = e.button === 2 && this.paintsAlt;
      if ((e.button !== 0 && !alt) || !(e.metaKey || e.ctrlKey) || !this.onPaint) return;
      const p = at(e);
      if (!p) return;
      painting = alt ? 2 : 1;
      this.controls.enabled = false;
      try {
        c.setPointerCapture(e.pointerId); // keep the drag even off the canvas
      } catch {
        // (Not a real pointer: fine.)
      }
      e.preventDefault();
      this.onPaint('start', p, alt);
    }, { capture: true });
    // (No menu for a right-drag: it turns the view, or paints.)
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointermove', (e) => {
      const p = at(e);
      this.brushAt = p && { x: p.x, z: p.z };
      this.placeBrush();
      // (A move with no button down ends painting if the release went missing.)
      if (painting && (e.buttons & painting) === 0 && e.pointerType === 'mouse') return stop();
      if (painting && p) this.onPaint?.('move', p, painting === 2);
    });
    const stop = () => {
      if (!painting) return;
      const alt = painting === 2;
      painting = 0;
      this.controls.enabled = true;
      this.onPaint?.('end', null, alt);
    };
    c.addEventListener('pointerup', stop);
    c.addEventListener('pointercancel', stop);
    c.addEventListener('pointerleave', () => {
      this.brushAt = null;
      this.placeBrush();
    });
  }

  /** Measuring on or off (off: the line goes). */
  set measuring(on: boolean) {
    this.measuringOn = on;
    if (!on) this.clearMeasure();
    this.placeBrush();
  }

  get measuring(): boolean {
    return this.measuringOn;
  }

  /** Takes the measuring line away. */
  clearMeasure(): void {
    this.measured = null;
    this.showMeasure();
  }

  /** Whether flocks of birds come by. */
  set birdsOn(on: boolean) {
    this.birds.enabled = on;
  }

  /** The map grid on the ground: 1 m, 1/2 km and 1 km lines (see the voxel material's gridOn). */
  set grid(on: boolean) {
    for (const m of [this.material, this.treeMaterial]) m.uniforms.gridOn!.value = on ? 1 : 0;
  }

  /** Trees drawn at TREE_ALPHA, the ground (and the grid on it) showing through them. */
  set seeThroughTrees(on: boolean) {
    this.treesSeeThrough = on;
    this.material.uniforms.treePass!.value = on ? 1 : 0;
    for (const g of [this.meshes, this.detail])
      g.traverse((o) => {
        if (o.userData.trees) o.visible = on;
      });
  }

  /** Draws the measuring line, and puts its label at its middle (where the view now shows it). */
  private showMeasure(): void {
    const m = this.measured;
    this.measureLine.visible = this.measureShade.visible = !!m;
    if (!m) {
      this.measureLabel.hidden = true;
      return;
    }
    // (A hair above the ground at each end, so it's never inside it.)
    this.measureLine.geometry.dispose();
    this.measureLine.geometry = this.measureShade.geometry = new LineGeometry().setPositions([m.a.x, m.a.y + 0.3, m.a.z, m.b.x, m.b.y + 0.3, m.b.z]);
    if (!this.measureLabel.parentElement && this.canvas.parentElement) this.canvas.parentElement.append(this.measureLabel);
    this.measureLabel.hidden = false;
    this.measureLabel.textContent = describeMeasure(m.a, m.b);
    this.placeMeasureLabel();
  }

  private placeMeasureLabel(): void {
    const m = this.measured;
    if (!m || this.measureLabel.hidden) return;
    const mid = new THREE.Vector3((m.a.x + m.b.x) / 2, (m.a.y + m.b.y) / 2 + 0.3, (m.a.z + m.b.z) / 2).project(this.camera);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.measureLabel.style.left = `${this.canvas.offsetLeft + ((mid.x + 1) / 2) * w}px`;
    this.measureLabel.style.top = `${this.canvas.offsetTop + ((1 - mid.y) / 2) * h}px`;
    this.measureLabel.style.visibility = mid.z < 1 ? 'visible' : 'hidden';
  }

  /** The brush ring, draped over the ground around the pointer. */
  private placeBrush(): void {
    const r = this.brushRadius, a = this.brushAt;
    // (Not while measuring: the brush isn't what a drag does then.)
    this.brushRing.visible = this.brushShade.visible = r !== null && a !== null && this.field !== null && !this.measuringOn;
    if (!this.brushRing.visible) return;
    const pts: number[] = [];
    const n = Math.max(24, Math.min(160, Math.round(r! / 2)));
    // (Closed: the first point again at the end.)
    for (let k = 0; k <= n; k++) {
      const t = (k / n) * Math.PI * 2, x = a!.x + Math.cos(t) * r!, z = a!.z + Math.sin(t) * r!;
      pts.push(x, (this.groundAt(x, z) ?? this.groundAt(a!.x, a!.z) ?? 0) + 0.5, z);
    }
    this.brushRing.geometry.dispose();
    this.brushRing.geometry = this.brushShade.geometry = new LineGeometry().setPositions(pts);
    this.brushRing.computeLineDistances();
    // About 24 dashes round, whatever its size.
    const m = this.brushRing.material;
    m.dashSize = m.gapSize = (Math.PI * 2 * r!) / 48;
  }

  /** Lights the diorama (see DioramaLight). */
  setLight(l: DioramaLight): void {
    const { sunDir, sunColor, sky, ground } = dioramaLighting(l);
    const u = this.atmosphere.uniforms;
    u.sunDir.value.copy(sunDir);
    u.sunColor.value.copy(sunColor);
    u.skyAmbient.value.copy(sky);
    u.groundAmbient.value.copy(ground);
  }

  /** Quads showing. */
  get quads(): number {
    return meshQuads(this.meshes) + meshQuads(this.detail);
  }

  /** Draws a frame (call each animation frame while showing). */
  render(): void {
    const c = this.canvas;
    const w = c.clientWidth || 1, h = c.clientHeight || 1;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      this.renderer.setSize(w, h, false);
      this.miniatureFx.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
    this.placeMeasureLabel();
    const now = performance.now();
    this.birds.update((now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.water.uniforms.waveScale.value = waveScaleAt(this.camera.position.distanceTo(this.controls.target));
    this.miniatureFx.render(this.miniature ? 1 : 0);
  }

  /** Replaces the parts with these keys (sections re-made by a patch), adding any new ones. */
  update(parts: readonly DioramaPart[]): void {
    this.addParts(parts, this.meshes);
  }

  /**
   * A finer look at part of the diorama (see AreaMaker.makeDetail): its sections, and the square
   * they cover (metres), where they're drawn instead of the coarser ones; replaces the last. Null:
   * none.
   */
  showDetail(parts: readonly DioramaPart[] | null, at: { x0: number; z0: number; size: number } | null): void {
    for (const o of [...this.detail.children]) disposePackedMesh(o);
    if (parts) this.addParts(parts, this.detail);
    // The coarse sections (64 m from their origin) wholly under it, hidden.
    for (const o of this.meshes.children) {
      const x = o.position.x, z = o.position.z;
      o.visible = !(at && x >= at.x0 - 0.01 && z >= at.z0 - 0.01 && x + SECTION_M <= at.x0 + at.size + 0.01 && z + SECTION_M <= at.z0 + at.size + 0.01);
    }
  }

  /** Where the view looks (metres), and how far the camera is from it. */
  get target(): { x: number; z: number; distance: number } {
    const t = this.controls.target;
    return { x: t.x, z: t.z, distance: this.camera.position.distanceTo(t) };
  }

  private addParts(parts: readonly DioramaPart[], group: THREE.Group): void {
    for (const p of parts) {
      for (const o of [...group.children]) if (o.userData.part === p.key) disposePackedMesh(o);
      const origin = { x: p.x, y: p.y, z: p.z };
      const add = (mesh: THREE.Mesh) => {
        mesh.userData.part = p.key;
        group.add(mesh);
      };
      if (p.ground) {
        const ground = createPackedMesh(p.ground, origin, this.material, 'diorama ground');
        // (Its trees again, see-through, for when they're asked for: the same geometry.)
        const trees = new THREE.Mesh(ground.geometry, this.treeMaterial);
        Object.assign(trees, { name: 'diorama trees', visible: this.treesSeeThrough, frustumCulled: ground.frustumCulled });
        trees.userData.trees = true;
        ground.add(trees);
        add(ground);
      }
      if (p.water) {
        const w = createPackedMesh(p.water, origin, this.waterMaterial, 'diorama water');
        w.layers.set(WATER_LAYER);
        add(w);
      }
    }
  }

  private clear(): void {
    for (const o of [...this.meshes.children, ...this.detail.children]) disposePackedMesh(o);
  }

  dispose(): void {
    this.measureLabel.remove();
    this.birds.dispose();
    this.clear();
    this.controls.dispose();
    this.miniatureFx.dispose();
    this.renderer.dispose();
  }
}

/**
 * How much bigger the water's ripples and foam are drawn from `distance` metres away: as in the
 * game up close (1), swelling as the camera pulls back so they stay a few dozen pixels across and
 * the water visibly moves.
 */
export function waveScaleAt(distance: number): number {
  return Math.max(1, Math.min(40, distance / 60));
}

/** A distance for people: "84.5 m", "1.23 km". */
function distance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(1)} m`;
}

/**
 * A measurement between two points (metres) for people: the distance across the ground, and the
 * rise or fall and its slope ("184.5 m · rise +12.3 m (6.7%)").
 */
export function describeMeasure(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): string {
  const across = Math.hypot(b.x - a.x, b.z - a.z), rise = b.y - a.y;
  if (across < 0.05 && Math.abs(rise) < 0.05) return '0 m';
  const height = Math.abs(rise) < 0.05 ? 'level' : `${rise > 0 ? 'rise +' : 'fall '}${rise.toFixed(1)} m`.replace('fall -', 'fall −');
  const slope = across >= 0.05 && Math.abs(rise) >= 0.05 ? ` (${((Math.abs(rise) / across) * 100).toFixed(1)}%)` : '';
  return `${distance(across)} · ${height}${slope}`;
}
