import * as THREE from 'three';
import { Material } from '@super-vox/shared';
import { ANIMAL_SPEC, AnimalFigure, type AnimalKind, type AnimalModel } from './animalRig.js';

/**
 * Wild animals about you (the game): a few groups at a time, each of a kind that lives on the
 * ground where it is (horses, cows, rams and pigs on grass; kangaroos on dry grass and sand; bears
 * and rams in the cold; cats, pigs and bears under the trees). Each group has a home it drifts
 * about; each animal grazes (head down) or stands a while, then walks to somewhere near home, and
 * runs off when you come close (a bear just ambles off). They keep to land they can walk: no
 * water, no treetops, no steps too high for them. Groups come in out of the way, and go once
 * you've left them far behind. Only here, for you: no one else sees the same ones (as the birds).
 */
export interface WildWorld {
  /** The top of the ground in the column at (x, z) (m) near height `y`: how high, whether it's leaves, and what it's made of; null: water, or nothing loaded. */
  groundAt(x: number, z: number, y: number): { y: number; leaves: boolean; material: number } | null;
  /** How lit it is at (x, y, z) (m): 0..1. */
  brightnessAt(x: number, y: number, z: number): number;
}

interface Habit {
  /** How many together, how far from you they run (m: 0 never), and what ground they live on. */
  group: [number, number];
  shy: number;
  grounds: readonly number[];
}

const GRASS = [Material.Grass, Material.Meadow];
const COLD = [Material.TaigaFloor, Material.Tundra, Material.Snow];
const FOREST = [Material.JungleFloor, Material.Dirt];
export const HABITS: Record<AnimalKind, Habit> = {
  horse: { group: [3, 6], shy: 12, grounds: [...GRASS, Material.DryGrass] },
  cow: { group: [3, 6], shy: 6, grounds: GRASS },
  ram: { group: [3, 7], shy: 10, grounds: [...GRASS, ...COLD] },
  pig: { group: [2, 4], shy: 8, grounds: [...GRASS, ...FOREST] },
  bear: { group: [1, 1], shy: 0, grounds: [...COLD, ...FOREST] },
  cat: { group: [1, 1], shy: 7, grounds: FOREST },
  kangaroo: { group: [2, 5], shy: 12, grounds: [Material.DryGrass, Material.DesertSand, Material.Sand] },
};

/** Groups about at once; where they come in (m from you), and how far off they go. */
export const MAX_GROUPS = 4;
const COME_NEAR = 35, COME_FAR = 70, GONE = 130;
/** How far from home they wander (m). */
const SPREAD = 10;

type State = 'stand' | 'graze' | 'walk' | 'flee';

export interface WildAnimal {
  kind: AnimalKind;
  figure: AnimalFigure;
  pos: THREE.Vector3;
  heading: number;
  speed: number;
  /** How far it's gone (m: its feet keep time), how far its head's down (0..1). */
  distance: number;
  graze: number;
  state: State;
  /** Where it's going; seconds left standing or grazing. */
  to: THREE.Vector3;
  timer: number;
  group: Group;
  litAt: number;
}

interface Group {
  kind: AnimalKind;
  home: THREE.Vector3;
  members: WildAnimal[];
}

const random = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

export class WildAnimals {
  readonly group = new THREE.Group();
  readonly groups: Group[] = [];
  enabled = true;
  private models: Map<AnimalKind, AnimalModel> | null = null;
  private nextGroupIn = 2;
  private time = 0;

  constructor(private readonly world: WildWorld, models: Promise<Map<AnimalKind, AnimalModel>> | Map<AnimalKind, AnimalModel>) {
    if (models instanceof Map) this.models = models;
    else void models.then((m) => (this.models = m)).catch((e) => console.warn('animals not loaded', e));
  }

  get animals(): WildAnimal[] {
    return this.groups.flatMap((g) => g.members);
  }

