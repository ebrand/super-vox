import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FLAT_WORLD_16KM, Item, Material } from '@super-vox/shared';
import { HeldItem, SWING_S } from './heldItem.js';
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

describe("other players' hands", () => {
  it('hold what they hold (at their side), and swing it when they swing', () => {
    // (No names: a name tag needs a page to draw on.)
    const scene = new THREE.Scene();
    const view = new EntityView(scene, FLAT_WORLD_16KM, () => 0);
    view.update([{ id: 1, kind: 'player', x: 0, y: 0, z: 0, yaw: 0, held: Material.Stone, swings: 3 }], 0);
    const ann = scene.children.find((c) => c.name === 'player 1')!;
    const hand = ann.children.find((c) => c instanceof THREE.Group && c.children.length === 1)!;
    expect(hand).toBeDefined();
    expect(hand.position.x).toBeGreaterThan(0.3);
    view.frame(10);
    expect(hand.rotation.x).toBeCloseTo(0);
    view.update([{ id: 1, kind: 'player', x: 0, y: 0, z: 0, yaw: 0, held: Material.Stone, swings: 4 }], 100);
    view.frame(100 + (SWING_S * 1000) / 2);
    expect(hand.rotation.x).toBeLessThan(-0.5);
    // Put away: nothing in hand.
    view.update([{ id: 1, kind: 'player', x: 0, y: 0, z: 0, yaw: 0, swings: 4 }], 200);
    expect(ann.children.includes(hand)).toBe(false);
  });
});
