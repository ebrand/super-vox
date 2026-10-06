import * as THREE from 'three';
import { DEBRIS_FPS, GRAVITY, UNITS_PER_METER, unpackDebris, type DebrisPiece } from '@super-vox/shared';
import type { Cloud } from './blastCloud.js';
import { playBlast } from './blastSound.js';
import { materialColor } from './materials.js';

/**
 * What explosions look and sound like (the server does the damage; see Explosives): lit TNT
 * blinking (faster as its fuse runs down), and for a blast, a fireball, the view shaking (more
 * the nearer it is), a boom (later the farther it is: sound goes about 343 m a second), and its
 * debris: pieces of what it blew apart, flying the paths the server worked out, tumbling until
 * they come to rest (where, in creative, the server leaves them: the piece gives way to the voxel),
 * and around them its dust (see blastCloud), flown on the GPU, gone soon after it lands.
 */
export class ExplosionView {
  private readonly fuses = new Map<string, { mesh: THREE.Mesh; start: number; end: number }>();
  private readonly fireballs: { mesh: THREE.Mesh; start: number; radius: number }[] = [];
  private readonly clouds: { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; time: { value: number }; start: number; end: number }[] = [];
  private readonly cloudBox = shadedBox();
  private readonly pieceMesh: THREE.InstancedMesh;
  private readonly pieces: { path: [number, number, number][]; size: number; color: THREE.Color; start: number; spin: THREE.Vector3 }[] = [];
  /** Shakes under way: each from when its blast reaches us (performance.now()), how hard (m) and how long (s), and its sway's frequencies and phases. */
  private shakes: { start: number; amp: number; dur: number; freq: number[]; phase: number[] }[] = [];
  /** Called for each blast: where it is (m), its radius (m), how far off (m). (The game knocks you down: see knockdown.ts.) */
  onBlast: ((center: THREE.Vector3, radius: number, distance: number) => void) | null = null;
  private audio: AudioContext | null = null;
  private out: AudioNode | null = null;
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  private readonly ball = new THREE.SphereGeometry(1, 20, 14);
  private readonly fuseMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false });

  constructor(private readonly scene: THREE.Scene, private readonly camera: THREE.Camera) {
    // (Unlit: the scene has no three.js lights; the voxels light themselves.)
    this.pieceMesh = new THREE.InstancedMesh(shadedBox(), new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true }), MAX_PIECES);
    this.pieceMesh.count = 0;
    this.pieceMesh.frustumCulled = false;
    scene.add(this.pieceMesh);
    // Dust's shader made now, with a piece nobody sees (gone from the start): not at the first blast, a stall.
    const one = (n: number, values: number[] = []) => Float32Array.from({ length: n }, (_, i) => values[i] ?? 0);
    this.cloud({ count: 1, start: one(3), velocity: one(3), land: one(4, [0, 0, 0, 1e6]), spin: one(4), size: one(1, [0.25]), material: new Uint16Array([1]), end: 0.5 }, performance.now());
  }

  /** TNT lit: the voxel at (x, y, z) (units, `size` across) blows in `ms`. */
  fuse(x: number, y: number, z: number, size: number, ms: number): void {
    const key = `${x},${y},${z}`;
    this.fuses.get(key)?.mesh.removeFromParent();
    const s = size / UNITS_PER_METER;
    const mesh = new THREE.Mesh(this.box, this.fuseMaterial.clone());
    mesh.scale.setScalar(s * 1.04);
    mesh.position.set((x + size / 2) / UNITS_PER_METER, (y + size / 2) / UNITS_PER_METER, (z + size / 2) / UNITS_PER_METER);
    this.scene.add(mesh);
    const now = performance.now();
    this.fuses.set(key, { mesh, start: now, end: now + ms + 1500 });
  }

  /** A blast centred at (x, y, z) of `radius` (units). */
  explode(x: number, y: number, z: number, radius: number): void {
    const c = new THREE.Vector3(x, y, z).divideScalar(UNITS_PER_METER), r = radius / UNITS_PER_METER;
    const now = performance.now();
    // Its own fuse (and any within half a metre of its centre) goes out.
    for (const [key, f] of this.fuses) {
      if (f.mesh.position.distanceTo(c) < 0.6) {
        f.mesh.removeFromParent();
        this.fuses.delete(key);
      }
    }
    const fire = new THREE.Mesh(this.ball, new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.95, depthWrite: false }));
    fire.position.copy(c);
    this.scene.add(fire);
    this.fireballs.push({ mesh: fire, start: now, radius: r });
    // Shake and sound, by distance.
    const d = this.camera.getWorldPosition(new THREE.Vector3()).distanceTo(c);
    // The shake: as hard and as long as the blast is big, less the farther off it is (beyond its
    // radius), from when it reaches us.
    const near = 1 / (1 + Math.max(0, d - r) / (r * 1.2)) ** 1.5;
    const amp = Math.min(0.9, 0.04 + 0.05 * r) * near;
    if (amp > 0.005) {
      const size = Math.max(0, Math.min(1, (r - 2.3) / 13.7));
      const f = 7 - 3 * size;
      this.shakes.push({ start: now + (d / 343) * 1000, amp, dur: 0.35 + 0.13 * r, freq: [f, f * 1.37, f * 0.83], phase: [Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3] });
    }
    this.boom(d, r);
    this.onBlast?.(c, r, d);
  }

  /** A blast's debris (see DebrisPiece): each piece flies its path from now. */
  debris(pieces: readonly DebrisPiece[]): void {
    const now = performance.now();
    for (const p of pieces) {
      if (this.pieces.length >= MAX_PIECES) break;
      const [r, g, b] = materialColor(p.m);
      // (Sent a little after its blast: joins part way through its flight.)
      this.pieces.push({ path: unpackDebris(p), size: p.s, color: new THREE.Color(r, g, b), start: now - (p.a ?? 0), spin: new THREE.Vector3(Math.random() * 12 - 6, Math.random() * 12 - 6, Math.random() * 12 - 6) });
    }
  }

  /** Each frame: fuses blink, fireballs grow and fade, debris flies and falls. */
  frame(): void {
    const now = performance.now();
    for (const [key, f] of this.fuses) {
      if (now > f.end) {
        f.mesh.removeFromParent();
        this.fuses.delete(key);
        continue;
      }
      // Faster as it burns down: from 2 to 10 blinks a second.
      const t = (now - f.start) / 1000, rate = 2 + Math.min(8, t * 2);
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = Math.sin(t * rate * Math.PI * 2) > 0 ? 0.65 : 0.05;
    }
    for (let i = this.fireballs.length - 1; i >= 0; i--) {
      const f = this.fireballs[i]!, t = (now - f.start) / FIREBALL_MS;
      if (t >= 1) {
        f.mesh.removeFromParent();
        (f.mesh.material as THREE.Material).dispose();
        this.fireballs.splice(i, 1);
        continue;
      }
      f.mesh.scale.setScalar(f.radius * (0.3 + 0.9 * Math.sqrt(t)));
      const m = f.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = 0.95 * (1 - t) ** 1.5;
      m.color.setRGB(1, 0.85 - 0.5 * t, 0.5 - 0.45 * t);
    }
    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const c = this.clouds[i]!, t = (now - c.start) / 1000;
      if (t > c.end) {
        c.mesh.removeFromParent();
        c.mesh.geometry.dispose();
        c.material.dispose();
        this.clouds.splice(i, 1);
        continue;
      }
      c.time.value = t;
    }
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pos = new THREE.Vector3(), scale = new THREE.Vector3();
    let k = 0;
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i]!, last = p.path.length - 1;
      const t = ((now - p.start) / 1000) * DEBRIS_FPS;
      // At rest: held a moment (in creative the voxel it becomes takes its place), then gone.
      const rested = (t - last) / DEBRIS_FPS;
      if (rested > REST_HOLD_S) {
        this.pieces.splice(i, 1);
        continue;
      }
      const f = Math.min(t, last), j = Math.min(Math.floor(f), last - 1), u = last > 0 ? f - j : 0;
      const a = p.path[Math.max(0, j)]!, b = p.path[Math.min(last, j + 1)]!;
      const half = p.size / 2;
      pos.set((a[0] + (b[0] - a[0]) * u + half) / UNITS_PER_METER, (a[1] + (b[1] - a[1]) * u + half) / UNITS_PER_METER, (a[2] + (b[2] - a[2]) * u + half) / UNITS_PER_METER);
      // Tumbling while it flies, squaring up over its last few frames.
      const spin = Math.min(1, Math.max(0, last - f) / 3) * (f / DEBRIS_FPS);
      e.set(p.spin.x * spin, p.spin.y * spin, p.spin.z * spin);
      const fade = rested > REST_HOLD_S - 0.3 ? Math.max(0, (REST_HOLD_S - rested) / 0.3) : 1;
      scale.setScalar((p.size / UNITS_PER_METER) * 0.98 * fade);
      m.compose(pos, q.setFromEuler(e), scale);
      this.pieceMesh.setMatrixAt(k, m);
      this.pieceMesh.setColorAt(k, p.color);
      k++;
    }
    this.pieceMesh.count = k;
    this.pieceMesh.instanceMatrix.needsUpdate = true;
    if (this.pieceMesh.instanceColor) this.pieceMesh.instanceColor.needsUpdate = true;
  }
  private lastFrame = performance.now();

  /**
   * A blast's dust (see blastCloud), its blast at `startedAt` (performance.now(); worked out a little
   * after, it joins part way through): one draw of all its pieces, each placed by the GPU from its
   * throw, landing and the time.
   */
  cloud(cloud: Cloud, startedAt: number): void {
    if (!cloud.count || (performance.now() - startedAt) / 1000 > cloud.end) return;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = this.cloudBox.index;
    geometry.setAttribute('position', this.cloudBox.getAttribute('position'));
    geometry.setAttribute('color', this.cloudBox.getAttribute('color'));
    geometry.setAttribute('aStart', new THREE.InstancedBufferAttribute(cloud.start, 3));
    geometry.setAttribute('aVel', new THREE.InstancedBufferAttribute(cloud.velocity, 3));
    geometry.setAttribute('aLand', new THREE.InstancedBufferAttribute(cloud.land, 4));
    geometry.setAttribute('aSpin', new THREE.InstancedBufferAttribute(cloud.spin, 4));
    geometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(cloud.size, 1));
    const colors = new Float32Array(cloud.count * 3);
    for (let i = 0; i < cloud.count; i++) colors.set(materialColor(cloud.material[i]!), i * 3);
    geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
    geometry.instanceCount = cloud.count;
    const time = { value: 0 };
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = time;
      shader.uniforms.uG = { value: GRAVITY };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uTime; uniform float uG;