  /** Moves them on `dt` s, about `eye` (m). */
  update(dt: number, eye: THREE.Vector3): void {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    if (!this.models) return;
    // Groups left far behind go; a new one comes now and then.
    for (const g of [...this.groups]) if (g.members.every((a) => a.pos.distanceTo(eye) > GONE)) this.remove(g);
    this.nextGroupIn -= dt;
    if (this.nextGroupIn <= 0 && this.enabled) {
      this.nextGroupIn = random(8, 20);
      if (this.groups.length < MAX_GROUPS) this.spawn(eye);
    }
    for (const a of this.animals) this.step(a, dt, eye);
  }

  /** A group of whatever lives where it comes in, somewhere about you (if it finds anywhere). */
  spawn(eye: THREE.Vector3, kind?: AnimalKind): Group | null {
    for (let tries = 0; tries < 12; tries++) {
      const angle = Math.random() * Math.PI * 2, r = random(COME_NEAR, COME_FAR);
      const x = eye.x + Math.sin(angle) * r, z = eye.z + Math.cos(angle) * r;
      const ground = this.world.groundAt(x, z, eye.y);
      if (!ground || ground.leaves) continue;
      const kinds = (Object.keys(HABITS) as AnimalKind[]).filter((k) => (kind ? k === kind : HABITS[k].grounds.includes(ground.material)) && this.models!.has(k));
      if (!kinds.length) continue;
      const k = kinds[Math.floor(Math.random() * kinds.length)]!;
      const g: Group = { kind: k, home: new THREE.Vector3(x, ground.y, z), members: [] };
      const [lo, hi] = HABITS[k].group, count = lo + Math.floor(Math.random() * (hi - lo + 1));
      for (let i = 0; i < count; i++) {
        // (About home, on ground it can stand on.)
        for (let t = 0; t < 6; t++) {
          const ax = x + random(-4, 4), az = z + random(-4, 4), ag = this.world.groundAt(ax, az, ground.y);
          if (!ag || ag.leaves || Math.abs(ag.y - ground.y) > 2) continue;
          g.members.push(this.make(k, g, new THREE.Vector3(ax, ag.y, az)));
          break;
        }
      }
      if (!g.members.length) continue;
      this.groups.push(g);
      return g;
    }
    return null;
  }

  private make(kind: AnimalKind, group: Group, pos: THREE.Vector3): WildAnimal {
    const figure = new AnimalFigure(this.models!.get(kind)!);
    this.group.add(figure.root);
    const a: WildAnimal = { kind, figure, pos, heading: Math.random() * Math.PI * 2, speed: 0, distance: 0, graze: 0, state: 'graze', to: pos.clone(), timer: random(2, 10), group, litAt: -Infinity };
    this.place(a);
    return a;
  }

  private remove(g: Group): void {
    for (const a of g.members) {
      a.figure.root.removeFromParent();
      a.figure.dispose();
    }
    this.groups.splice(this.groups.indexOf(g), 1);
  }

