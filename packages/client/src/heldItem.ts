import * as THREE from 'three';
import { Item, type ItemId } from '@super-vox/shared';
import { bowArcGeometry, isCubeModel, itemGeometry } from './itemModels.js';

/**
 * Your bow, close up: its wood (made from its icon, without the string), stood upright with its
 * belly to the left; its string, drawn apart (from tip to tip, through the nock); and an arrow
 * on the string. In the bow's own frame (1 = the icon's width): its tips at x STRING_X, y ±TIP_Y;
 * its grip (the arc's middle) at x GRIP_X (the belly toward -x); the arrow points along -x.
 */
const STRING_X = -0.088, TIP_Y = 0.442, GRIP_X = -0.265;
/** How far the string's drawn back at full draw (the bow's frame). */
const PULL = 0.24;

class BowRig {
  readonly root = new THREE.Group();
  readonly material: THREE.MeshBasicMaterial;
  private readonly string: THREE.Line;
  private readonly stringMaterial = new THREE.LineBasicMaterial({ color: 0xebe6dc });
  private readonly arrow = new THREE.Group();
  private readonly arrowMaterials: THREE.MeshBasicMaterial[] = [];

  constructor(material: THREE.MeshBasicMaterial) {
    this.material = material;
    // The wood: the icon's arc stood upright (its tips' chord turned vertical), then turned round
    // (its belly to -x, its string side to +x).
    const flip = new THREE.Group(), upright = new THREE.Group();
    flip.rotation.y = Math.PI;
    upright.rotation.z = -Math.PI / 4;
    flip.add(upright);
    const put = (g: THREE.BufferGeometry) => {
      const mesh = new THREE.Mesh(g, material);
      mesh.frustumCulled = false;
      upright.add(mesh);
    };
    const g = bowArcGeometry();
    if (g instanceof Promise) void g.then(put);
    else put(g);
    this.string = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]), this.stringMaterial);
    this.string.frustumCulled = false;
    // The arrow: a shaft along -x from its nock (at the origin), its head beyond the grip.
    const part = (w: number, h: number, l: number, x: number, color: number) => {
      const m = new THREE.MeshBasicMaterial({ color });
      this.arrowMaterials.push(m);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(l, h, w), m);
      mesh.position.x = x;
      mesh.frustumCulled = false;
      this.arrow.add(mesh);
    };
    part(0.012, 0.012, 0.82, -0.41, 0x8a6a42);
    part(0.026, 0.026, 0.06, -0.84, 0x9aa0a6);
    part(0.04, 0.005, 0.09, -0.06, 0xe8e2d6);
    part(0.005, 0.04, 0.09, -0.06, 0xe8e2d6);
    this.root.add(flip, this.string, this.arrow);
    this.pose(0, true);
  }

  /** The string drawn back `pull` (0..1), the arrow on it (or not: just shot). */
  pose(pull: number, arrow: boolean): void {
    const nock = STRING_X + PULL * pull;
    const p = this.string.geometry.getAttribute('position') as THREE.BufferAttribute;
    p.setXYZ(0, STRING_X, TIP_Y, 0);
    p.setXYZ(1, nock, 0, 0);
    p.setXYZ(2, STRING_X, -TIP_Y, 0);
    p.needsUpdate = true;
    this.arrow.visible = arrow;
    this.arrow.position.set(nock, 0, 0);
  }

  shade(brightness: number): void {
    this.stringMaterial.color.setHex(0xebe6dc).multiplyScalar(brightness);
    const colors = [0x8a6a42, 0x9aa0a6, 0xe8e2d6, 0xe8e2d6];
    this.arrowMaterials.forEach((m, i) => m.color.setHex(colors[i]!).multiplyScalar(brightness));
  }
}

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
  private bow: BowRig | null = null;
  /** The bow's string, as drawn now (0..1: it follows the draw; let go, it snaps back); and when an arrow was last shot (s ago: another's on the string soon after). */
  private pull = 0;
  private sinceShot = Infinity;
  private drawing = false;
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
    if (this.bow) this.holder.remove(this.bow.root);
    this.bow = null;
    if (item === null) return;
    if (item === Item.Bow) {
      this.bow = new BowRig(this.material);
      this.holder.add(this.bow.root);
      this.pull = 0;
      return;
    }
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
    if (this.bow) {
      // A bow, close up: its tips out of sight, its grip to the right of the middle, turned a
      // little left (its belly forward and left, its string toward us on the right); the arrow on
      // the string pointing ahead. Drawn: the string and the arrow come back, the bow in a little.
      // Let go: the string snaps back, and the next arrow's on it a moment later.
      if (s.draw !== null) {
        this.drawing = true;
        this.pull = s.draw;
      } else {
        if (this.drawing) this.sinceShot = 0;
        this.drawing = false;
        this.pull = Math.max(0, this.pull - dt * 12);
      }
      this.sinceShot += dt;
      const d = this.pull;
      h.scale.setScalar(1);
      // (Drawn, it goes out a little as the nock comes back: the nock stays a hand's width from the eye.)
      h.position.set(0.21 - 0.07 * d + bobX, -0.08 + bobY - (1 - this.raise) * 0.4, -0.3 - 0.08 * d);
      // (Its belly along -x in its own frame: turned so that's ahead and a little left.)
      h.rotation.set(0.04, -1.25 - 0.12 * d, 0.06);
      this.bow.pose(d, this.sinceShot > 0.4);
      this.bow.shade(s.brightness);
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
    if (!this.mesh && !this.bow) return;
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
