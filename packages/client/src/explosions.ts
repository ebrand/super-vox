import * as THREE from 'three';
import { UNITS_PER_METER } from '@super-vox/shared';

/**
 * What explosions look and sound like (the server does the damage; see Explosives): lit TNT
 * blinking (faster as its fuse runs down), and for a blast, a fireball, debris flying out and
 * falling, the view shaking (more the nearer it is) and a boom (later the farther it is: sound
 * goes about 343 m a second).
 */
export class ExplosionView {
  private readonly fuses = new Map<string, { mesh: THREE.Mesh; start: number; end: number }>();
  private readonly fireballs: { mesh: THREE.Mesh; start: number; radius: number }[] = [];
  private readonly debris: THREE.InstancedMesh;
  private readonly bits: { p: THREE.Vector3; v: THREE.Vector3; spin: THREE.Vector3; r: THREE.Euler; born: number; life: number; size: number }[] = [];
  private shakeAmount = 0;
  private audio: AudioContext | null = null;
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  private readonly ball = new THREE.SphereGeometry(1, 20, 14);
  private readonly fuseMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false });

  constructor(private readonly scene: THREE.Scene, private readonly camera: THREE.Camera) {
    // (Unlit: the scene has no three.js lights; the voxels light themselves.)
    this.debris = new THREE.InstancedMesh(this.box, new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_BITS);
    this.debris.count = 0;
    this.debris.frustumCulled = false;
    scene.add(this.debris);
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
    // Debris: dirt, stone and sand coloured bits thrown up and out.
    const n = Math.min(MAX_BITS - this.bits.length, Math.round(10 + r * 5));
    for (let i = 0; i < n; i++) {
      const dir = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 1.4 + 0.2, Math.random() * 2 - 1).normalize();
      const speed = (4 + Math.random() * 10) * Math.sqrt(r);
      this.bits.push({
        p: c.clone().addScaledVector(dir, r * 0.3),
        v: dir.multiplyScalar(speed),
        spin: new THREE.Vector3(Math.random() * 10, Math.random() * 10, Math.random() * 10),
        r: new THREE.Euler(),
        born: now,
        life: 1200 + Math.random() * 900,
        size: (0.06 + Math.random() * 0.14) * Math.min(1.5, Math.sqrt(r / 2)),
      });
    }
    // Shake and sound, by distance.
    const d = this.camera.getWorldPosition(new THREE.Vector3()).distanceTo(c);
    this.shakeAmount = Math.max(this.shakeAmount, Math.min(0.6, (r * 0.6) / Math.max(1, d / 4)));
    this.boom(d, r);
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
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    let k = 0;
    for (let i = this.bits.length - 1; i >= 0; i--) {
      const b = this.bits[i]!;
      if (now - b.born > b.life) {
        this.bits.splice(i, 1);
        continue;
      }
      b.v.y -= 20 * dt;
      b.p.addScaledVector(b.v, dt);
      b.r.set(b.r.x + b.spin.x * dt, b.r.y + b.spin.y * dt, b.r.z + b.spin.z * dt);
      const fade = 1 - Math.max(0, (now - b.born - b.life * 0.7) / (b.life * 0.3));
      m.compose(b.p, q.setFromEuler(b.r), new THREE.Vector3().setScalar(b.size * fade));
      this.debris.setMatrixAt(k, m);
      this.debris.setColorAt(k, DEBRIS[i % DEBRIS.length]!);
      k++;
    }
    this.debris.count = k;
    this.debris.instanceMatrix.needsUpdate = true;
    if (this.debris.instanceColor) this.debris.instanceColor.needsUpdate = true;
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

const MAX_BITS = 400;
const FIREBALL_MS = 450;
const ZERO = new THREE.Vector3();
const DEBRIS = [0x6b4a2b, 0x8a6a42, 0x777777, 0x5d5d5d, 0xc2b280, 0x4f7a32].map((c) => new THREE.Color(c));
