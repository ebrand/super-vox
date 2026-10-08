import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FLAT_WORLD_16KM, Item, Material } from '@super-vox/shared';
import { ARROW_TIP, HeldItem, SWING_S } from './heldItem.js';
import { pixelModel } from './itemModels.js';
import { EntityView } from './entities.js';

const STILL = { dt: 0.016, speed: 0, draw: null, mining: false, brightness: 1 };

describe('item models from icons', () => {
  it("make each opaque pixel a voxel, its sides only where there's no neighbour", () => {
    const rgba = new Uint8ClampedArray(24 * 24 * 4);
    const opaque = (x: number, y: number) => rgba.set([200, 100, 50, 255], (y * 24 + x) * 4);
    opaque(3, 3);
    // One voxel: six faces (two triangles each, three corners a triangle).
    expect(pixelModel(rgba).getAttribute('position').count).toBe(6 * 6);
    // Two side by side: the faces between them gone (12 - 2).
    opaque(4, 3);
    expect(pixelModel(rgba).getAttribute('position').count).toBe(10 * 6);
    // Faint pixels (an outline's soft edge): left out.
    rgba.set([0, 0, 0, 40], (10 * 24 + 10) * 4);
    expect(pixelModel(rgba).getAttribute('position').count).toBe(10 * 6);
  });
});

describe('the hand', () => {
  it('swings when used, comes back, and swings on while mining', () => {
    const h = new HeldItem();
    h.setItem(Material.Stone);
    h.update(STILL);
    const rest = h.scene.children[0]!.rotation.x;
    h.swing();
    h.update({ ...STILL, dt: SWING_S / 2 });
    expect(h.scene.children[0]!.rotation.x).not.toBeCloseTo(rest);
    for (let i = 0; i < 10; i++) h.update({ ...STILL, dt: SWING_S / 4 });
    expect(h.scene.children[0]!.rotation.x).toBeCloseTo(rest);
    // Mining: never still for long.
    const seen = new Set<number>();
    for (let i = 0; i < 20; i++) {
      h.update({ ...STILL, dt: 0.05, mining: true });
      seen.add(Math.round(h.scene.children[0]!.rotation.x * 100));
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it('holds a bow close, an arrow on its string: drawn, the arrow comes back; let go, it snaps back, and the next is nocked a moment later', () => {
    const h = new HeldItem();
    h.setItem(Item.Bow);
    h.update({ ...STILL, draw: null });
    const root = h.scene.children[0]!.children[0]!;
    const arrow = root.children[2]!;
    expect(arrow.visible).toBe(true);
    const rest = arrow.position.x;
    // (Its string through the nock, where the arrow sits.)
    const string = root.children[1] as THREE.Line;
    expect(string.geometry.getAttribute('position').getX(1)).toBeCloseTo(rest);
    h.update({ ...STILL, draw: 1 });
    expect(arrow.position.x).toBeGreaterThan(rest + 0.2);
    expect(string.geometry.getAttribute('position').getX(1)).toBeCloseTo(arrow.position.x);
    // Let go: shot (no arrow on it), the string snapping back.
    h.update({ ...STILL, dt: 0.05, draw: null });
    expect(arrow.visible).toBe(false);
    for (let i = 0; i < 10; i++) h.update({ ...STILL, dt: 0.05, draw: null });
    expect(arrow.visible).toBe(true);
    expect(arrow.position.x).toBeCloseTo(rest);
    // Bobbing as you walk.
    const ys = new Set<number>();
    for (let i = 0; i < 30; i++) {
      h.update({ ...STILL, dt: 0.05, speed: 4.3, draw: null });
      ys.add(Math.round(h.scene.children[0]!.position.y * 1000));
    }
    expect(ys.size).toBeGreaterThan(5);
  });
});

describe('aiming the bow', () => {
  it("puts the arrow's tip on the crosshair (straight ahead of the eye), at rest, drawn and walking", () => {
    const h = new HeldItem();
    h.setItem(Item.Bow);
    for (const [draw, speed] of [[null, 0], [0.5, 0], [1, 0], [null, 4.3], [1, 4.3]] as const) {
      for (let i = 0; i < 20; i++) h.update({ ...STILL, dt: 0.05, draw, speed });
      h.scene.updateMatrixWorld(true);
      const arrow = h.scene.children[0]!.children[0]!.children[2]!;
      const tip = arrow.localToWorld(new THREE.Vector3(-ARROW_TIP, 0, 0));
      // (The hand's camera at the eye, looking along -z: the crosshair is the -z axis.)
      expect(Math.abs(tip.x)).toBeLessThan(1e-6);
      expect(Math.abs(tip.y)).toBeLessThan(1e-6);
      expect(tip.z).toBeLessThan(-0.3);
    }
  });
});

describe("other players' hands", () => {
  it('hold what they hold in the right hand (a bow in the left), and swing that arm when they swing', () => {
    // (No names: a name tag needs a page to draw on.)
    const scene = new THREE.Scene();
    const view = new EntityView(scene, FLAT_WORLD_16KM, () => 0);
    view.update([{ id: 1, kind: 'player', x: 0, y: 0, z: 0, yaw: 0, held: Material.Stone, swings: 3 }], 0);
    const ann = scene.children.find((c) => c.name === 'player 1')!;
    const joint = (name: string) => ann.getObjectByName(name)!;
    const held = (name: string) => joint(name).children.filter((c) => !c.name.endsWith(' part'));
    expect(held('wristR')).toHaveLength(1);
    expect(held('wristL')).toHaveLength(0);
    view.frame(10);
    const rest = joint('shoulderR').rotation.x;
    view.update([{ id: 1, kind: 'player', x: 0, y: 0, z: 0, yaw: 0, held: Material.Stone, swings: 4 }], 100);
    view.frame(100 + SWING_S * 1000 * 0.35);
    expect(joint('shoulderR').rotation.x).toBeGreaterThan(rest + 1.5); // raised to chop
    // A bow: in the left hand. Put away: nothing in either.
    view.update([{ id: 1, kind: 'player', x: 0, y: 0, z: 0, yaw: 0, held: Item.Bow, swings: 4 }], 200);
    expect([held('wristL').length, held('wristR').length]).toEqual([1, 0]);
    view.update([{ id: 1, kind: 'player', x: 0, y: 0, z: 0, yaw: 0, swings: 4 }], 300);
    expect([held('wristL').length, held('wristR').length]).toEqual([0, 0]);
  });
});
