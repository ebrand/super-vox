import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Material } from '@super-vox/shared';
import { rigAll } from './animalRig.js';
import { HABITS, MAX_GROUPS, WildAnimals, type WildWorld } from './wildAnimals.js';

(globalThis as { self?: unknown }).self ??= globalThis; // (the loader looks for it)
const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
const data = readFileSync(new URL('./models/animals.fbx', import.meta.url));
const models = rigAll(new FBXLoader().parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, ''));

/** Grass, flat at y 10, but a lake (x > 30) and a cliff (z > 40: 5 m up); `material` for all of it. */
function world(material: number = Material.Grass): WildWorld {
  return {
    groundAt: (x, z) => (x > 30 ? null : { y: z > 40 ? 15 : 10, leaves: false, material }),
    brightnessAt: () => 1,
  };
}
const eye = new THREE.Vector3(0, 11.6, 0);

describe('wild animals', () => {
  it('come in groups of kinds that live on the ground there, a few groups at a time', () => {
    const w = new WildAnimals(world(), models);
    for (let i = 0; i < 30; i++) w.spawn(eye);
    // (Spawn itself doesn't cap: update does. Every group: a grass kind.)
    for (const g of w.groups) expect(HABITS[g.kind].grounds).toContain(Material.Grass);
    expect(new Set(w.groups.map((g) => g.kind)).has('kangaroo')).toBe(false);
    const sand = new WildAnimals(world(Material.DesertSand), models);
    expect(sand.spawn(eye)?.kind).toBe('kangaroo');
    // Over time, by themselves: no more than MAX_GROUPS.
    const v = new WildAnimals(world(), models);
    for (let t = 0; t < 600; t++) v.update(0.1, eye);
    expect(v.groups.length).toBeGreaterThan(0);
    expect(v.groups.length).toBeLessThanOrEqual(MAX_GROUPS);
  });

  it('wander and graze on land they can walk: never into the lake, never up the cliff', () => {
    const w = new WildAnimals(world(), models);
    // (Watched from 45 m or more off, up on a hill: nothing scares them. Some groups by the lake and the cliff.)
    const from = new THREE.Vector3(0, 30, 0);
    w.enabled = false;
    for (let i = 0; i < 4; i++) w.spawn(from);
    for (const g of w.groups) for (const a of g.members) a.group.home.set(25, 10, 35);
    let walked = 0, grazed = 0;
    // (Some came in up on the cliff: they stay up there; the rest, down below.)
    const level = new Map(w.animals.map((a) => [a, a.pos.y]));
    for (let t = 0; t < 3000; t++) {
      w.update(0.1, from);
      for (const a of w.animals) {
        expect(a.pos.x, a.kind).toBeLessThanOrEqual(30 + 0.3);
        expect(Math.abs(a.pos.y - level.get(a)!), a.kind).toBeLessThan(0.5);
        if (a.speed > 0.2) walked++;
        if (a.graze > 0.9) grazed++;
      }
    }
    expect(w.groups.length).toBe(4); // (the same ones, all along)
    expect(walked).toBeGreaterThan(100);
    expect(grazed).toBeGreaterThan(100);
  });

  it('run off when you come near (a bear walks off), and go once left far behind', () => {
    const w = new WildAnimals(world(), models);
    const g = w.spawn(eye, 'horse')!;
    const horse = g.members[0]!, start = horse.pos.clone();
    // Right beside it.
    const by = horse.pos.clone().add(new THREE.Vector3(2, 1.6, 0));
    let fastest = 0;
    for (let t = 0; t < 30; t++) {
      w.update(0.1, by);
      fastest = Math.max(fastest, horse.speed);
    }
    expect(horse.state).toBe('flee');
    expect(fastest).toBeGreaterThan(2);
    expect(Math.hypot(horse.pos.x - by.x, horse.pos.z - by.z)).toBeGreaterThan(Math.hypot(start.x - by.x, start.z - by.z));
    // Its feet keep time: how far it's gone is how far its stride's turned.
    expect(horse.distance).toBeGreaterThan(1);
    // Gone, once you're far off.
    for (let t = 0; t < 5; t++) w.update(0.1, new THREE.Vector3(5000, 0, 5000));
    expect(w.groups.length).toBe(0);
    expect(w.group.children.length).toBe(0);
  });
});