attribute float aSize;
attribute vec3 aStart; attribute vec3 aVel; attribute vec4 aLand; attribute vec4 aSpin; attribute vec3 aColor;`,
        )
        .replace(
          '#include <begin_vertex>',
          `float t = uTime;
float tl = aLand.w;
vec3 at = t < tl ? aStart + aVel * t + vec3(0.0, -0.5 * uG * t * t, 0.0) : aLand.xyz;
vec3 a = aSpin.xyz * min(t, tl);
float ca = cos(a.x), sa = sin(a.x), cb = cos(a.y), sb = sin(a.y), cc = cos(a.z), sc = sin(a.z);
mat3 turn = mat3(cc, sc, 0.0, -sc, cc, 0.0, 0.0, 0.0, 1.0) * mat3(cb, 0.0, -sb, 0.0, 1.0, 0.0, sb, 0.0, cb) * mat3(1.0, 0.0, 0.0, 0.0, ca, sa, 0.0, -sa, ca);
float life = clamp((aSpin.w - t) / 0.3, 0.0, 1.0);
vec3 transformed = turn * (position * aSize * 0.98 * life) + at;`,
        )
        .replace('#include <color_vertex>', '#include <color_vertex>\nvColor.rgb *= aColor;');
    };
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.clouds.push({ mesh, material, time, start: startedAt, end: cloud.end + 0.1 });
  }

  /**
   * The view's shake now (metres): an offset to add to the camera for this frame. Each blast's is a
   * jolt (sharp, gone in a tenth of a second or so), then a sway dying away over its length.
   */
  shake(): THREE.Vector3 {
    if (!this.shakes.length) return ZERO;
    const now = performance.now(), out = new THREE.Vector3();
    this.shakes = this.shakes.filter((s) => (now - s.start) / 1000 < s.dur * 5);
    for (const s of this.shakes) {
      const t = (now - s.start) / 1000;
      if (t < 0) continue;
      const jolt = s.amp * Math.exp(-t / 0.1), sway = s.amp * 0.7 * Math.exp(-t / s.dur);
      const at = (i: number) => (Math.random() - 0.5) * 2 * jolt + Math.sin(2 * Math.PI * s.freq[i]! * t + s.phase[i]!) * sway;
      out.x += at(0);
      out.y += at(1) * 0.8;
      out.z += at(2);
    }
    return out;
  }

  /** A blast's sound, `distance` m away from a blast of `radius` m (see blastSound.ts), through a limiter (so a big one near doesn't clip). */
  private boom(distance: number, radius: number): void {
    try {
      if (!this.audio) {
        this.audio = new AudioContext();
        const limit = this.audio.createDynamicsCompressor();
        limit.threshold.value = -6;
        limit.knee.value = 4;
        limit.ratio.value = 16;
        limit.attack.value = 0.002;
        limit.release.value = 0.3;
        limit.connect(this.audio.destination);
        this.out = limit;
      }
      if (this.audio.state === 'suspended') void this.audio.resume();
      playBlast(this.audio, this.out!, distance, radius);
    } catch {
      // No sound here: fine.
    }
  }
}

const MAX_PIECES = 4000;
/** How long a piece stays once at rest (s), fading out over the last 0.3. */
const REST_HOLD_S = 0.9;
const FIREBALL_MS = 450;
const ZERO = new THREE.Vector3();
/** A unit cube shaded by face (as the sun would: tops lit, sides less, undersides least), to tint by material. */
function shadedBox(): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const n = g.getAttribute('normal'), colors: number[] = [];
  for (let i = 0; i < n.count; i++) {
    const shade = n.getY(i) > 0.5 ? 1 : n.getY(i) < -0.5 ? 0.45 : n.getX(i) !== 0 ? 0.75 : 0.62;
    colors.push(shade, shade, shade);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return g;
}
