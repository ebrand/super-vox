import * as THREE from 'three';
import { SKEIN_SHAPES, Skein, skeinSettings, type SkeinShape } from '@super-vox/shared';

/**
 * Birds crossing the terraformer's close-up. Most often a migrating flock: 20-110 of them, in
 * groups flying as Vs, Js, echelons or single file (see Skein; one shape each time, or each group
 * its own); now and then (FEW_CHANCE) just a bird, or a loose few, lower and less in order. They
 * come in from beyond one side of the view, cross it by a bending route, and fly out the other,
 * each bird drifting about its place and flapping at its own pace, their shadows on the ground.
 * Sized for the view so they show (a real bird would be a speck from where a 2 km area is seen).
 */
export interface BirdsView {
  /** The ground's height (metres) under (x, z), null where there's none. */
  groundAt(x: number, z: number): number | null;
  /** Toward the sun (unit). */
  sunDir(): THREE.Vector3;
  /** What the view looks at, and from how far. */
  target(): THREE.Vector3;
  distance(): number;
  /** The area's size (metres). */
  areaSize(): number;
  /**
   * In the game, real birds (unset: sized for a far view, as the terraformer's): their wingspan
   * (m), how high flocks fly over the ground (m, at random within), and how long one takes to
   * cross the view (s).
   */
  real?: { span: number; height: readonly [number, number]; crossing: number };
  /** How bright it is (0..1: night dims them); unset, full. */
  brightness?(): number;
}

/**
 * The bird drawn by Birds (and the game's nearby birds, see localBirds.ts): an instanced mesh of up to
 * `max`, a unit across, facing +z, flapping (each its own pace: the instance attributes phase and
 * rate) unless folded (flying 0: perched), coloured `color`, as bright as the uniform says.
 */