  private step(a: WildAnimal, dt: number, eye: THREE.Vector3): void {
    const spec = ANIMAL_SPEC[a.kind], habit = HABITS[a.kind], near = Math.hypot(a.pos.x - eye.x, a.pos.z - eye.z);
    // Too near: off, away from you (a bear, if you're right by it, walks off).
    const shy = habit.shy || 4;
    if (near < shy && a.state !== 'flee') {
      const away = new THREE.Vector3(a.pos.x - eye.x, 0, a.pos.z - eye.z).normalize();
      a.to.copy(a.pos).addScaledVector(away, random(15, 25));
      a.state = 'flee';
      // (The group goes too: home's away from you now.)
      if (habit.shy) a.group.home.copy(a.to);
    }
    let want = 0;
    if (a.state === 'stand' || a.state === 'graze') {
      a.timer -= dt;
      if (a.timer <= 0) {
        // Somewhere near home (which drifts, now and then).
        if (Math.random() < 0.3) a.group.home.add(new THREE.Vector3(random(-6, 6), 0, random(-6, 6)));
        const r = Math.random() * SPREAD, angle = Math.random() * Math.PI * 2;
        a.to.set(a.group.home.x + Math.sin(angle) * r, a.pos.y, a.group.home.z + Math.cos(angle) * r);
        a.state = 'walk';
      }
    } else {
      const fleeing = a.state === 'flee' && habit.shy > 0;
      want = fleeing ? spec.trot : spec.walk;
      const d = Math.hypot(a.to.x - a.pos.x, a.to.z - a.pos.z);
      if (d < 0.5 || (a.state === 'flee' && near > shy * 2.5)) {
        a.state = Math.random() < 0.6 ? 'graze' : 'stand';
        a.timer = random(3, 15);
        want = 0;
      } else {
        // Turning toward it (a little at a time), going on as it faces it.
        const toward = Math.atan2(a.to.x - a.pos.x, a.to.z - a.pos.z);
        let turn = toward - a.heading;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        a.heading += Math.sign(turn) * Math.min(Math.abs(turn), dt * (fleeing ? 3 : 1.5));
        want *= Math.max(0, Math.cos(turn));
      }
    }
    // (Its head comes up to walk; goes down to graze; it slows and speeds up, not all at once.)
    a.graze += ((a.state === 'graze' ? 1 : 0) - a.graze) * Math.min(1, dt * (a.state === 'graze' ? 0.8 : 3));
    if (a.graze > 0.2 && want > 0) want *= 0.2;
    a.speed += (want - a.speed) * Math.min(1, dt * 2.5);
    if (a.speed > 0.01) this.move(a, dt);
    a.figure.pose({ speed: a.speed, distance: a.distance, graze: ANIMAL_SPEC[a.kind].plan === 'hop' ? 0 : a.graze, time: this.time + a.figure.model.length * 7 });
    this.place(a);
  }

  /** On, if it can go there: ground it stands on (not water, not treetops), no higher a step than its legs take; else it stops and thinks again. */
  private move(a: WildAnimal, dt: number): void {
    const step = a.speed * dt;
    let nx = a.pos.x + Math.sin(a.heading) * step, nz = a.pos.z + Math.cos(a.heading) * step;
    // (Looking a little ahead, its nose's way.)
    const ahead = 0.5 * a.figure.model.length;
    const g = this.world.groundAt(nx + Math.sin(a.heading) * ahead, nz + Math.cos(a.heading) * ahead, a.pos.y), here = this.world.groundAt(nx, nz, a.pos.y);
    const climb = Math.max(0.3, 0.55 * a.figure.model.legLength);
    if (!g || !here || g.leaves || here.leaves || Math.abs(g.y - a.pos.y) > climb || Math.abs(here.y - a.pos.y) > climb) {
      a.speed = 0;
      a.state = 'stand';
      a.timer = random(1, 4);
      return;
    }
    // Apart from the others a little.
    for (const o of a.group.members) {
      if (o === a) continue;
      const dx = nx - o.pos.x, dz = nz - o.pos.z, d = Math.hypot(dx, dz), room = 0.6 * (a.figure.model.length + o.figure.model.length) / 2;
      if (d < room && d > 1e-3) {
        nx += (dx / d) * (room - d) * 0.5 * Math.min(1, dt * 4);
        nz += (dz / d) * (room - d) * 0.5 * Math.min(1, dt * 4);
      }
    }
    a.pos.x = nx;
    a.pos.z = nz;
    a.pos.y += (here.y - a.pos.y) * Math.min(1, dt * 8);
    a.distance += step;
  }

  private place(a: WildAnimal): void {
    a.figure.root.position.copy(a.pos);
    a.figure.root.rotation.y = a.heading;
    // Lit as where it stands (looked at a few times a second): dark at night, in shade.
    if (this.time - a.litAt > 0.25) {
      a.litAt = this.time;
      a.figure.material.color.setHex(ANIMAL_SPEC[a.kind].color).multiplyScalar(this.world.brightnessAt(a.pos.x, a.pos.y + 0.5, a.pos.z));
    }
  }

  dispose(): void {
    for (const g of [...this.groups]) this.remove(g);
  }
}
