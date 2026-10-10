import * as THREE from 'three';
import { CAR_SPECS, FLATBED_CRATES, UNITS_PER_METER, cratesFor, carPose, moveTrain, speedLimit, trackNet, type CarKind, type Track, type TrackNet, type Train } from '@super-vox/shared';
import { CAR_SIZE, carGeometry, crateGeometry } from './trainModels.js';

const M = UNITS_PER_METER;
/** The top of the rails over a track point's height (its rails' foot: see trackModel), m. */
const RAIL_TOP_M = 0.28;
/** Moving trains are drawn where they'd be by now, from where they were last told: this long at most (s). */
const AHEAD_S = 0.5;

/**
 * The world's trains (see trains.ts) as they're drawn: each car its model, where it is on the track
 * (moving trains, on from where they were last told, at their speed: told by the server's clock, so
 * as smooth as the clock), lit with the day.
 */
export class TrainView {
  readonly group = new THREE.Group();
  private readonly material = new THREE.MeshBasicMaterial({ vertexColors: true });
  private net: TrackNet = trackNet([]);
  private trains: Train[] = [];
  /** When they were where they were told (ms, by the server's clock). */
  private at = 0;
  private readonly meshes = new Map<number, THREE.Mesh>();
  /** Each car where it's drawn now (units, its heading and pitch), and its kind. */
  private readonly poses = new Map<number, { x: number; y: number; z: number; heading: number; pitch: number; kind: CarKind }>();

  constructor(
    private readonly daylight: () => number,
    /** Now, by the server's clock (ms). */
    private readonly serverNow: () => number,
  ) {}

  setTracks(tracks: readonly Track[]): void {
    this.net = trackNet(tracks);
  }

  setTrains(trains: Train[], at: number): void {
    this.trains = trains;
    this.at = at;
    const keep = new Set(trains.flatMap((t) => t.cars.map((c) => c.id)));
    for (const [id, m] of this.meshes)
      if (!keep.has(id)) {
        m.removeFromParent();
        this.meshes.delete(id);
        this.poses.delete(id);
      }
    for (const t of trains)
      for (const c of t.cars) {
        let m = this.meshes.get(c.id);
        if (!m || m.userData.kind !== c.kind) {
          m?.removeFromParent();
          m = new THREE.Mesh(carGeometry(c.kind), this.material);
          m.userData.kind = c.kind;
          m.rotation.order = 'YXZ';
          this.meshes.set(c.id, m);
          this.group.add(m);
        }
        // A flatbed's load: as many crates as it takes.
        if (c.kind === 'flatbed') {
          const n = Math.min(FLATBED_CRATES, cratesFor(c.cargo));
          if (m.userData.crates !== n) {
            m.userData.crates = n;
            m.clear();
            if (n) m.add(new THREE.Mesh(crateGeometry(n), this.material));
          }
        }
      }
    this.frame();
  }

  /** The train a car is in (as last told). */
  trainOf(car: number): Train | null {
    return this.trains.find((t) => t.cars.some((c) => c.id === car)) ?? null;
  }

  /** The slowest the track under a car's train lets it go (m/s). */
  limitOf(car: number): number {
    const t = this.trainOf(car);
    return t ? speedLimit(this.net, t) : 0;
  }

  /** Where a car's drawn now (units; its heading, the way its front faces). */
  pose(car: number): { x: number; y: number; z: number; heading: number; pitch: number; kind: CarKind } | null {
    return this.poses.get(car) ?? null;
  }

  /** Each frame: the cars where they'd be by now. */
  frame(): void {
    this.material.color.setScalar(Math.max(0.15, this.daylight()));
    const ahead = Math.max(0, Math.min(AHEAD_S, (this.serverNow() - this.at) / 1000));
    for (const t of this.trains) {
      // (On from where it was told, on a copy: as far as it'd have gone.)
      const moved = t.v !== 0 && ahead > 0 ? { ...t, cars: t.cars.map((c) => ({ ...c, pos: { ...c.pos } })) } : t;
      if (moved !== t) moveTrain(this.net, moved, t.v * ahead * M);
      for (const c of moved.cars) {
        const p = carPose(this.net, c), m = this.meshes.get(c.id);
        if (!p || !m) continue;
        this.poses.set(c.id, { ...p, kind: c.kind });
        m.position.set(p.x / M, p.y / M + RAIL_TOP_M, p.z / M);
        m.rotation.set(p.pitch, p.heading, 0);
      }
    }
  }

  /** The nearest car along a ray (units), within `maxDist` units: its id, kind and how far. */
  pick(origin: readonly number[], dir: readonly number[], maxDist: number): { id: number; kind: CarKind; dist: number } | null {
    let best: { id: number; kind: CarKind; dist: number } | null = null;
    for (const [id, p] of this.poses) {
      const size = CAR_SIZE[p.kind], half = [size.width / 2, size.height / 2, CAR_SPECS[p.kind].length / 2].map((v) => v * M);
      // Into the car's frame (turned by its heading; its middle half its height up).
      const ox = origin[0]! - p.x, oy = origin[1]! - (p.y + (RAIL_TOP_M * M + half[1]!)), oz = origin[2]! - p.z;
      const c = Math.cos(-p.heading), s = Math.sin(-p.heading);
      const o = [ox * c + oz * s, oy, -ox * s + oz * c], d = [dir[0]! * c + dir[2]! * s, dir[1]!, -dir[0]! * s + dir[2]! * c];
      let near = 0, far = maxDist;
      for (let a = 0; a < 3 && near <= far; a++) {
        if (Math.abs(d[a]!) < 1e-9) {
          if (Math.abs(o[a]!) > half[a]!) far = -1;
          continue;
        }
        const t1 = (-half[a]! - o[a]!) / d[a]!, t2 = (half[a]! - o[a]!) / d[a]!;
        near = Math.max(near, Math.min(t1, t2));
        far = Math.min(far, Math.max(t1, t2));
      }
      if (near <= far && (!best || near < best.dist)) best = { id, kind: p.kind, dist: near };
    }
    return best;
  }
}
