import * as THREE from 'three';
import { UNITS_PER_METER, avatarFromText, defaultAvatar, type TradingPost } from '@super-vox/shared';
import { Builder, type Rgb } from './trainModels.js';
import { FigureMotion, nameTag } from './entities.js';
import { PlayerFigure, poseFor } from './playerFigure.js';

const M = UNITS_PER_METER;
/** Posts drawn this near the camera (m); their traders move (breathe, look about) nearer still. */
const SHOWN_M = 600;
const ALIVE_M = 120;
const TIMBER: Rgb = [0.45, 0.31, 0.18];
const DARK: Rgb = [0.27, 0.18, 0.1];
const RED: Rgb = [0.62, 0.12, 0.1];
const CREAM: Rgb = [0.88, 0.82, 0.66];
const IRON: Rgb = [0.25, 0.25, 0.27];

/** A market stall (m: its front, the counter's side, toward -z, as figures face; the trader behind the counter). */
function stallGeometry(): THREE.BufferGeometry {
  const b = new Builder();
  // (Its floor on a foundation, down into the ground where that's lower: it's level to within 1.5 m.)
  b.box(0, -0.8, 0, 4.1, 1.6, 3.1, [0.38, 0.33, 0.28]).box(0, 0.1, 0, 4.2, 0.2, 3.2, DARK);
  b.box(0, 0.65, -1.1, 3.8, 0.9, 0.6, TIMBER).box(0, 1.13, -1.15, 4.0, 0.06, 0.75, DARK);
  for (const x of [-1.95, 1.95]) for (const z of [-1.45, 1.45]) b.box(x, 1.45, z, 0.16, 2.7, 0.16, DARK);
  // A striped awning, a little higher at the back.
  for (let i = 0; i < 6; i++) b.box(-1.75 + i * 0.7, 2.86, 0, 0.7, 0.08, 3.5, i % 2 ? CREAM : RED);
  b.box(0, 2.72, -1.78, 4.2, 0.3, 0.06, RED);
  // Goods behind: crates and a barrel.
  b.box(-1.3, 0.55, 1.0, 0.8, 0.7, 0.8, TIMBER).box(-1.3, 1.25, 1.0, 0.6, 0.6, 0.6, [0.55, 0.4, 0.22]);
  b.cylinder('y', 1.3, 0.65, 1.0, 0.4, 0.9, [0.4, 0.26, 0.14], 12).cylinder('y', 1.3, 0.85, 1.0, 0.42, 0.06, IRON, 12);
  return b.geometry();
}

interface Shown {
  post: TradingPost;
  group: THREE.Group;
  figure: PlayerFigure;
  motion: FigureMotion;
}

/**
 * The world's trading posts (see market.ts) as they're drawn: each a market stall with its trader
 * behind the counter (a figure, as players are: their name over them), lit with the day; those
 * near enough to aim at, for trading.
 */
export class PostView {
  readonly group = new THREE.Group();
  private readonly material = new THREE.MeshBasicMaterial({ vertexColors: true });
  private readonly stall = stallGeometry();
  private readonly shown: Shown[] = [];

  constructor(private readonly daylight: () => number) {}

  setPosts(posts: readonly TradingPost[]): void {
    for (const s of this.shown) s.group.removeFromParent();
    this.shown.length = 0;
    for (const post of posts) {
      const group = new THREE.Group();
      group.position.set(post.x / M, post.y / M, post.z / M);
      group.rotation.y = post.heading;
      group.add(new THREE.Mesh(this.stall, this.material));
      const figure = new PlayerFigure(avatarFromText(post.trader.look) ?? defaultAvatar(post.trader.name));
      figure.root.position.set(0, 0.2, -0.35);
      group.add(figure.root);
      const tag = nameTag(post.trader.name, figure.height + 0.5);
      tag.position.z = -0.35;
      const sign = nameTag(post.name, 3.6);
      group.add(tag, sign);
      const motion = new FigureMotion(performance.now());
      this.shown.push({ post, group, figure, motion });
      this.group.add(group);
    }
  }

  /** Each frame: those near drawn, lit with the day; their traders standing at their counters. */
  frame(camera: THREE.Vector3): void {
    const light = Math.max(0.15, this.daylight()), now = performance.now();
    this.material.color.setScalar(light);
    for (const s of this.shown) {
      const d = Math.hypot(s.group.position.x - camera.x, s.group.position.z - camera.z);
      s.group.visible = d < SHOWN_M;
      if (!s.group.visible) continue;
      s.figure.tint(light);
      if (d < ALIVE_M) {
        const p = s.group.position;
        s.figure.pose(poseFor(s.motion.step({ x: p.x * M, y: p.y * M, z: p.z * M }, now, 0, 0, null)));
      }
    }
  }

  /** The trading post whose stall a ray (units) meets within `maxDist` units, and how far. */
  pick(origin: readonly number[], dir: readonly number[], maxDist: number): { post: TradingPost; dist: number } | null {
    let best: { post: TradingPost; dist: number } | null = null;
    for (const s of this.shown) {
      const p = s.post, c = Math.cos(-p.heading), sn = Math.sin(-p.heading);
      const ox = origin[0]! - p.x, oy = origin[1]! - (p.y + 1.5 * M), oz = origin[2]! - p.z;
      const o = [ox * c + oz * sn, oy, -ox * sn + oz * c], d = [dir[0]! * c + dir[2]! * sn, dir[1]!, -dir[0]! * sn + dir[2]! * c];
      const half = [2.1 * M, 1.5 * M, 1.8 * M];
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
      if (near <= far && (!best || near < best.dist)) best = { post: p, dist: near };
    }
    return best;
  }
}
