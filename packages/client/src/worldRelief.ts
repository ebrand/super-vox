import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { HorizontalTiltShiftShader } from 'three/examples/jsm/shaders/HorizontalTiltShiftShader.js';
import { HueSaturationShader } from 'three/examples/jsm/shaders/HueSaturationShader.js';
import { VerticalTiltShiftShader } from 'three/examples/jsm/shaders/VerticalTiltShiftShader.js';
import { UNITS_PER_METER } from '@super-vox/shared';
import { materialColor } from './materials.js';
import type { MapData, MapMarker } from './worldMap.js';

/** What's under a point of the relief: world position (units), surface height (units) and material. */
export interface ReliefPoint {
  x: number;
  z: number;
  height: number;
  material: number;
}

/** Heights are drawn this many times taller by default: true to life (the slider exaggerates them). */
export const DEFAULT_EXAGGERATION = 1;

// As the game and the 2D map light the ground (voxelMaterial.ts): 0.55 ambient + 0.45 from the
// sun. (three.js's Lambert divides by pi, hence the factors.)
const SUN = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
const SEA_COLOR = 0x2f6d9c;
const SEA_OPACITY = 0.35;
/** The sea floor, coloured by depth (linear RGB): shallows to deep water at SEA_DEEP metres. */
const SEA_SHALLOW = [0.06, 0.24, 0.36] as const;
const SEA_FLOOR_DEEP = [0.01, 0.05, 0.14] as const;
const SEA_DEEP = 250;
/**
 * Miniature (tilt-shift): the top and bottom of the view blurred, sharp across the middle, colours
 * a little richer; none with the whole world in view, all of it from MINIATURE_FULL metres away.
 * Blur at the frame's edges (pixels, at full strength) and the extra saturation.
 */
const MINIATURE_FULL = 2500;
const MINIATURE_BLUR = 22;
const MINIATURE_SATURATION = 0.18;
/** The band across the middle that stays sharp: this far either side of the middle (fraction of the height). */
export const FOCUS_BAND = 0.15;

/**
 * How blurred a row is, `dy` (0..0.5) from the middle of the view: 0 within the sharp band,
 * growing to 0.5 at the top and bottom edges (as three.js's tilt-shift blurs at the edges).
 * The shaders below compute the same.
 */
export function focusBlur(dy: number, band = FOCUS_BAND): number {
  return (0.5 * Math.max(0, Math.abs(dy) - band)) / (0.5 - band);
}

/** The line in each of three.js's tilt-shift shaders that sets how far apart its samples are. */
export const TILT_H_LINE = /float (hh) = (h) \* abs\( r - vUv\.y \);/;
export const TILT_V_LINE = /float (vv) = (v) \* abs\( r - vUv\.y \);/;

/** One of three.js's tilt-shift passes, with a sharp band across the middle (see focusBlur). */
export function withFocusBand(shader: { uniforms: Record<string, { value: unknown }>; vertexShader: string; fragmentShader: string }, line: RegExp): typeof shader {
  const fragmentShader = shader.fragmentShader
    .replace('uniform float r;', 'uniform float r;\nuniform float band;')
    .replace(line, (m, name: string, scale: string) => `float ${name} = ${scale} * 0.5 * max( 0.0, abs( r - vUv.y ) - band ) / ( 0.5 - band );`);
  if (!fragmentShader.includes('uniform float band;') || !fragmentShader.includes('- band ) / ( 0.5 - band )')) throw new Error('tilt-shift shader changed: update withFocusBand');
  return { ...shader, uniforms: { ...THREE.UniformsUtils.clone(shader.uniforms), band: { value: FOCUS_BAND } }, fragmentShader };
}

/** How much miniature effect at a camera `distance` (m) on a world `size` m across its narrower side: 0..1. */
export function miniatureAmount(distance: number, size: number): number {
  const far = Math.max(MINIATURE_FULL * 1.5, size * 0.35);
  const t = Math.max(0, Math.min(1, (far - distance) / (far - MINIATURE_FULL)));
  return t * t * (3 - 2 * t);
}

/**
 * The whole world in 3D, in miniature: the world map's samples as a lit surface (heights
 * exaggerated), with the sea, the player and the spawn point. Drag to pan, right-drag to rotate
 * and tilt, wheel to zoom about the cursor; round worlds wrap east-west. Scene units are metres.
 */
