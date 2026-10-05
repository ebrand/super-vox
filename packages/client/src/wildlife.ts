import * as THREE from 'three';
import { Cover } from './terraformArea.js';

/**
 * Animals about the close-up's forests (see Diorama), real size: deer in small herds grazing along
 * the forest's edges and in clearings, wild boar in groups rooting about right at its edge, rabbits
 * hopping about near it. They keep to open ground (under the trees they'd be hidden by the crowns)
 * but go in among the trees walking and running. Each group has a home it drifts about; each animal grazes (head
 * down) a while, then walks to a new spot near home on ground it likes, and runs (deer and rabbits
 * away from it, boar too) when the camera comes close. They live around where the view looks,
 * coming and going as it moves, and only once it's close enough to see them.
 */
export interface WildlifeView {
  /** The ground's height (metres) at (x, z), null outside the area. */
  groundAt(x: number, z: number): number | null;
  /** What the ground at (x, z) is to animals (see Cover), null outside the area. */
  coverAt(x: number, z: number): number | null;
  /** Where the view looks (metres) and the camera is, and how far apart. */
  target(): THREE.Vector3;
  camera(): THREE.Vector3;
  /** Toward the sun (unit). */
  sunDir(): THREE.Vector3;
}

export type Species = 'deer' | 'boar' | 'rabbit';
export const SPECIES: readonly Species[] = ['deer', 'boar', 'rabbit'];

interface SpeciesSpec {
  /** Body width, height and length, its height off the ground (legs), and its head's size (m). */
  body: [number, number, number];
  legs: number;
  head: number;
  color: number;
  /** Walking and running speeds (m/s), and how far from the camera it runs (m). */
  walk: number;
  run: number;
  shy: number;
  /** Group sizes, how far from home they wander (m), and how many groups per km² around the view. */
  group: [number, number];
  spread: number;
  perKm2: number;
  /** Where it lives: open ground no further than this from the forest (m). */
  edge: number;
  /** Moves in hops. */
  hops?: boolean;
}

export const SPECIES_SPEC: Record<Species, SpeciesSpec> = {
  deer: { body: [0.42, 0.55, 1.2], legs: 0.75, head: 0.32, color: 0x8b5a2b, walk: 0.8, run: 7, shy: 40, group: [3, 7], spread: 12, perKm2: 6, edge: 20 },
  boar: { body: [0.45, 0.5, 1.0], legs: 0.3, head: 0.34, color: 0x3d3128, walk: 0.5, run: 4.5, shy: 18, group: [2, 5], spread: 8, perKm2: 5, edge: 6 },
  rabbit: { body: [0.16, 0.16, 0.3], legs: 0.06, head: 0.13, color: 0x9a8a76, walk: 0.9, run: 5, shy: 14, group: [1, 2], spread: 5, perKm2: 30, edge: 12, hops: true },
};

/** Beyond this camera distance (m) from what it looks at, none are about (they'd be specks). */
export const SHOW_DISTANCE = 1500;
/** Most animals at once. */
export const MAX_ANIMALS = 400;

export interface Animal {
  x: number;
  y: number;
  z: number;
  /** Facing (radians: 0 along +z). */
  yaw: number;
  state: 'graze' | 'walk' | 'run';
  /** Seconds left in this state; where it's walking or running to. */
  left: number;
  gx: number;
  gz: number;
  /** Head: 0 up .. 1 down (grazing); a bit of variety in its colour; its pace. */
  head: number;
  tone: number;
  phase: number;
}

export interface Group {
  species: Species;
  /** Where it keeps to (it drifts now and then). */
  hx: number;
  hz: number;
  /** Seconds until home drifts. */
  drift: number;
  animals: Animal[];
}

/** The simulation (no drawing): groups of animals living around the view. */
export class WildlifeSim {
  readonly groups: Group[] = [];
  enabled = true;
  private spawnClock = 0;

  constructor(
    private readonly view: Pick<WildlifeView, 'groundAt' | 'coverAt' | 'target' | 'camera'>,
    private readonly random: () => number = Math.random,
  ) {}

  get count(): number {
    let n = 0;
    for (const g of this.groups) n += g.animals.length;
    return n;
  }

