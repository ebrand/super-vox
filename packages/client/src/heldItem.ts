import * as THREE from 'three';
import { Item, type ItemId } from '@super-vox/shared';
import { isCubeModel, itemGeometry } from './itemModels.js';

/** How long a swing takes (s). */
export const SWING_S = 0.28;

/** What the hand's doing this frame. */
export interface HandState {
  /** Seconds since the last frame. */
  dt: number;
  /** How fast we're going over the ground (m/s: walking bobs the hand). */
  speed: number;
  /** A bow being drawn: how far (0..1); null: not. */
  draw: number | null;
  /** Mining (held down): swings over and over. */
  mining: boolean;
  /** How bright it is where we stand (0..1, as entities are shaded). */
  brightness: number;
}

/**
 * What's in your hand, drawn at the lower right of the view (its own scene and camera, drawn over
 * the world after it, so it never goes into walls): a tool held by its handle, a block as a small
 * cube; swung when you use it, drawn back as a bow is, bobbing as you walk.
 */
export class HeldItem {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.01, 10);
  private readonly holder = new THREE.Group();
  private readonly material = new THREE.MeshBasicMaterial({ vertexColors: true });
  private mesh: THREE.Mesh | null = null;
  private item: ItemId | null = null;
  private swingT = Infinity;
  private walkPhase = 0;
  private bob = 0;
  /** Coming up into view after a change (0..1). */
  private raise = 1;

  constructor() {
    this.scene.add(this.holder);
  }

  /** What's in hand now (null: nothing). */
  setItem(item: ItemId | null): void {
    if (item === this.item) return;
    this.item = item;
    this.raise = 0;
    if (this.mesh) this.holder.remove(this.mesh);
    this.mesh = null;
    if (item === null) return;
    const g = itemGeometry(item);
    const put = (geometry: THREE.BufferGeometry) => {
      if (this.item !== item) return;
      if (this.mesh) this.holder.remove(this.mesh);
      this.mesh = new THREE.Mesh(geometry, this.material);
      this.mesh.frustumCulled = false;
      this.holder.add(this.mesh);
    };
    if (g instanceof Promise) void g.then(put);
    else put(g);
  }

  /** A swing (mining, hitting, placing, using). */
  swing(): void {
    if (this.swingT >= SWING_S * 0.6) this.swingT = 0;
  }

  /** Moves it for this frame (see HandState). */
  update(s: HandState): void {
    const dt = Math.min(s.dt, 0.1);
    this.swingT += dt;
    if (s.mining && this.swingT >= SWING_S) this.swingT = 0;
    this.raise = Math.min(1, this.raise + dt * 5);
    // Bob: a step's rise and fall, and sway, while going; settling when still.
    const going = Math.min(1, s.speed / 4.3);
    this.walkPhase += dt * (2 + s.speed * 1.6);
    this.bob += (going - this.bob) * Math.min(1, dt * 8);
    const bobY = Math.abs(Math.sin(this.walkPhase)) * 0.025 * this.bob, bobX = Math.sin(this.walkPhase) * 0.015 * this.bob;
    const u = Math.min(1, this.swingT / SWING_S), swing = Math.sin(u * Math.PI);
    const cube = this.item !== null && isCubeModel(this.item);
    const size = cube ? 0.13 : 0.42;
    this.material.color.setScalar(s.brightness);
    const h = this.holder;
    h.scale.setScalar(size);
    if (this.item === Item.Bow) {
      // A bow: held upright to the right, turned side on; drawn: in toward the middle, turned to
      // face us (looking along the arrow), a little closer.
      const d = s.draw ?? 0;
      h.position.set(0.26 - 0.14 * d + bobX, -0.22 + 0.02 * d + bobY - (1 - this.raise) * 0.4, -0.6 + 0.08 * d);
      // (Its icon's tips are at the top left and bottom right: turned an eighth clockwise, it stands upright.)
      h.rotation.set(0, 0.6 - 0.45 * d, -Math.PI / 4);
      return;
    }
    if (cube) {
      // A block: a small cube, turned, low right; swung: pushed out and down.
      h.position.set(0.34 + bobX, -0.27 + bobY - 0.06 * swing - (1 - this.raise) * 0.4, -0.62 - 0.1 * swing);
      h.rotation.set(0.35 + 0.6 * swing, 0.75, 0);
      return;
    }
    // A tool (its icon's handle at the bottom left, its head at the top right): held by the
    // handle, the head up and forward, seen from the side; swung: down and in, toward the middle.
    h.position.set(0.38 + bobX - 0.12 * swing, -0.3 + bobY - 0.06 * swing - (1 - this.raise) * 0.4, -0.62 - 0.05 * swing);
    h.rotation.set(-1.15 * swing, -1.25 + 0.3 * swing, 0.15 + 0.25 * swing);
  }

  /** Draws it over what's been drawn (the depth cleared first: it's always in front). */
  render(renderer: THREE.WebGLRenderer): void {
    if (!this.mesh) return;
    const size = renderer.getSize(new THREE.Vector2());
    if (size.y > 0 && Math.abs(this.camera.aspect - size.x / size.y) > 1e-3) {
      this.camera.aspect = size.x / size.y;
      this.camera.updateProjectionMatrix();
    }
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
  }
}