export class WorldRelief {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: MapControls;
  private readonly geometry: THREE.BufferGeometry;
  private readonly meshes: THREE.Mesh[] = [];
  private readonly sea: THREE.Mesh | null = null;
  private readonly player: THREE.Mesh;
  private readonly spawnMark: THREE.Mesh;
  /** World size (m). */
  private readonly width: number;
  private readonly depth: number;
  /** Grid columns drawn (one more than the map's on round worlds, closing the seam). */
  private readonly gridCols: number;
  private exaggeration = DEFAULT_EXAGGERATION;
  private readonly composer: EffectComposer;
  private readonly tiltH: ShaderPass;
  private readonly tiltV: ShaderPass;
  private readonly saturate: ShaderPass;
  /** Each map sample's colour, a texel apiece (sRGB). */
  private readonly colors: THREE.DataTexture;
  private miniatureOn = true;

  constructor(
    private readonly map: MapData,
    private readonly world: { width: number; depth: number; wrapX: boolean },
    private readonly playerAt: () => MapMarker,
    private readonly spawn: MapMarker,
  ) {
    this.width = world.width / UNITS_PER_METER;
    this.depth = world.depth / UNITS_PER_METER;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'relief';
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene.background = new THREE.Color(0x05070a);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55 * Math.PI));
    const sun = new THREE.DirectionalLight(0xffffff, 0.45 * Math.PI);
    sun.position.copy(SUN);
    this.scene.add(sun);

    // The surface: a vertex per map sample, at the sample's centre.
    this.gridCols = map.cols + (world.wrapX ? 1 : 0);
    const n = this.gridCols * map.rows;
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    // Colours come from a texture with a texel per sample, its centre on the sample's vertex: drawn
    // nearest-texel, each sample is a crisp square, with sharp, pixelated borders.
    const uv = new Float32Array(n * 2);
    for (let j = 0; j < map.rows; j++) {
      for (let i = 0; i < this.gridCols; i++) uv.set([(i + 0.5) / map.cols, (j + 0.5) / map.rows], (i + this.gridCols * j) * 2);
    }
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.colors = new THREE.DataTexture(new Uint8Array(map.cols * map.rows * 4), map.cols, map.rows, THREE.RGBAFormat);
    this.colors.colorSpace = THREE.SRGBColorSpace;
    this.colors.wrapS = world.wrapX ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    this.colors.wrapT = THREE.ClampToEdgeWrapping;
    this.colors.magFilter = THREE.NearestFilter;
    this.colors.minFilter = THREE.LinearMipmapLinearFilter;
    this.colors.generateMipmaps = true;
    this.colors.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const index = new Uint32Array((this.gridCols - 1) * (map.rows - 1) * 6);
    let k = 0;
    for (let j = 0; j < map.rows - 1; j++) {
      for (let i = 0; i < this.gridCols - 1; i++) {
        const a = i + this.gridCols * j, b = a + 1, c = a + this.gridCols, d = c + 1;
        index.set([a, c, b, b, c, d], k);
        k += 6;
      }
    }
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.setColors();
    this.placeVertices();
    const material = new THREE.MeshLambertMaterial({ map: this.colors });
    // Round worlds: copies either side, so the world carries on past its seam.
    for (const off of world.wrapX ? [-1, 0, 1] : [0]) {
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.position.x = off * this.width;
      this.meshes.push(mesh);
      this.scene.add(mesh);
    }
    if (map.seaLevel !== null) {
      const span = world.wrapX ? 3 * this.width : this.width;
      this.sea = new THREE.Mesh(
        new THREE.PlaneGeometry(span, this.depth).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: SEA_COLOR, transparent: true, opacity: SEA_OPACITY, depthWrite: false }),
      );
      // Heights are drawn relative to the sea, so it sits at 0 (just above, to win ties with the shore).
      this.sea.position.set(this.width / 2, 0.05, this.depth / 2);
      this.scene.add(this.sea);
    }
    // The player (a red arrowhead pointing the way they face) and the spawn point (a white ring),
    // sized to stay visible at any zoom.
    this.player = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1, 12).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff3b30 }));
    this.spawnMark = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.12, 8, 24).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.scene.add(this.player, this.spawnMark);

    this.camera = new THREE.PerspectiveCamera(45, 1, 10, Math.max(this.width, this.depth) * 8);
    this.controls = new MapControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = 1.45;
    this.controls.minDistance = 150;
    this.controls.maxDistance = Math.max(this.width, this.depth) * 1.6;
    this.controls.addEventListener('change', () => this.keepInWorld());

    // Drawn through passes: the scene (multisampled), the tilt-shift blur (across, then up and
    // down), a little more saturation, then out to the screen's colours.
    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType }));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.tiltH = new ShaderPass(withFocusBand(HorizontalTiltShiftShader, TILT_H_LINE));
    this.tiltV = new ShaderPass(withFocusBand(VerticalTiltShiftShader, TILT_V_LINE));
    for (const t of [this.tiltH, this.tiltV]) t.uniforms['r']!.value = 0.5;
    this.saturate = new ShaderPass(HueSaturationShader);
    this.composer.addPass(this.tiltH);
    this.composer.addPass(this.tiltV);
    this.composer.addPass(this.saturate);
    this.composer.addPass(new OutputPass());
    this.reset();
  }

  /** Back to the starting view: the player's region from the south, the whole world in sight. */
  reset(): void {
    const p = this.playerAt();
    const x = p.x / UNITS_PER_METER, z = p.z / UNITS_PER_METER;
    const y = this.surfaceY(p.x, p.z);
    const dist = Math.min(this.width, this.depth) * 0.9;
    this.controls.target.set(x, y, z);
    this.camera.position.set(x, y + dist * 0.75, z + dist * 0.66);
    this.controls.update();
  }

  /** Heights drawn `factor` times taller. */
  setExaggeration(factor: number): void {
    if (factor === this.exaggeration) return;
    const ratio = factor / this.exaggeration;
    this.exaggeration = factor;
    this.placeVertices();
    // Keep looking at the same ground, from as far above it.
    const before = this.controls.target.y;
    this.controls.target.y *= ratio;
    this.camera.position.y += this.controls.target.y - before;
    this.controls.update();
  }

  get heightFactor(): number {
    return this.exaggeration;
  }

  /** Miniature mode: the tilt-shift blur (top and bottom) as you zoom in. */
  get miniature(): boolean {
    return this.miniatureOn;
  }

  set miniature(on: boolean) {
    this.miniatureOn = on;
  }

  /** The map's colours changed (biome tints arrived): repaint. */
  recolor(): void {
    this.setColors();
  }

  /** Draws a frame (call each animation frame while showing). */
  render(): void {
    const c = this.canvas;
    const w = c.clientWidth || 1, h = c.clientHeight || 1;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      this.renderer.setSize(w, h, false);
      this.composer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
    this.placeMarkers();
    // The miniature effect, by how close the camera is. (The blur's step is per pass and per
    // unit of distance from the sharp line, which runs across the middle.)
    const amount = this.miniatureOn ? miniatureAmount(this.camera.position.distanceTo(this.controls.target), Math.min(this.width, this.depth)) : 0;
    const blur = (MINIATURE_BLUR / 2) * amount;
    this.tiltH.enabled = this.tiltV.enabled = this.saturate.enabled = amount > 0.01;
    this.tiltH.uniforms['h']!.value = blur / w;
    this.tiltV.uniforms['v']!.value = blur / h;
    this.saturate.uniforms['saturation']!.value = MINIATURE_SATURATION * amount;
    this.composer.render();
  }

  /** What's under a point of the canvas (CSS pixels from its top left), or null for sky. */
  pick(px: number, py: number): ReliefPoint | null {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((px / w) * 2 - 1, -(py / h) * 2 + 1), this.camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    // March along the ray until it's below the surface, then narrow it down.
    const stepM = Math.max(4, this.map.step / UNITS_PER_METER / 2);
    const far = Math.max(this.width, this.depth) * 4;
    const below = (t: number) => {
      const x = o.x + d.x * t, z = o.z + d.z * t;
      if (!this.world.wrapX && (x < 0 || x >= this.width)) return null;
      if (z < 0 || z >= this.depth) return null;
      return o.y + d.y * t <= this.surfaceY(x * UNITS_PER_METER, z * UNITS_PER_METER);
    };
    let prev = 0;
    for (let t = stepM; t < far; t += Math.max(stepM, t * 0.002)) {
      const b = below(t);
      if (b === null) {
        if (d.y >= 0 && o.y + d.y * t > 5000 * this.exaggeration) return null;
        prev = t;
        continue;
      }
      if (b) {
        let lo = prev, hi = t;
        for (let it = 0; it < 20; it++) {
          const mid = (lo + hi) / 2;
          if (below(mid)) hi = mid;
          else lo = mid;
        }
        let x = (o.x + d.x * hi) * UNITS_PER_METER;
        const z = (o.z + d.z * hi) * UNITS_PER_METER;
        if (this.world.wrapX) x = mod(x, this.world.width);
        const m = this.map, i = Math.min(m.cols - 1, Math.max(0, Math.floor(x / m.step))), j = Math.min(m.rows - 1, Math.max(0, Math.floor(z / m.step)));
        const k = i + m.cols * j;
        return { x: (i + 0.5) * m.step, z: (j + 0.5) * m.step, height: m.heights[k]!, material: m.materials[k]! };
      }
      prev = t;
    }
    return null;
  }

  dispose(): void {
    this.controls.dispose();
    this.composer.dispose();
    this.colors.dispose();
    this.geometry.dispose();
    this.renderer.dispose();
  }

  /** The drawn surface's height (scene metres) at a world point (units), from the map's samples. */
  private surfaceY(x: number, z: number): number {
    const m = this.map;
    // Between sample centres, bilinearly (round worlds wrap).
    const fx = x / m.step - 0.5, fz = Math.max(0, Math.min(m.rows - 1, z / m.step - 0.5));
    const i0 = Math.floor(fx), j0 = Math.min(m.rows - 2, Math.floor(fz));
    const tx = fx - i0, tz = fz - j0;
    const col = (i: number) => (this.world.wrapX ? mod(i, m.cols) : Math.max(0, Math.min(m.cols - 1, i)));
    const h = (i: number, j: number) => this.heightAt(m.heights[col(i) + m.cols * Math.max(0, Math.min(m.rows - 1, j))]!);
    const a = h(i0, j0) + (h(i0 + 1, j0) - h(i0, j0)) * tx;
    const b = h(i0, j0 + 1) + (h(i0 + 1, j0 + 1) - h(i0, j0 + 1)) * tx;
    return a + (b - a) * Math.max(0, Math.min(1, tz));
  }

  /** A map height (units) as drawn (scene metres, exaggerated, relative to the sea). */
  private heightAt(units: number): number {
    return ((units - (this.map.seaLevel ?? 0)) / UNITS_PER_METER) * this.exaggeration;
  }

  private placeVertices(): void {
    const m = this.map, pos = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const step = m.step / UNITS_PER_METER;
    for (let j = 0; j < m.rows; j++) {
      for (let i = 0; i < this.gridCols; i++) {
        const v = i + this.gridCols * j;
        pos.setXYZ(v, (i + 0.5) * step, this.heightAt(m.heights[(i % m.cols) + m.cols * j]!), (j + 0.5) * step);
      }
    }
    pos.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
  }

  private setColors(): void {
    const m = this.map, data = this.colors.image.data as Uint8Array;
    for (let j = 0; j < m.rows; j++) {
      for (let i = 0; i < m.cols; i++) {
        const k = i + m.cols * j;
        const own = m.colors && !Number.isNaN(m.colors[k * 3]!);
        let c: readonly number[] = own ? [m.colors![k * 3]!, m.colors![k * 3 + 1]!, m.colors![k * 3 + 2]!] : materialColor(m.materials[k]!);
        if (m.seaLevel !== null && m.heights[k]! < m.seaLevel) {
          // Under the sea: blue, darker with depth (as on a relief map; the sea floor's own colour reads as grey).
          const t = Math.min(1, (m.seaLevel - m.heights[k]!) / UNITS_PER_METER / SEA_DEEP);
          c = SEA_SHALLOW.map((v, q) => v + (SEA_FLOOR_DEEP[q]! - v) * Math.sqrt(t));
        }
        data.set([...c.map((v) => Math.round(255 * Math.max(0, Math.min(1, linearToSrgb(v))))), 255], k * 4);
      }
    }
    this.colors.needsUpdate = true;
  }

  private placeMarkers(): void {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const s = dist * 0.02;
    const near = (x: number) => (this.world.wrapX ? x + Math.round((this.controls.target.x - x) / this.width) * this.width : x);
    const p = this.playerAt();
    const px = near(p.x / UNITS_PER_METER), pz = p.z / UNITS_PER_METER;
    this.player.scale.setScalar(s);
    this.player.position.set(px, Math.max(this.surfaceY(p.x, p.z), 0) + s * 0.6, pz);
    this.player.rotation.y = p.yaw ?? 0;
    const sx = near(this.spawn.x / UNITS_PER_METER), sz = this.spawn.z / UNITS_PER_METER;
    this.spawnMark.scale.setScalar(s);
    this.spawnMark.position.set(sx, Math.max(this.surfaceY(this.spawn.x, this.spawn.z), 0) + s * 0.2, sz);
  }

  /** Keeps the view over the world: round worlds wrap the target back into it, flat ones stop at its edges. */
  private keepInWorld(): void {
    const t = this.controls.target, c = this.camera.position;
    if (this.world.wrapX) {
      const shift = Math.floor(t.x / this.width) * this.width;
      if (shift !== 0) {
        t.x -= shift;
        c.x -= shift;
      }
    } else {
      const cx = Math.max(0, Math.min(this.width, t.x)) - t.x;
      t.x += cx;
      c.x += cx;
    }
    const cz = Math.max(0, Math.min(this.depth, t.z)) - t.z;
    t.z += cz;
    c.z += cz;
  }
}

const mod = (v: number, m: number) => ((v % m) + m) % m;

/** Linear to sRGB (0..1). */
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}
