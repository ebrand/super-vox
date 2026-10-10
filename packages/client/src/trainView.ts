import * as THREE from 'three';
import { BLOCK_SIZE, CAR_SPECS, FLATBED_CRATES, Item, PLATFORM_M, STATION_BED, STATION_X, UNITS_PER_METER, designOfItem, type Station, alongLine, cratesFor, carPose, moveTrain, pointAt, route, speedLimit, trackNet, type CarKind, type Track, type TrackNet, type Train } from '@super-vox/shared';
import { AMBER_DISC, CAR_SIZE, GREEN_DISC, carGeometry, crateGeometry, stationGeometry, switchStandGeometry } from './trainModels.js';
import { nameTag } from './entities.js';
import { materialColor } from './materials.js';

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
    this.net = trackNet(tracks, Object.fromEntries(this.net.set));
    this.showSwitches();
    // (Their tracks may have been split: placed again.)
    const stations = [...this.stationMeshes.values()].map((m) => m.station);
    for (const m of this.stationMeshes.values()) m.group.removeFromParent();
    this.stationMeshes.clear();
    this.setStations(stations);
  }

  setTrains(trains: Train[], at: number, switches: Readonly<Record<string, 0 | 1>> = {}): void {
    this.trains = trains;
    this.at = at;
    let thrown = false;
    for (const [k, v] of Object.entries(switches))
      if (this.net.set.has(k) && this.net.set.get(k) !== v) {
        this.net.set.set(k, v);
        thrown = true;
      }
    if (thrown) this.showSwitches();
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

  /** Each switch's lever stand: beside its trunk, a little back from it. */
  private readonly stands = new Map<string, { group: THREE.Group; x: number; y: number; z: number; heading: number }>();

  /** The switches' stands, as they're set: a green disc set straight, amber set for the turnout; an arrow the way it's set. */
  private showSwitches(): void {
    for (const s of this.stands.values()) s.group.removeFromParent();
    this.stands.clear();
    for (const node of this.net.nodes) {
      if (!node.legs || !node.trunk) continue;
      const t = this.net.tracks.get(node.trunk.track)!, L = t.points.at(-1)!.s;
      const p = pointAt(this.net, { track: t.id, s: node.trunk.end === 'end' ? Math.max(0, L - 4 * M) : Math.min(L, 4 * M), dir: node.trunk.end === 'end' ? 1 : -1 });
      if (!p) continue;
      const set = this.net.set.get(node.key) ?? 0, straight = set === node.straight;
      // (Its right, going into the switch: across from the heading.)
      const rx = Math.cos(p.heading), rz = -Math.sin(p.heading);
      const group = new THREE.Group();
      group.position.set(p.x / M + rx * 2.4, p.y / M, p.z / M + rz * 2.4);
      group.rotation.y = p.heading;
      const geometry = switchStandGeometry(straight ? GREEN_DISC : AMBER_DISC, set === 0 ? 1 : -1);
      group.add(new THREE.Mesh(geometry, this.material));
      this.group.add(group);
      this.stands.set(node.key, { group, x: group.position.x * M, y: p.y, z: group.position.z * M, heading: p.heading });
    }
  }

  /** The switch whose stand a ray (units) meets within `maxDist` units: its key, which way it's set, and how far. */
  pickSwitch(origin: readonly number[], dir: readonly number[], maxDist: number): { key: string; left: boolean; dist: number } | null {
    let best: { key: string; left: boolean; dist: number } | null = null;
    for (const [key, s] of this.stands) {
      const half = 0.6 * M, lo = [s.x - half, s.y, s.z - half], hi = [s.x + half, s.y + 1.8 * M, s.z + half];
      let near = 0, far = maxDist;
      for (let a = 0; a < 3 && near <= far; a++) {
        const o = origin[a]!, d = dir[a]!;
        if (Math.abs(d) < 1e-9) {
          if (o < lo[a]! || o > hi[a]!) far = -1;
          continue;
        }
        const t1 = (lo[a]! - o) / d, t2 = (hi[a]! - o) / d;
        near = Math.max(near, Math.min(t1, t2));
        far = Math.min(far, Math.max(t1, t2));
      }
      if (near <= far && (!best || near < best.dist)) best = { key, left: this.net.set.get(key) === 0, dist: near };
    }
    return best;
  }

  /** How far (m, as the crow flies) the next switch a train comes to from its trunk is, the way it's going, if one's within `reach` m along the line. */
  nextSwitch(car: number, reach = 300): number | null {
    const t = this.trainOf(car);
    if (!t) return null;
    const lead = t.v >= 0 ? t.cars[0]! : t.cars.at(-1)!, at = carPose(this.net, lead);
    let found: { x: number; z: number } | null = null;
    alongLine(this.net, lead.pos, (t.v >= 0 ? 1 : -1) * reach * M, (node, from) => {
      if (!found && node.trunk && node.trunk.track === from.track && node.trunk.end === from.end) found = node;
      return route(this.net, node, from);
    });
    const f = found as { x: number; z: number } | null;
    return f && at ? Math.hypot(f.x - at.x, f.z - at.z) / M : null;
  }

  /** The stations, each its platform and shelter beside its track, named. */
  private readonly stationMeshes = new Map<number, { group: THREE.Group; station: Station; key: string }>();
  private readonly stationGeometries = { 1: stationGeometry(1), [-1]: stationGeometry(-1) } as Record<1 | -1, THREE.BufferGeometry>;

  setStations(stations: readonly Station[]): void {
    const keep = new Set(stations.map((s) => s.id));
    for (const [id, m] of this.stationMeshes)
      if (!keep.has(id)) {
        m.group.removeFromParent();
        this.stationMeshes.delete(id);
      }
    for (const st of stations) {
      const key = `${st.track},${st.s},${st.side},${st.name}`, was = this.stationMeshes.get(st.id);
      if (was?.key === key) continue;
      was?.group.removeFromParent();
      const p = pointAt(this.net, { track: st.track, s: st.s, dir: 1 });
      if (!p) continue;
      const group = new THREE.Group();
      group.position.set(p.x / M, p.y / M, p.z / M);
      group.rotation.y = p.heading;
      group.add(this.stationLook(st.side));
      const tag = nameTag(st.name, 4.6);
      tag.position.x = st.side * 2.7;
      group.add(tag);
      this.group.add(group);
      this.stationMeshes.set(st.id, { group, station: st, key });
    }
  }

  /** Where each station is (units), for the map. */
  stationPoints(): { id: number; name: string; x: number; z: number }[] {
    return [...this.stationMeshes.values()].map(({ group, station }) => ({ id: station.id, name: station.name, x: group.position.x * M, z: group.position.z * M }));
  }

  /** Stations drawn again (their look's design changed: see the designs message). */
  designsChanged(): void {
    const stations = [...this.stationMeshes.values()].map((m) => m.station);
    for (const m of this.stationMeshes.values()) m.group.removeFromParent();
    this.stationMeshes.clear();
    this.setStations(stations);
  }

  /**
   * How a station looks, on `side` of the track: the design standing in for stations, if there is
   * one (a cube a voxel: see stationDesign for its frame), else the built-in model.
   */
  private stationLook(side: 1 | -1): THREE.Object3D {
    const design = designOfItem(Item.Station);
    if (!design) return new THREE.Mesh(this.stationGeometries[side], this.material);
    const voxels = design.states[0]?.voxels ?? [];
    const mesh = new THREE.InstancedMesh(this.cube, this.material, Math.max(1, voxels.length));
    const m = new THREE.Matrix4(), c = new THREE.Color(), L = (design.size[2] * BLOCK_SIZE) / M;
    voxels.forEach((v, i) => {
      const s = v.size / M, x = (v.x + v.size / 2) / M, y = (v.y + v.size / 2) / M, z = (v.z + v.size / 2) / M;
      m.makeScale(s, s, s).setPosition(side * (STATION_X + x), y - STATION_BED, z - L / 2);
      mesh.setMatrixAt(i, m);
      const [r, g, b] = materialColor(v.material);
      mesh.setColorAt(i, c.setRGB(r, g, b, THREE.LinearSRGBColorSpace));
    });
    mesh.count = voxels.length;
    mesh.frustumCulled = false;
    return mesh;
  }

  /** A unit cube, its faces shaded as blocks are (lit from above), for voxels. */
  private readonly cube = (() => {
    const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed(), n = g.getAttribute('normal'), col: number[] = [];
    const light = new THREE.Vector3(0.35, 1, -0.5).normalize(), v = new THREE.Vector3();
    for (let i = 0; i < n.count; i++) {
      v.fromBufferAttribute(n, i);
      const k = 0.55 + 0.45 * Math.max(0, v.dot(light)) + 0.08 * Math.max(0, v.y);
      col.push(k, k, k);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return g;
  })();

  /** The station whose platform a ray (units) meets within `maxDist` units: its id, name, and how far. */
  pickStation(origin: readonly number[], dir: readonly number[], maxDist: number): { id: number; name: string; dist: number } | null {
    let best: { id: number; name: string; dist: number } | null = null;
    for (const { group, station } of this.stationMeshes.values()) {
      const px = group.position.x * M, py = group.position.y * M, pz = group.position.z * M, h = group.rotation.y;
      const c = Math.cos(-h), sn = Math.sin(-h), ox = origin[0]! - px, oy = origin[1]! - py, oz = origin[2]! - pz;
      const o = [ox * c + oz * sn, oy, -ox * sn + oz * c], d = [dir[0]! * c + dir[2]! * sn, dir[1]!, -dir[0]! * sn + dir[2]! * c];
      const lo = [Math.min(station.side * 1.2, station.side * 4.1) * M, -0.6 * M, (-PLATFORM_M / 2) * M], hi = [Math.max(station.side * 1.2, station.side * 4.1) * M, 4 * M, (PLATFORM_M / 2) * M];
      let near = 0, far = maxDist;
      for (let a = 0; a < 3 && near <= far; a++) {
        if (Math.abs(d[a]!) < 1e-9) {
          if (o[a]! < lo[a]! || o[a]! > hi[a]!) far = -1;
          continue;
        }
        const t1 = (lo[a]! - o[a]!) / d[a]!, t2 = (hi[a]! - o[a]!) / d[a]!;
        near = Math.max(near, Math.min(t1, t2));
        far = Math.min(far, Math.max(t1, t2));
      }
      if (near <= far && (!best || near < best.dist)) best = { id: station.id, name: station.name, dist: near };
    }
    return best;
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