export function birdMesh(max: number, color = 0xffffff): { mesh: THREE.InstancedMesh; material: THREE.ShaderMaterial } {
  // A bird a unit across, facing +z: a thin body and two wings, swept back (flapped in the shader).
  const g = new THREE.BufferGeometry();
  // prettier-ignore
  const v = [
    // left wing: shoulder front, shoulder back, tip
    0, 0, 0.12, 0, 0, -0.08, -0.5, 0, -0.12,
    // right wing
    0, 0, 0.12, 0.5, 0, -0.12, 0, 0, -0.08,
    // body (a sliver, nose to tail)
    -0.03, 0, 0.22, 0.03, 0, 0.22, 0, 0, -0.25,
  ];
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  const material = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, color: { value: new THREE.Color(color) }, brightness: { value: 1 } },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float phase;
      attribute float rate;
      attribute float flying;
      uniform float time;
      varying float vLight;
      void main() {
        vec3 p = position;
        // Wings up and down (tips the most), each bird at its own pace; now and then a glide.
        // Perched: folded along its back.
        float glide = smoothstep(0.6, 0.9, sin(time * 0.35 * rate + phase * 1.7));
        float f = sin(time * rate + phase) * (1.0 - 0.8 * glide) * flying;
        p.x *= mix(0.12, 1.0, flying);
        p.y += f * abs(p.x) * 0.8 + (1.0 - flying) * abs(p.x) * 0.6;
        vLight = 0.82 + 0.18 * f;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform vec3 color;
      uniform float brightness;
      varying float vLight;
      void main() {
        #include <logdepthbuf_fragment>
        gl_FragColor = vec4(color * vLight * brightness, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.InstancedMesh(g, material, max);
  const phase = new Float32Array(max), rate = new Float32Array(max), flying = new Float32Array(max).fill(1);
  for (let i = 0; i < max; i++) {
    phase[i] = Math.random() * Math.PI * 2;
    rate[i] = random(8, 13);
  }
  g.setAttribute('phase', new THREE.InstancedBufferAttribute(phase, 1));
  g.setAttribute('rate', new THREE.InstancedBufferAttribute(rate, 1));
  g.setAttribute('flying', new THREE.InstancedBufferAttribute(flying, 1));
  return { mesh, material };
}

/** Seconds between flocks (one ends, the next comes this long after), at random within this. */
const BETWEEN: readonly [number, number] = [20, 60];
/** About how long a flock takes to cross the view (seconds). */
const CROSSING = 24;
const MAX_BIRDS = 110;
/** How often a crossing is a lone bird or a loose few (2-5) rather than a flock; they come sooner after. */
const FEW_CHANCE = 0.35;
const FEW_BETWEEN: readonly [number, number] = [8, 30];

/** One V of a flock: its skein, where it flies relative to the route, and how far along the route it is. */
interface Vee {
  skein: Skein;
  /** Off to the route's side, and above it (metres). */
  side: number;
  up: number;
  next: number;
}

interface Crossing {
  vees: Vee[];
  /** Waypoints: in from beyond one side of the view, through a point near its middle, out beyond the other. */
  route: THREE.Vector3[];
  /** How near a waypoint counts as there. */
  near: number;
  span: number;
  age: number;
  /** A lone bird or a few, not a flock. */
  few: boolean;
}

const random = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

export class Birds {
  readonly group = new THREE.Group();
  private readonly birds: THREE.InstancedMesh;
  private readonly shadows: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;
  private crossing: Crossing | null = null;
  /** Seconds until the next flock. */
  private wait = 4;
  private time = 0;
  enabled = true;

  constructor(private readonly view: BirdsView) {
    ({ mesh: this.birds, material: this.material } = birdMesh(MAX_BIRDS));
    // Shadows: soft dark ovals on the ground, stretched away from the sun when it's low.
    const disc = new THREE.CircleGeometry(0.5, 12).rotateX(-Math.PI / 2);
    this.shadows = new THREE.InstancedMesh(
      disc,
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
      MAX_BIRDS,
    );
    for (const m of [this.birds, this.shadows]) {
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
    }
  }

  /** Moves the birds on `dt` seconds; a new flock comes when it's time. */
  update(dt: number): void {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.material.uniforms.time!.value = this.time;
    this.material.uniforms.brightness!.value = this.view.brightness?.() ?? 1;
    if (!this.crossing) {
      this.wait -= dt;
      if (this.wait <= 0 && this.enabled) this.crossing = this.spawn();
    }
    const c = this.crossing;
    if (c) {
      c.age += dt;
      for (const v of c.vees) {
        if (v.next >= c.route.length) continue;
        const goal = this.goal(c, v);
        const k = v.skein;
        // (In steps of at most 1/30 s.)
        const steps = Math.ceil(dt * 30);
        for (let s = 0; s < steps; s++) k.step(dt / steps, goal);
        if (Math.hypot(k.pos[0]! - goal[0], k.pos[2]! - goal[2]) < c.near) v.next++;
      }
      if (c.vees.every((v) => v.next >= c.route.length) || c.age > (this.view.real?.crossing ?? CROSSING) * 3 || !this.enabled) {
        const [lo, hi] = c.few ? FEW_BETWEEN : BETWEEN;
        this.crossing = null;
        this.wait = random(lo, hi);
      }
    }
    this.draw();
  }

  /** Where a V makes for now: its next waypoint, off to its side of the route and above it. */
  private goal(c: Crossing, v: Vee): [number, number, number] {
    const at = c.route[v.next]!, from = c.route[Math.max(0, v.next - 1)]!;
    const dx = at.x - from.x, dz = at.z - from.z, d = Math.hypot(dx, dz) || 1;
    return [at.x + (-dz / d) * v.side, at.y + v.up, at.z + (dx / d) * v.side];
  }

  /**
   * A flock coming in from beyond one side of the view, making for beyond the other by a bending
   * route, its height changing along the way: a few Vs of a dozen to thirty, each its own way off
   * the route and a little behind the one before.
   */
  private spawn(): Crossing {
    const target = this.view.target(), area = this.view.areaSize();
    const reach = Math.min(area * 1.2, Math.max(area * 0.3, this.view.distance() * 0.7));
    // (Sized by how far off the view is: a few pixels across, a flock you can see.)
    const real = this.view.real;
    const span = real ? real.span : Math.min(30, Math.max(0.5, this.view.distance() / 150));
    const angle = Math.random() * Math.PI * 2, dir = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
    const side = new THREE.Vector3(dir.z, 0, -dir.x);
    // A lone bird or a few: lower, slower, wandering more, loosely together.
    const few = Math.random() < FEW_CHANCE;
    const clearance = real ? random(real.height[0], real.height[1]) * (few ? 0.4 : 1) : reach * (few ? random(0.015, 0.035) : 0.05);
    const groundAt = (p: THREE.Vector3) => this.view.groundAt(p.x, p.z) ?? this.view.groundAt(target.x, target.z) ?? target.y;
    const point = (along: number, across: number) => {
      const p = target.clone().addScaledVector(dir, along * reach).addScaledVector(side, across * reach);
      p.y = groundAt(p) + clearance * random(1, 2.2);
      return p;
    };
    const bend = few ? 1.6 : 1;
    const route = [point(-1.3, random(-0.5, 0.5)), point(random(-0.2, 0.2), random(-0.45, 0.45) * bend), point(1.7, random(-0.6, 0.6) * bend)];
    const speed = ((reach * 3) / (real?.crossing ?? CROSSING)) * (few ? 0.75 : 1);
    const settings = skeinSettings(span, speed);
    settings.turnRate = Math.max(0.2, (2 * speed) / reach);
    settings.climbRate = speed * 0.2;
    // How many this time, in what: one shape for them all (V most often), or each group its own.
    const pick = (): SkeinShape => (Math.random() < 0.4 ? 'v' : SKEIN_SHAPES[Math.floor(Math.random() * SKEIN_SHAPES.length)]!);
    const mixed = Math.random() < 0.15, shape = pick();
    const vees: Vee[] = [];
    if (few) {
      // (One group: no formation to speak of, each well off its place and drifting widely.)
      const n = Math.random() < 0.4 ? 1 : Math.floor(random(2, 6));
      const start = route[0]!.clone();
      const heading = Math.atan2(route[1]!.x - start.x, route[1]!.z - start.z);
      const skein = new Skein(n, { ...settings, shape: 'line', speed: speed * random(0.9, 1.1), spread: random(0.8, 1), spacing: settings.spacing * random(2, 3.5), wobble: settings.wobble * 3 }, [start.x, start.y, start.z], heading);
      vees.push({ skein, side: 0, up: 0, next: 1 });
      return { vees, route, near: reach * 0.25, span, age: 0, few };
    }
    let left = Math.floor(random(20, MAX_BIRDS + 1));
    while (left > 0) {
      // (Never a straggler group of one or two: what's left joins the last.)
      let n = Math.min(left, Math.floor(random(8, 36)));
      if (left - n < 5) n = left;
      left -= n;
      const k = vees.length, start = route[0]!.clone().addScaledVector(dir, -k * span * random(14, 24)).addScaledVector(side, random(-1, 1) * span * 20);
      const heading = Math.atan2(route[1]!.x - start.x, route[1]!.z - start.z) + random(-0.2, 0.2);
      const skein = new Skein(n, { ...settings, shape: mixed ? pick() : shape, speed: speed * random(0.92, 1.08), spread: random(0.4, 0.8), spacing: settings.spacing * random(0.85, 1.25) }, [start.x, start.y, start.z], heading);
      vees.push({ skein, side: random(-1, 1) * span * 25, up: random(-0.3, 0.6) * clearance, next: 1 });
    }
    return { vees, route, near: reach * 0.25, span, age: 0, few };
  }

  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly fwd = new THREE.Vector3(0, 0, 1);

  private draw(): void {
    const c = this.crossing;
    let n = 0;
    if (c) for (const v of c.vees) n += v.skein.count;
    this.birds.count = this.shadows.count = n;
    if (!c) return;
    const sun = this.view.sunDir(), sunUp = Math.max(0.15, sun.y);
    // Shadows lie away from the sun, longer the lower it is.
    const stretch = Math.min(3, 1 / sunUp), sunAngle = Math.atan2(sun.x, sun.z);
    const pos = new THREE.Vector3(), dir = new THREE.Vector3(), scale = new THREE.Vector3();
    let i = 0;
    for (const vee of c.vees) {
      const p = vee.skein.pos, v = vee.skein.vel;
      for (let j = 0; j < vee.skein.count; j++, i++) {
        pos.set(p[j * 3]!, p[j * 3 + 1]!, p[j * 3 + 2]!);
        dir.set(v[j * 3]!, v[j * 3 + 1]!, v[j * 3 + 2]!).normalize();
        this.q.setFromUnitVectors(this.fwd, dir);
        this.birds.setMatrixAt(i, this.m.compose(pos, this.q, scale.setScalar(c.span)));
        // Where its shadow falls: down along the sun's rays to the ground (twice, for slopes).
        let gx = pos.x, gz = pos.z, gy = this.view.groundAt(gx, gz);
        for (let k = 0; k < 2 && gy !== null; k++) {
          const t = (pos.y - gy) / sunUp;
          gx = pos.x - sun.x * t;
          gz = pos.z - sun.z * t;
          gy = this.view.groundAt(gx, gz) ?? gy;
        }
        if (gy === null) {
          this.shadows.setMatrixAt(i, this.m.makeScale(0, 0, 0));
          continue;
        }
        this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, sunAngle);
        this.shadows.setMatrixAt(i, this.m.compose(pos.set(gx, gy + 0.05, gz), this.q, scale.set(c.span * 0.7, 1, c.span * 0.7 * stretch)));
      }
    }
    this.birds.instanceMatrix.needsUpdate = true;
    this.shadows.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.birds.geometry.dispose();
    this.material.dispose();
    this.shadows.geometry.dispose();
    (this.shadows.material as THREE.Material).dispose();
  }
}
