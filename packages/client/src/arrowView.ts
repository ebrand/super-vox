import * as THREE from 'three';
import { ARROW, UNITS_PER_METER, arrowAt, deltaX, type ArrowShot, type WorldConfig } from '@super-vox/shared';

interface Shown {
  shot: ArrowShot;
  /** When it was shot (as we heard: performance.now, ms). */
  at: number;
  group: THREE.Group;
  /** Stuck where it hit (units), pointing the way it was going, until `until` (ms). */
  stuck: { x: number; y: number; z: number; dir: THREE.Vector3; until: number } | null;
}

/** An arrow: a thin shaft 0.7 m long, its head at +z (forward), fletching at the back. */
function arrowModel(): THREE.Group {
  const g = new THREE.Group();
  const wood = new THREE.MeshBasicMaterial({ color: 0x8a6a42 });
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.7), wood);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.09), new THREE.MeshBasicMaterial({ color: 0x9aa0a6 }));
  head.position.z = 0.38;
  // Fletching: two thin vanes, crossed.
  const vane = new THREE.MeshBasicMaterial({ color: 0xe8e2d6 });
  const v1 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.012, 0.14), vane), v2 = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.12, 0.14), vane);
  v1.position.z = v2.position.z = -0.28;
  g.add(shaft, head, v1, v2);
  // (Its tip 0.1 m past the group's origin: stuck where it hit, its head is in what it hit.)
  for (const c of g.children) c.position.z -= 0.32;
  return g;
}

/**
 * Arrows (see arrows.ts): each flown along its arc from when we heard it was shot (as the server
 * flies it), pointing the way it's going; where it stops (see stop), stuck in the world for a
 * while, or gone (in a mob, a player, water, or flown its time).
 */
export class ArrowView {
  private readonly shown = new Map<number, Shown>();
  private readonly look = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: WorldConfig,
    private readonly cameraX: () => number,
  ) {}

  /** One's been shot. */
  shoot(shot: ArrowShot, now = performance.now()): void {
    const group = arrowModel();
    this.scene.add(group);
    this.shown.set(shot.id, { shot, at: now, group, stuck: null });
  }

  /** One's stopped at (x, y, z) (units): stuck there (the world) for a while, or gone. */
  stop(id: number, x: number, y: number, z: number, stuck: boolean, now = performance.now()): void {
    const s = this.shown.get(id);
    if (!s) return;
    if (!stuck) return this.drop(id);
    const v = arrowAt(s.shot, (now - s.at) / 1000);
    s.stuck = { x, y, z, dir: new THREE.Vector3(v.vx, v.vy, v.vz).normalize(), until: now + ARROW.stuckMs };
  }

  /** Places them for this frame. */
  frame(now = performance.now()): void {
    const camX = this.cameraX();
    for (const [id, s] of this.shown) {
      let p: { x: number; y: number; z: number }, dir: THREE.Vector3;
      if (s.stuck) {
        if (now > s.stuck.until) {
          this.drop(id);
          continue;
        }
        p = s.stuck;
        dir = s.stuck.dir;
      } else {
        const t = (now - s.at) / 1000;
        // (Not heard where it stopped yet, long after it would have: gone.)
        if (t > ARROW.lifeMs / 1000 + 2) {
          this.drop(id);
          continue;
        }
        const a = arrowAt(s.shot, t);
        p = a;
        dir = this.look.set(a.vx, a.vy, a.vz).normalize();
      }
      const x = camX + deltaX(this.world, camX, p.x);
      s.group.position.set(x / UNITS_PER_METER, p.y / UNITS_PER_METER, p.z / UNITS_PER_METER);
      s.group.lookAt(s.group.position.clone().add(dir));
    }
  }

  get count(): number {
    return this.shown.size;
  }

  private drop(id: number): void {
    const s = this.shown.get(id);
    if (!s) return;
    this.scene.remove(s.group);
    s.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.shown.delete(id);
  }
}
