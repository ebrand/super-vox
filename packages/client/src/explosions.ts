import * as THREE from 'three';
import { DEBRIS_FPS, UNITS_PER_METER, unpackDebris, type DebrisPiece } from '@super-vox/shared';
import { materialColor } from './materials.js';

/**
 * What explosions look and sound like (the server does the damage; see Explosives): lit TNT
 * blinking (faster as its fuse runs down), and for a blast, a fireball, the view shaking (more
 * the nearer it is), a boom (later the farther it is: sound goes about 343 m a second), and its
 * debris: pieces of what it blew apart, flying the paths the server worked out, tumbling until
 * they come to rest (where, in creative, the server leaves them: the piece gives way to the voxel).
 */
export class ExplosionView {
  private readonly fuses = new Map<string, { mesh: THREE.Mesh; start: number; end: number }>();
  private readonly fireballs: { mesh: THREE.Mesh; start: number; radius: number }[] = [];
  private readonly pieceMesh: THREE.InstancedMesh;
  private readonly pieces: { path: [number, number, number][]; size: number; color: THREE.Color; start: number; spin: THREE.Vector3 }[] = [];
  private shakeAmount = 0;
  private audio: AudioContext | null = null;
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  private readonly ball = new THREE.SphereGeometry(1, 20, 14);
  private readonly fuseMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false });

  constructor(private readonly scene: THREE.Scene, private readonly camera: THREE.Camera) {
    // (Unlit: the scene has no three.js lights; the voxels light themselves.)
    this.pieceMesh = new THREE.InstancedMesh(shadedBox(), new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true }), MAX_PIECES);
    this.pieceMesh.count = 0;
    this.pieceMesh.frustumCulled = false;
    scene.add(this.pieceMesh);
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
    this.shakeAmount = Math.max(this.shakeAmount, Math.min(0.6, (r * 0.6) / Math.max(1, d / 4)));
    this.boom(d, r);
  }

  /** A blast's debris (see DebrisPiece): each piece flies its path from now. */
  debris(pieces: readonly DebrisPiece[]): void {
    const now = performance.now();
    for (const p of pieces) {
      if (this.pieces.length >= MAX_PIECES) break;
      const [r, g, b] = materialColor(p.m);
      this.pieces.push({ path: unpackDebris(p), size: p.s, color: new THREE.Color(r, g, b), start: now, spin: new THREE.Vector3(Math.random() * 12 - 6, Math.random() * 12 - 6, Math.random() * 12 - 6) });
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
    this.shakeAmount *= Math.exp(-dt * 6);
    if (this.shakeAmount < 0.002) this.shakeAmount = 0;
  }
  private lastFrame = performance.now();

  /** The view's shake now (metres): an offset to add to the camera for this frame. */
  shake(): THREE.Vector3 {
    const a = this.shakeAmount;
    return a ? new THREE.Vector3((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, (Math.random() - 0.5) * a) : ZERO;
  }

  /** A boom `distance` m away from a blast of `radius` m: noise through a falling low-pass, after the sound's travel time. */
  private boom(distance: number, radius: number): void {
    try {
      this.audio ??= new AudioContext();
      const ctx = this.audio;
      if (ctx.state === 'suspended') void ctx.resume();
      const at = ctx.currentTime + distance / 343;
      const len = 1.6, buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * len), ctx.sampleRate), data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.35));
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(900 * Math.min(1, 6 / Math.max(1, distance / 10)), at);
      lp.frequency.exponentialRampToValueAtTime(60, at + 1.2);
      const gain = ctx.createGain();
      const loud = Math.min(1, (radius / 4) * (12 / Math.max(12, distance)));
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.9 * loud + 0.0001, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + len);
      src.connect(lp).connect(gain).connect(ctx.destination);
      src.start(at);
    } catch {
      // No sound here: fine.
    }
  }
}

const MAX_PIECES = 800;
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
