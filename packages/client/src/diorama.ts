import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { UNITS_PER_METER, decodeClimate } from '@super-vox/shared';
import { createAtmosphere, type Atmosphere } from './atmosphere.js';
import { DEFAULT_DIORAMA_LIGHT, dioramaLighting, type DioramaLight } from './dioramaLight.js';
import { createPackedMesh, disposePackedMesh, meshQuads } from './meshFactory.js';
import { MiniatureEffect } from './miniature.js';
import { createTint } from './tint.js';
import { createVoxelMaterial } from './voxelMaterial.js';
import { WATER_LAYER, WaterRenderer, createVoxelWaterMaterial } from './water.js';
import type { DioramaPart } from './terraformArea.js';

/**
 * An area of a world up close, cut out like a diorama (see meshDioramaSection), drawn as the game
 * draws its terrain (its voxel look, water and biome colours). Orbit, zoom and pan around it.
 * Scene units are metres, at the area's true place in the world (the biome colours are looked up
 * by position). Controls as the 3D map's.
 */
export class Diorama {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: MapControls;
  private readonly material: ReturnType<typeof createVoxelMaterial>;
  private readonly water: WaterRenderer;
  private readonly waterMaterial: THREE.Material;
  private readonly meshes = new THREE.Group();
  private readonly miniatureFx: MiniatureEffect;
  private readonly atmosphere: Atmosphere;
  /** The miniature effect (the tilt-shift blur): a diorama is always seen close up, so all of it. */
  miniature = true;
  /** The ground as sampled (units), to find what's under the pointer; null before anything's shown. */
  private field: { heights: Int32Array; n: number; step: number; x0: number; z0: number } | null = null;
  /** The brush: a ring on the ground under the pointer (its radius in metres), or none. */
  private readonly brushRing: THREE.LineLoop;
  private brushRadius: number | null = null;
  private brushAt: { x: number; z: number } | null = null;
  /**
   * Painting: a ⌘-press (Ctrl-press) and drag. The diorama doesn't move while painting; it calls
   * this with each point (metres, and the ground's height there) as it goes.
   */
  onPaint: ((phase: 'start' | 'move' | 'end', at: { x: number; y: number; z: number } | null) => void) | null = null;

  constructor(climate: Uint8Array | null, wrapX: boolean, seaLevel: number | null) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'diorama';
    // (Barely any haze: the whole diorama is close.)
    const atmosphere = (this.atmosphere = createAtmosphere(60_000, seaLevel === null ? 0 : seaLevel / UNITS_PER_METER));
    this.setLight(DEFAULT_DIORAMA_LIGHT);
    this.material = createVoxelMaterial(atmosphere);
    if (climate) this.material.setTint(createTint(decodeClimate(climate), wrapX));
    this.water = new WaterRenderer(this.renderer, atmosphere);
    this.waterMaterial = createVoxelWaterMaterial(this.water.uniforms);
    this.scene.background = new THREE.Color(0x0b0d10);
    this.scene.add(this.meshes);
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
    this.brushRing = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd34d, depthTest: false }));
    this.brushRing.renderOrder = 10;
    this.brushRing.frustumCulled = false;
    this.brushRing.visible = false;
    this.scene.add(this.brushRing);
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
        override render(_r: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
          water.render(scene, camera, read);
        }
      })(),
    );
  }

  /**
   * Shows a diorama's parts (see terraform.worker.ts): `area` is its corner and size, base and top
   * (units), to frame the view on it.
   */
  show(parts: readonly DioramaPart[], area: { x0: number; z0: number; size: number; base: number; top: number }, keepView = false): void {
    this.clear();
    this.update(parts);
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
    this.placeBrush();
  }

  /** The brush ring's radius (metres) and colour; null hides it. */
  setBrush(radius: number | null, color = 0xffd34d): void {
    this.brushRadius = radius;
    (this.brushRing.material as THREE.LineBasicMaterial).color.setHex(color);
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
    let painting = false;
    const at = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return this.pick(e.clientX - r.left, e.clientY - r.top);
    };
    // (Capture: before the controls see it, so they stay still while painting.)
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !(e.metaKey || e.ctrlKey) || !this.onPaint) return;
      const p = at(e);
      if (!p) return;
      painting = true;
      this.controls.enabled = false;
      try {
        c.setPointerCapture(e.pointerId); // keep the drag even off the canvas
      } catch {
        // (Not a real pointer: fine.)
      }
      e.preventDefault();
      this.onPaint('start', p);
    }, { capture: true });
    c.addEventListener('pointermove', (e) => {
      const p = at(e);
      this.brushAt = p && { x: p.x, z: p.z };
      this.placeBrush();
      // (A move with no button down ends painting if the release went missing.)
      if (painting && (e.buttons & 1) === 0 && e.pointerType === 'mouse') return stop();
      if (painting && p) this.onPaint?.('move', p);
    });
    const stop = () => {
      if (!painting) return;
      painting = false;
      this.controls.enabled = true;
      this.onPaint?.('end', null);
    };
    c.addEventListener('pointerup', stop);
    c.addEventListener('pointercancel', stop);
    c.addEventListener('pointerleave', () => {
      this.brushAt = null;
      this.placeBrush();
    });
  }

  /** The brush ring, draped over the ground around the pointer. */
  private placeBrush(): void {
    const r = this.brushRadius, a = this.brushAt;
    this.brushRing.visible = r !== null && a !== null && this.field !== null;
    if (!this.brushRing.visible) return;
    const pts: number[] = [];
    const n = Math.max(24, Math.min(160, Math.round(r! / 2)));
    for (let k = 0; k < n; k++) {
      const t = (k / n) * Math.PI * 2, x = a!.x + Math.cos(t) * r!, z = a!.z + Math.sin(t) * r!;
      pts.push(x, (this.groundAt(x, z) ?? this.groundAt(a!.x, a!.z) ?? 0) + 0.5, z);
    }
    this.brushRing.geometry.dispose();
    this.brushRing.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
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
    return meshQuads(this.meshes);
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
    this.water.uniforms.waveScale.value = waveScaleAt(this.camera.position.distanceTo(this.controls.target));
    this.miniatureFx.render(this.miniature ? 1 : 0);
  }

  /** Replaces the parts with these keys (sections re-made by a patch), adding any new ones. */
  update(parts: readonly DioramaPart[]): void {
    for (const p of parts) {
      for (const o of [...this.meshes.children]) if (o.userData.part === p.key) disposePackedMesh(o);
      const origin = { x: p.x, y: p.y, z: p.z };
      const add = (mesh: THREE.Mesh) => {
        mesh.userData.part = p.key;
        this.meshes.add(mesh);
      };
      if (p.ground) add(createPackedMesh(p.ground, origin, this.material, 'diorama ground'));
      if (p.water) {
        const w = createPackedMesh(p.water, origin, this.waterMaterial, 'diorama water');
        w.layers.set(WATER_LAYER);
        add(w);
      }
    }
  }

  private clear(): void {
    for (const o of [...this.meshes.children]) disposePackedMesh(o);
  }

  dispose(): void {
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