  /** Whether `species` would live at (x, z): open ground with the forest within its edge distance. */
  likes(species: Species, x: number, z: number): boolean {
    if (this.view.coverAt(x, z) !== Cover.Open) return false;
    const e = SPECIES_SPEC[species].edge;
    for (const d of [e / 3, (2 * e) / 3, e])
      for (const [dx, dz] of [[d, 0], [-d, 0], [0, d], [0, -d], [d * 0.7, d * 0.7], [-d * 0.7, d * 0.7], [d * 0.7, -d * 0.7], [-d * 0.7, -d * 0.7]] as const)
        if (this.view.coverAt(x + dx, z + dz) === Cover.Forest) return true;
    return false;
  }

  /** Whether an animal can go to (x, z) at all: anywhere but water, sand, rock and snow (in among the trees too). */
  private canStand(x: number, z: number): boolean {
    const c = this.view.coverAt(x, z);
    return c !== null && c !== Cover.None;
  }

  /** How far around the view animals live (m), by how far off it's seen. */
  radius(): number {
    const d = this.view.camera().distanceTo(this.view.target());
    return Math.max(120, Math.min(700, d * 1.2));
  }

  update(dt: number): void {
    dt = Math.min(dt, 0.1);
    const target = this.view.target(), cam = this.view.camera();
    const far = cam.distanceTo(target) > SHOW_DISTANCE;
    const R = this.radius();
    // Those left far behind go.
    for (let i = this.groups.length - 1; i >= 0; i--) {
      const g = this.groups[i]!;
      if (far || !this.enabled || Math.hypot(g.hx - target.x, g.hz - target.z) > R * 1.4) this.groups.splice(i, 1);
    }
    if (far || !this.enabled) return;
    // New ones (a few tries a second) where there are fewer than there'd be.
    this.spawnClock -= dt;
    if (this.spawnClock <= 0) {
      this.spawnClock = 0.25;
      // (Edges are narrow: many spots looked at, few kept; a group at most each time.)
      for (let k = 0; k < 20; k++) if (this.trySpawn(target, R)) break;
    }
    for (const g of this.groups) this.step(g, dt, cam);
  }

  /** A group somewhere in the disc of radius R around the view, if a kind there is short of its number and likes the spot: true if one came. */
  private trySpawn(target: THREE.Vector3, R: number): boolean {
    if (this.count >= MAX_ANIMALS) return false;
    const areaKm2 = (Math.PI * R * R) / 1e6;
    const short = SPECIES.filter((s) => this.groups.filter((g) => g.species === s).length < Math.max(1, Math.round(SPECIES_SPEC[s].perKm2 * areaKm2)));
    if (!short.length) return false;
    const species = short[Math.floor(this.random() * short.length)]!;
    const a = this.random() * Math.PI * 2, r = R * Math.sqrt(this.random());
    const hx = target.x + Math.sin(a) * r, hz = target.z + Math.cos(a) * r;
    if (!this.likes(species, hx, hz)) return false;
    const spec = SPECIES_SPEC[species];
    const n = spec.group[0] + Math.floor(this.random() * (spec.group[1] - spec.group[0] + 1));
    const animals: Animal[] = [];
    for (let i = 0; i < n * 3 && animals.length < n; i++) {
      const x = hx + (this.random() - 0.5) * spec.spread, z = hz + (this.random() - 0.5) * spec.spread;
      const y = this.view.groundAt(x, z);
      if (y === null || !this.likes(species, x, z)) continue;
      animals.push({ x, y, z, yaw: this.random() * Math.PI * 2, state: 'graze', left: this.random() * 8, gx: x, gz: z, head: this.random(), tone: 0.85 + this.random() * 0.3, phase: this.random() * 10 });
    }
    if (!animals.length) return false;
    this.groups.push({ species, hx, hz, drift: 20 + this.random() * 40, animals });
    return true;
  }

