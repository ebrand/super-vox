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
import type { DioramaPart } from './terraform.worker.js';

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
    this.controls.minDistance = 5;
    this.controls.maxDistance = 12_000;
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
  show(parts: readonly DioramaPart[], area: { x0: number; z0: number; size: number; base: number; top: number }): void {
    this.clear();
    for (const p of parts) {
      const origin = { x: p.x, y: p.y, z: p.z };
      if (p.ground) this.meshes.add(createPackedMesh(p.ground, origin, this.material, 'diorama ground'));
      if (p.water) {
        const w = createPackedMesh(p.water, origin, this.waterMaterial, 'diorama water');
        w.layers.set(WATER_LAYER);
        this.meshes.add(w);
      }
    }
    // Look at the middle of the area from the south and above, all of it in view.
    const m = UNITS_PER_METER, size = area.size / m;
    const mid = new THREE.Vector3((area.x0 + area.size / 2) / m, (area.base + area.top) / 2 / m, (area.z0 + area.size / 2) / m);
    this.controls.target.copy(mid);
    this.camera.position.set(mid.x, mid.y + size * 0.8, mid.z + size * 1.25);
    this.controls.update();
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
    this.miniatureFx.render(this.miniature ? 1 : 0);
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
