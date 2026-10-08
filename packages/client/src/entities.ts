import * as THREE from 'three';
import { ARROW, Item, MOBS, PlayerAct, UNITS_PER_METER, deltaX, gripKind, type EntityKind, type EntitySnapshot, type Grip, type WorldConfig } from '@super-vox/shared';
import { isCubeModel, itemGeometry } from './itemModels.js';
import { SWING_S } from './heldItem.js';
import { FIGURE_HEIGHT, PlayerFigure, animations, playerColor, poseFor, type FigureState } from './playerFigure.js';

/**
 * How bright something is (0..1) with sky light `sky` and torchlight `block` (0..15) where it
 * stands, by `daylight` (1 day .. small at night). Each step down 70% as bright: steeper than
 * the world's shading (80%), since mobs are drawn at full colour where the ground is lit by the
 * sky's ambient light, a third of that; so in the dark a mob is about as dark as the rock.
 */
export function entityBrightness(sky: number, block: number, daylight: number): number {
  const torch = block > 0 ? 0.7 ** (15 - block) : 0;
  return Math.max(0.004, Math.min(1, Math.max(0.7 ** (15 - sky) * daylight, torch)));
}

/** Placeholder looks: a box per kind (metres) and its colour; players 0.6 x 1.8 m, blue. */
const LOOK: Record<EntityKind, { w: number; h: number; long: number; color: number }> = {
  player: { w: 0.6, h: 1.8, long: 0.6, color: 0x3b82f6 },
  pig: { w: MOBS.pig.width, h: MOBS.pig.height, long: 1.3, color: 0xf2a0b1 },
  zombie: { w: MOBS.zombie.width, h: MOBS.zombie.height, long: 0.6, color: 0x4d8a3a },
};

/** Snapshots arrive about every 100 ms; things are drawn this far behind, between the last two. */
export const INTERPOLATION_MS = 100;

interface Tracked {
  kind: EntityKind;
  group: THREE.Group;
  body: THREE.MeshBasicMaterial;
  face: THREE.MeshBasicMaterial;
  /** How bright it's drawn (see entityBrightness), and when that was last worked out (ms). */
  brightness: number;
  litAt: number;
  from: EntitySnapshot;
  to: EntitySnapshot;
  /** When `to` arrived (ms). */
  at: number;
  hurtUntil: number;
  /** Players: what's in their hand (its model in `hand`, in the figure's hand), and when they last swung it (ms). */
  held?: number | undefined;
  hand?: THREE.Group | undefined;
  handMaterial?: THREE.MeshBasicMaterial;
  swungAt: number;
  /** Players: their figure (see PlayerFigure) and colour, and how it's moving (see FigureMotion). */
  figure?: PlayerFigure;
  color?: THREE.Color;
  motion?: FigureMotion;
}

/** How a figure's going, from where it's drawn frame to frame: for its strides. */
export class FigureMotion {
  private last: { x: number; y: number; z: number } | null = null;
  private lastAt = 0;
  private readonly born: number;
  speed = 0;
  stride = 0;
  /** When it started drawing a bow (ms), if it is. */
  drawFrom: number | null = null;

  constructor(now: number) {
    this.born = now;
  }

  /**
   * Moves on to where it's drawn now (units) at `now` (ms), doing `act` (PlayerAct flags), looking
   * `pitch` up; swung `swingU` of the way through a swing (null: not). The state to pose it by.
   */
  step(at: { x: number; y: number; z: number }, now: number, act: number, pitch: number, swingU: number | null): FigureState {
    const dt = this.last ? Math.min(0.25, (now - this.lastAt) / 1000) : 0;
    if (this.last && dt > 0) {
      const d = Math.hypot(at.x - this.last.x, at.z - this.last.z) / UNITS_PER_METER;
      // (Eased: snapshots come ten times a second, frames many more.)
      this.speed += (Math.min(20, d / dt) - this.speed) * Math.min(1, dt * 8);
      // A full stride (two steps) every so far walking, further running (see the animations' settings).
      const set = animations().settings;
      this.stride += (d * 2 * Math.PI) / (this.speed > set.runFrom ? set.runStride : set.walkStride);
    }
    this.last = { ...at };
    this.lastAt = now;
    if (act & PlayerAct.drawing) this.drawFrom ??= now;
    else this.drawFrom = null;
    return {
      time: (now - this.born) / 1000,
      stride: this.stride,
      speed: this.speed,
      airborne: !!(act & PlayerAct.airborne),
      swimming: !!(act & PlayerAct.swimming),
      flying: !!(act & PlayerAct.flying),
      mining: !!(act & PlayerAct.mining),
      swing: swingU,
      draw: this.drawFrom === null ? null : Math.min(1, (now - this.drawFrom) / ARROW.drawMs),
      pitch,
    };
  }
}