  private step(g: Group, dt: number, cam: THREE.Vector3): void {
    const spec = SPECIES_SPEC[g.species];
    // Home drifts now and then, somewhere near it they like.
    g.drift -= dt;
    if (g.drift <= 0) {
      g.drift = 20 + this.random() * 40;
      const a = this.random() * Math.PI * 2, x = g.hx + Math.sin(a) * spec.spread * 2, z = g.hz + Math.cos(a) * spec.spread * 2;
      if (this.likes(g.species, x, z)) [g.hx, g.hz] = [x, z];
    }
    for (const an of g.animals) {
      an.phase += dt;
      // Too near the camera: off, away from it.
      const dc = Math.hypot(an.x - cam.x, an.y - cam.y, an.z - cam.z);
      if (dc < spec.shy && an.state !== 'run') {
        const dx = an.x - cam.x, dz = an.z - cam.z, d = Math.hypot(dx, dz) || 1;
        an.state = 'run';
        an.left = 3 + this.random() * 3;
        an.gx = an.x + (dx / d) * spec.shy * 1.5;
        an.gz = an.z + (dz / d) * spec.shy * 1.5;
      }
      an.left -= dt;
      if (an.state === 'graze') {
        an.head = Math.min(1, an.head + dt * 1.5);
        if (an.left <= 0) {
          // A new spot near home it likes (or stay put a while longer).
          const x = g.hx + (this.random() - 0.5) * spec.spread * 2, z = g.hz + (this.random() - 0.5) * spec.spread * 2;
          if (this.likes(g.species, x, z)) {
            an.state = 'walk';
            [an.gx, an.gz] = [x, z];
            an.left = 30;
          } else an.left = 2 + this.random() * 4;
        }
        continue;
      }
      an.head = Math.max(0, an.head - dt * 3);
      const speed = an.state === 'run' ? spec.run : spec.walk;
      const dx = an.gx - an.x, dz = an.gz - an.z, d = Math.hypot(dx, dz);
      if (d < 0.3 || an.left <= 0) {
        an.state = 'graze';
        an.left = 4 + this.random() * 10;
        continue;
      }
      // (Hoppers go in bursts: a hop, a pause.)
      const pace = spec.hops ? Math.max(0, Math.sin(an.phase * (an.state === 'run' ? 9 : 5))) * 1.6 : 1;
      const stepLen = Math.min(d, speed * pace * dt);
      const nx = an.x + (dx / d) * stepLen, nz = an.z + (dz / d) * stepLen;
      if (!this.canStand(nx, nz)) {
        // Can't go on that way (water, rock, out of its ground): stop and think again.
        an.state = 'graze';
        an.left = 1 + this.random() * 3;
        continue;
      }
      an.x = nx;
      an.z = nz;
      an.y = this.view.groundAt(nx, nz) ?? an.y;
      // Turn toward the way it's going, not all at once.
      const want = Math.atan2(dx, dz);
      let turn = want - an.yaw;
      turn = ((((turn + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
      an.yaw += turn * Math.min(1, dt * 6);
    }
  }
}

/** A box (width, height, length) centred at (x, y, z), into `out` (positions and normals). */
function box(out: { p: number[]; n: number[] }, w: number, h: number, l: number, x: number, y: number, z: number): void {
  const g = new THREE.BoxGeometry(w, h, l).translate(x, y, z).toNonIndexed();
  out.p.push(...(g.getAttribute('position').array as Float32Array));
  out.n.push(...(g.getAttribute('normal').array as Float32Array));
  g.dispose();
}

/** A species' body (on its legs, facing +z, standing at the origin) and head (its neck at the origin, facing +z). */
function speciesGeometry(spec: SpeciesSpec): { body: THREE.BufferGeometry; head: THREE.BufferGeometry } {
  const [w, h, l] = spec.body;
  const b = { p: [] as number[], n: [] as number[] };
  box(b, w, h, l, 0, spec.legs + h / 2, 0);
  const leg = Math.min(w, l) * 0.22;
  if (spec.legs > 0.1) for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(b, leg, spec.legs, leg, (sx * (w - leg)) / 2, spec.legs / 2, (sz * (l - leg * 2)) / 2);
  const hd = { p: [] as number[], n: [] as number[] };
  const s = spec.head;
  box(hd, s * 0.8, s * 0.8, s * 1.2, 0, 0, s * 0.6);
  const make = (o: { p: number[]; n: number[] }) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(o.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(o.n, 3));
    return g;
  };
  return { body: make(b), head: make(hd) };
}

/** Lit by the sun and the sky, in its species' colour, each a little lighter or darker. */
function animalMaterial(color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, sunDir: { value: new THREE.Vector3(0, 1, 0) } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float tone;
      uniform vec3 sunDir;
      varying float vLight;
      void main() {
        vec3 n = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vLight = tone * (0.5 + 0.6 * max(dot(n, sunDir), 0.0) + 0.1 * n.y);
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform vec3 color;
      varying float vLight;
      void main() {
        #include <logdepthbuf_fragment>
        gl_FragColor = vec4(color * vLight, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}

/** The animals, drawn: per species a body and a head (instanced), and soft shadows under them all. */
export class Wildlife {
  readonly group = new THREE.Group();
  readonly sim: WildlifeSim;
  private readonly meshes: Record<Species, { body: THREE.InstancedMesh; head: THREE.InstancedMesh; tone: THREE.InstancedBufferAttribute; material: THREE.ShaderMaterial }>;
  private readonly shadows: THREE.InstancedMesh;

  constructor(private readonly view: WildlifeView) {
    this.sim = new WildlifeSim(view);
    const meshes = {} as typeof this.meshes;
    for (const s of SPECIES) {
      const { body, head } = speciesGeometry(SPECIES_SPEC[s]);
      const material = animalMaterial(SPECIES_SPEC[s].color);
      const tone = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ANIMALS).fill(1), 1);
      body.setAttribute('tone', tone);
      head.setAttribute('tone', tone);
      const m = { body: new THREE.InstancedMesh(body, material, MAX_ANIMALS), head: new THREE.InstancedMesh(head, material, MAX_ANIMALS), tone, material };
      for (const x of [m.body, m.head]) {
        x.count = 0;
        x.frustumCulled = false;
        this.group.add(x);
      }
      meshes[s] = m;
    }
    this.meshes = meshes;
    const disc = new THREE.CircleGeometry(0.5, 10).rotateX(-Math.PI / 2);
    this.shadows = new THREE.InstancedMesh(
      disc,
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
      MAX_ANIMALS,
    );
    this.shadows.count = 0;
    this.shadows.frustumCulled = false;
    this.group.add(this.shadows);
  }

  set enabled(on: boolean) {
    this.sim.enabled = on;
  }

  update(dt: number): void {
    this.sim.update(dt);
    this.draw();
  }

  private readonly m = new THREE.Matrix4();
  private readonly n = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();

  private draw(): void {
    const sun = this.view.sunDir();
    const counts: Record<Species, number> = { deer: 0, boar: 0, rabbit: 0 };
    let shadows = 0;
    const pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), flat = new THREE.Vector3();
    for (const g of this.sim.groups) {
      const spec = SPECIES_SPEC[g.species], mesh = this.meshes[g.species];
      for (const a of g.animals) {
        const i = counts[g.species]++;
        // A hop (hoppers on the move); a little bob walking.
        const moving = a.state !== 'graze';
        const lift = spec.hops && moving ? Math.max(0, Math.sin(a.phase * (a.state === 'run' ? 9 : 5))) * spec.body[1] * 1.2 : moving ? Math.abs(Math.sin(a.phase * 8)) * 0.03 : 0;
        this.q.setFromEuler(this.e.set(0, a.yaw, 0));
        mesh.body.setMatrixAt(i, this.m.compose(pos.set(a.x, a.y + lift, a.z), this.q, one));
        // The head at the front, on its neck: up, or dipped to the ground grazing.
        const [, h, l] = spec.body;
        const neckY = spec.legs + h * 0.9, neckZ = l / 2;
        const pitch = 0.2 - a.head * 1.4;
        this.n.compose(pos.set(0, neckY - a.head * spec.legs * 0.5, neckZ), this.q.setFromEuler(this.e.set(-pitch, 0, 0)), one);
        this.q.setFromEuler(this.e.set(0, a.yaw, 0));
        mesh.head.setMatrixAt(i, this.m.compose(pos.set(a.x, a.y + lift, a.z), this.q, one).multiply(this.n));
        mesh.tone.setX(i, a.tone);
        // Its shadow: under it, longer away from a low sun.
        const s = Math.max(spec.body[0], spec.body[2]) * 1.1, stretch = Math.min(2.5, 1 / Math.max(0.2, sun.y));
        this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.atan2(sun.x, sun.z));
        this.shadows.setMatrixAt(shadows++, this.m.compose(flat.set(a.x - sun.x * 0.3, a.y + 0.04, a.z - sun.z * 0.3), this.q, pos.set(s * 0.8, 1, s * stretch * 0.6)));
      }
    }
    for (const s of SPECIES) {
      const mesh = this.meshes[s];
      mesh.body.count = mesh.head.count = counts[s];
      mesh.body.instanceMatrix.needsUpdate = mesh.head.instanceMatrix.needsUpdate = true;
      mesh.tone.needsUpdate = true;
      mesh.material.uniforms.sunDir!.value.copy(sun);
    }
    this.shadows.count = shadows;
    this.shadows.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const s of SPECIES) {
      const m = this.meshes[s];
      m.body.geometry.dispose();
      m.head.geometry.dispose();
      m.material.dispose();
    }
    this.shadows.geometry.dispose();
    (this.shadows.material as THREE.Material).dispose();
  }
}
