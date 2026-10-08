import * as THREE from 'three';
import { birdMesh } from './birds.js';

/**
 * Small birds about you (the game): a few at a time, each flitting from place to place in the
 * bounding way small birds fly (a few wingbeats up, a glide down), landing on the tops of trees
 * (or now and then on open ground), sitting a while (wings folded, turning about), then off again.
 * Now and then one leaves for good, flying off out of sight, and another comes in from afar. They
 * keep a little apart in the air, and one perched too near you takes off.
 */
export interface LocalBirdsWorld {
  /** The top of whatever's solid in the column at (x, z) (m), near height `y`: how high, and whether it's a tree's leaves; null: nothing near. */
  topAt(x: number, z: number, y: number): { y: number; leaves: boolean } | null;
  /** How bright it is (0..1). */
  brightness(): number;
}

/** How many about at once, and how far from you they keep (m). */
const COUNT = 5;
const RANGE = 40;
/** Wingspan (m), flying speed (m/s), and how near you they'll sit (m). */
const SPAN = 0.25;
const SPEED = 7;
const SHY = 4;

type State = 'flying' | 'perched' | 'leaving' | 'gone';

interface Bird {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  state: State;
  /** Where it's going (flying, leaving), or where it sits (perched). */
  to: THREE.Vector3;
  /** Seconds left perched; seconds until it next comes in (gone). */
  timer: number;
  /** Which way it faces sitting (radians), and its bounding flight's phase. */
  heading: number;
  bob: number;
}

const random = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

export class LocalBirds {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly flying: THREE.InstancedBufferAttribute;
  readonly birds: Bird[] = [];
  private time = 0;
  enabled = true;

  constructor(private readonly world: LocalBirdsWorld) {
    ({ mesh: this.mesh, material: this.material } = birdMesh(COUNT, 0x6b5a48));
    this.flying = this.mesh.geometry.getAttribute('flying') as THREE.InstancedBufferAttribute;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.group.add(this.mesh);
    // (They come in one by one, a few seconds apart.)
    for (let i = 0; i < COUNT; i++) this.birds.push({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), state: 'gone', to: new THREE.Vector3(), timer: random(1, 12), heading: 0, bob: Math.random() * 6 });
  }

  /** Moves them on `dt` s, about `eye` (m). */
  update(dt: number, eye: THREE.Vector3): void {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.material.uniforms.time!.value = this.time;
    this.material.uniforms.brightness!.value = this.world.brightness();
    for (const b of this.birds) this.step(b, dt, eye);
    this.draw();
  }

  private step(b: Bird, dt: number, eye: THREE.Vector3): void {
    if (b.state === 'gone') {
      b.timer -= dt;
      if (b.timer > 0 || !this.enabled) return;
      // In from afar, high, to somewhere about you.
      const a = Math.random() * Math.PI * 2;
      b.pos.set(eye.x + Math.sin(a) * RANGE * 1.5, eye.y + random(12, 25), eye.z + Math.cos(a) * RANGE * 1.5);
      b.vel.set(0, 0, 0);
      this.flyOn(b, eye);
      return;
    }
    if (b.state === 'perched') {
      b.timer -= dt;
      // Turns about now and then as it sits.
      if (Math.random() < dt * 0.6) b.heading += random(-1.2, 1.2);
      const near = b.pos.distanceTo(eye) < SHY;
      if (b.timer <= 0 || near) {
        // Off: on to somewhere else, or (now and then, or you're too near... it may stay about) away for good.
        b.vel.set(0, SPEED * 0.4, 0);
        if (!near && Math.random() < 0.25) this.leave(b, eye);
        else this.flyOn(b, eye);
      }
      return;
    }
    // Flying: toward where it's going, a little apart from the others, bounding.
    const want = b.to.clone().sub(b.pos);
    const dist = want.length();
    if (b.state === 'flying' && dist < 0.3) {
      b.pos.copy(b.to);
      b.vel.set(0, 0, 0);
      b.state = 'perched';
      b.timer = random(4, 20);
      return;
    }
    if (b.state === 'leaving' && b.pos.distanceTo(eye) > RANGE * 2) {
      b.state = 'gone';
      b.timer = random(5, 30);
      return;
    }
    // Slowing as it comes in to land.
    const speed = b.state === 'flying' ? Math.min(SPEED, 1 + dist * 1.5) : SPEED * 1.2;
    want.normalize().multiplyScalar(speed);
    for (const o of this.birds) {
      if (o === b || o.state === 'gone' || o.state === 'perched') continue;
      const d = b.pos.distanceTo(o.pos);
      if (d < 1.5 && d > 1e-3) want.add(b.pos.clone().sub(o.pos).multiplyScalar((1.5 - d) * 2));
    }
    // Bounding: a few wingbeats up, a glide down (not when landing).
    b.bob += dt * 2.2;
    if (dist > 3) want.y += Math.sin(b.bob) * 1.6;
    b.vel.lerp(want, Math.min(1, dt * 3));
    b.pos.addScaledVector(b.vel, dt);
  }

  /** Off somewhere about you: the top of a tree (most often) or open ground; else just round about. */
  private flyOn(b: Bird, eye: THREE.Vector3): void {
    b.state = 'flying';
    let ground: THREE.Vector3 | null = null;
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2, r = random(6, RANGE);
      const x = eye.x + Math.sin(a) * r, z = eye.z + Math.cos(a) * r;
      const top = this.world.topAt(x, z, eye.y);
      if (!top || Math.hypot(x - eye.x, z - eye.z) < SHY * 1.5) continue;
      if (top.leaves) {
        b.to.set(x, top.y + 0.05, z);
        return;
      }
      ground ??= new THREE.Vector3(x, top.y + 0.05, z);
    }
    if (ground && Math.random() < 0.6) {
      b.to.copy(ground);
      return;
    }
    // Nowhere to sit near: round about, and away.
    this.leave(b, eye);
  }

  private leave(b: Bird, eye: THREE.Vector3): void {
    b.state = 'leaving';
    const away = new THREE.Vector3(b.pos.x - eye.x, 0, b.pos.z - eye.z);
    if (away.lengthSq() < 1) away.set(1, 0, 0);
    away.normalize().multiplyScalar(RANGE * 3).add(b.pos);
    b.to.set(away.x, eye.y + random(15, 30), away.z);
  }

  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();

  private draw(): void {
    let n = 0;
    const fwd = new THREE.Vector3(0, 0, 1), dir = new THREE.Vector3(), scale = new THREE.Vector3().setScalar(SPAN);
    for (const b of this.birds) {
      if (b.state === 'gone') continue;
      const perched = b.state === 'perched';
      if (perched || b.vel.lengthSq() < 1e-4) this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, b.heading);
      else {
        dir.copy(b.vel).normalize();
        this.q.setFromUnitVectors(fwd, dir);
        b.heading = Math.atan2(dir.x, dir.z);
      }
      // (Sitting: on its feet, a little above where it sits.)
      const at = perched ? b.pos.clone().setY(b.pos.y + SPAN * 0.25) : b.pos;
      this.mesh.setMatrixAt(n, this.m.compose(at, this.q, scale));
      this.flying.setX(n, perched ? 0 : 1);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.flying.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