/** Where to draw something between two snapshots `t` of the way (0..1); yaw the shortest way round. */
export function interpolate(a: EntitySnapshot, b: EntitySnapshot, t: number): { x: number; y: number; z: number; yaw: number } {
  const k = Math.max(0, Math.min(1, t));
  let dyaw = b.yaw - a.yaw;
  dyaw = ((((dyaw + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, yaw: a.yaw + dyaw * k };
}

/**
 * Where a ray (units) from `origin` along unit `dir` first enters the box (units), as a
 * distance, or null if it misses (or the box is behind).
 */
export function rayBox(origin: readonly number[], dir: readonly number[], min: readonly number[], max: readonly number[]): number | null {
  let t0 = 0, t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    const o = origin[a]!, d = dir[a]!;
    if (Math.abs(d) < 1e-12) {
      if (o < min[a]! || o > max[a]!) return null;
      continue;
    }
    let ta = (min[a]! - o) / d, tb = (max[a]! - o) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}

/**
 * Mobs and other players: mobs as placeholder boxes (a darker block at the front), players as
 * jointed figures (see PlayerFigure) in their own colours with their names over them, posed by
 * what they're doing; moved smoothly between the server's snapshots and flashing red when hurt.
 */
export class EntityView {
  private readonly tracked = new Map<number, Tracked>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: WorldConfig,
    /** The camera's x (units), to draw things at their copy nearest it on round worlds. */
    private readonly cameraX: () => number,
    /** The light (sky and torchlight, 0..15) at a point (units), if known, and how much daylight there is (0..1). */
    private readonly light: (x: number, y: number, z: number) => { sky: number; block: number } | null = () => null,
    private readonly daylight: () => number = () => 1,
  ) {}

  /** Takes a snapshot: new things appear, gone things go. */
  update(list: readonly EntitySnapshot[], now = performance.now()): void {
    const seen = new Set<number>();
    for (const e of list) {
      seen.add(e.id);
      const t = this.tracked.get(e.id);
      if (!t) {
        const made: Tracked = { ...this.make(e), from: e, to: e, at: now, hurtUntil: e.hurt ? now + 300 : 0, brightness: 1, litAt: -Infinity, swungAt: -Infinity };
        this.tracked.set(e.id, made);
        this.hold(made, e.held);
        continue;
      }
      // A player's hand: what's in it now; swung, if they've swung since.
      if (e.kind === 'player') {
        this.hold(t, e.held);
        if ((e.swings ?? 0) > (t.to.swings ?? 0)) t.swungAt = now;
      }
      // From wherever it's drawn now to the new snapshot.
      const p = interpolate(t.from, t.to, (now - t.at) / INTERPOLATION_MS);
      t.from = { ...t.to, ...p };
      t.to = e;
      t.at = now;
      if (e.hurt) t.hurtUntil = now + 300;
    }
    for (const [id, t] of this.tracked) {
      if (seen.has(id)) continue;
      this.scene.remove(t.group);
      t.group.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
          // (Shared: a figure's parts, items' models.)
          if (!o.userData.shared) o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      this.tracked.delete(id);
    }
  }

  /** Places everything for this frame. */
  frame(now = performance.now()): void {
    const camX = this.cameraX();
    for (const t of this.tracked.values()) {
      const p = interpolate(t.from, t.to, (now - t.at) / INTERPOLATION_MS);
      const x = camX + deltaX(this.world, camX, p.x);
      t.group.position.set(x / UNITS_PER_METER, p.y / UNITS_PER_METER, p.z / UNITS_PER_METER);
      t.group.rotation.y = p.yaw;
      // Shaded by the light where it stands (looked at a few times a second): dark in caves and at night.
      if (now - t.litAt > 250) {
        t.litAt = now;
        const l = this.light(p.x, p.y + 8, p.z);
        t.brightness = l ? entityBrightness(l.sky, l.block, this.daylight()) : 1;
      }
      if (t.figure) {
        // A player: posed by what it's doing (walking as fast as it goes, swinging, drawing a bow...).
        const u = (now - t.swungAt) / 1000 / SWING_S;
        const pitch = (t.from.pitch ?? 0) + ((t.to.pitch ?? 0) - (t.from.pitch ?? 0)) * Math.min(1, (now - t.at) / INTERPOLATION_MS);
        t.figure.pose(poseFor(t.motion!.step(p, now, t.to.act ?? 0, pitch, u < 1 ? u : null)));
        if (now < t.hurtUntil) t.body.color.setHex(0xff3030).multiplyScalar(t.brightness);
        else t.body.color.copy(t.color!).multiplyScalar(t.brightness);
        if (t.handMaterial) t.handMaterial.color.setScalar(t.brightness);
        continue;
      }
      t.body.color.setHex(now < t.hurtUntil ? 0xff3030 : LOOK[t.kind].color).multiplyScalar(t.brightness);
      t.face.color.setHex(0x1b1b1b).multiplyScalar(t.brightness);
    }
  }

  /** Puts `item` in a player's hand (its model at their right side), or nothing. */
  private hold(t: Tracked, item: number | undefined): void {
    if (t.kind !== 'player' || item === t.held) return;
    t.held = item;
    if (t.hand) {
      t.hand.removeFromParent();
      t.hand = undefined;
    }
    if (item === undefined || !t.figure) return;
    t.handMaterial ??= new THREE.MeshBasicMaterial({ vertexColors: true });
    const hand = heldModel(item, t.handMaterial);
    t.hand = hand;
    t.figure.hand(heldGrip(item).hand).add(hand);
  }

  /** The nearest mob (not player) a ray (units) hits within `maxDist` units, and how far along. */
  pick(origin: readonly number[], dir: readonly number[], maxDist: number, now = performance.now()): { id: number; dist: number } | null {
    const camX = this.cameraX();
    let best: { id: number; dist: number } | null = null;
    for (const [id, t] of this.tracked) {
      if (t.kind === 'player') continue;
      const p = interpolate(t.from, t.to, (now - t.at) / INTERPOLATION_MS);
      const x = camX + deltaX(this.world, camX, p.x);
      const look = LOOK[t.kind], half = (Math.max(look.w, look.long) * UNITS_PER_METER) / 2;
      const d = rayBox(origin, dir, [x - half, p.y, p.z - half], [x + half, p.y + look.h * UNITS_PER_METER, p.z + half]);
      if (d !== null && d <= maxDist && (!best || d < best.dist)) best = { id, dist: d };
    }
    return best;
  }

  get count(): number {
    return this.tracked.size;
  }

  private make(e: EntitySnapshot): Pick<Tracked, 'kind' | 'group' | 'body' | 'face' | 'figure' | 'color' | 'motion'> {
    const look = LOOK[e.kind];
    const group = new THREE.Group();
    group.name = `${e.kind} ${e.id}`;
    if (e.kind === 'player') {
      // A player: the mannequin, in their own colour, their name over their head.
      const color = playerColor(e.name ?? 'guest');
      const figure = new PlayerFigure(color);
      figure.root.traverse((o) => (o.userData.shared = true));
      group.add(figure.root);
      if (e.name) group.add(nameTag(e.name, FIGURE_HEIGHT + 0.3));
      this.scene.add(group);
      return { kind: e.kind, group, body: figure.material, face: figure.material, figure, color, motion: new FigureMotion(performance.now()) };
    }
    const body = new THREE.MeshBasicMaterial({ color: look.color });
    // The box (its length along -Z, the way it faces), standing on the ground.
    const box = new THREE.Mesh(new THREE.BoxGeometry(look.w, look.h, look.long), body);
    box.position.y = look.h / 2;
    // A darker block at the front, to see which way it faces.
    const faceMaterial = new THREE.MeshBasicMaterial({ color: 0x1b1b1b });
    const face = new THREE.Mesh(new THREE.BoxGeometry(look.w * 0.6, Math.min(0.3, look.h * 0.3), 0.08), faceMaterial);
    face.position.set(0, look.h * 0.82, -look.long / 2 - 0.04);
    group.add(box, face);
    this.scene.add(group);
    return { kind: e.kind, group, body, face: faceMaterial };
  }
}

/**
 * What a figure holds, for its hand (see PlayerFigure.hand: a bow in the left, anything else in the
 * right): the item's model, held in the fist; a tool by its handle, its head forward and up; a
 * block in the palm. (Its model comes a moment later if its icon's still being drawn.)
 */
export function heldModel(item: number, material: THREE.Material): THREE.Group {
  const hand = new THREE.Group();
  // (As the animations' grip for its kind says.)
  const grip = heldGrip(item);
  hand.position.set(...grip.at);
  hand.rotation.set(...grip.turn);
  hand.scale.setScalar(grip.scale);
  const put = (g: THREE.BufferGeometry) => {
    const mesh = new THREE.Mesh(g, material);
    mesh.userData.shared = true;
    hand.add(mesh);
  };
  const g = itemGeometry(item);
  if (g instanceof Promise) void g.then(put);
  else put(g);
  return hand;
}

/** How a thing's held (see the animations' grips): a bow, a block (or anything drawn as a cube), or anything else by its handle. */
export function heldGrip(item: number): Grip {
  return animations().grips[gripKind(item === Item.Bow, isCubeModel(item))];
}

/** A name over a player's head. */
function nameTag(name: string, y: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 48;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = 'white';
  g.font = '28px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(name.slice(0, 18), c.width / 2, c.height / 2);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: true }));
  sprite.scale.set(1.6, 0.3, 1);
  sprite.position.y = y;
  return sprite;
}
