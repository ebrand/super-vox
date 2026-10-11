import * as THREE from 'three';
import { Item, Material, saplingGrowth } from '@super-vox/shared';
import { materialColor } from './materials.js';

/** Each sapling's leaves, by its item: its tree's leaves' colour (linear RGB). */
const LEAVES: Record<number, number> = {
  [Item.OakSapling]: Material.Leaves,
  [Item.PineSapling]: Material.Needles,
  [Item.JungleSapling]: Material.JungleLeaves,
  [Item.AcaciaSapling]: Material.AcaciaLeaves,
};
const STEM = 0x5a3d24;

/**
 * Players' saplings (see World.saplings): each a stem and a tuft of its tree's leaves standing in
 * its block, taller as it grows (from when it was planted, by the server's clock), lit with the day.
 */
export class SaplingView {
  readonly group = new THREE.Group();
  private readonly stem = new THREE.BoxGeometry(0.08, 1, 0.08).translate(0, 0.5, 0);
  private readonly tuft = new THREE.BoxGeometry(1, 1, 1);
  private readonly stemMaterial = new THREE.MeshBasicMaterial({ color: STEM });
  private readonly leafMaterials = new Map<number, THREE.MeshBasicMaterial>();
  private readonly meshes: THREE.InstancedMesh[] = [];
  private saplings: readonly [number, number, number, number, number][] = [];
  private shownKey: string | null = null;
  private lookedAt = 0;

  constructor(
    private readonly daylight: () => number,
    /** Now, by the server's clock (ms). */
    private readonly serverNow: () => number,
  ) {}

  setSaplings(saplings: readonly [number, number, number, number, number][]): void {
    this.saplings = saplings;
    this.shownKey = null;
    this.lookedAt = 0;
    this.frame();
  }

  /** The sapling in a block (its item), or null. */
  at(bx: number, by: number, bz: number): number | null {
    return this.saplings.find(([x, y, z]) => x === bx && y === by && z === bz)?.[3] ?? null;
  }

  private leafMaterial(item: number): THREE.MeshBasicMaterial {
    let m = this.leafMaterials.get(item);
    if (!m) this.leafMaterials.set(item, (m = new THREE.MeshBasicMaterial()));
    return m;
  }

  /** Each frame: lit with the day; drawn again when any has grown a step (they grow over minutes). */
  frame(): void {
    const light = Math.max(0.15, this.daylight());
    this.stemMaterial.color.setHex(STEM).multiplyScalar(light);
    for (const [item, m] of this.leafMaterials) {
      const [r, g, b] = materialColor(LEAVES[item] ?? Material.Leaves);
      m.color.setRGB(r * 1.4 * light, g * 1.4 * light, b * 1.4 * light, THREE.LinearSRGBColorSpace);
    }
    if (performance.now() - this.lookedAt < 1000) return;
    this.lookedAt = performance.now();
    const now = this.serverNow();
    // (How big each is, in tenths: unchanged, nothing to do.)
    const shown = this.saplings.map(([x, y, z, item, planted]) => ({ x, y, z, item, size: Math.round(saplingGrowth(planted, now) * 10) / 10 }));
    const key = shown.map((s) => `${s.x},${s.y},${s.z}:${s.item}:${s.size}`).join(' ');
    if (key === this.shownKey) return;
    this.shownKey = key;
    for (const m of this.meshes) m.removeFromParent();
    this.meshes.length = 0;
    if (!shown.length) return;
    const matrix = new THREE.Matrix4(), scale = new THREE.Vector3(), at = new THREE.Vector3(), q = new THREE.Quaternion();
    // Stems: 0.4 m tall when planted, 1.2 m when about to grow.
    const stems = new THREE.InstancedMesh(this.stem, this.stemMaterial, shown.length);
    shown.forEach((s, i) => {
      const h = 0.4 + 0.8 * s.size;
      stems.setMatrixAt(i, matrix.compose(at.set(s.x + 0.5, s.y, s.z + 0.5), q, scale.set(1, h, 1)));
    });
    // Tufts: a box at the stem's top, wider as it grows (narrow and tall for pines).
    const byItem = new Map<number, typeof shown>();
    for (const s of shown) byItem.set(s.item, [...(byItem.get(s.item) ?? []), s]);
    const meshes: THREE.InstancedMesh[] = [stems];
    for (const [item, list] of byItem) {
      const tufts = new THREE.InstancedMesh(this.tuft, this.leafMaterial(item), list.length);
      list.forEach((s, i) => {
        const h = 0.4 + 0.8 * s.size, w = 0.25 + 0.35 * s.size, pine = item === Item.PineSapling;
        tufts.setMatrixAt(i, matrix.compose(at.set(s.x + 0.5, s.y + h * (pine ? 0.6 : 0.85), s.z + 0.5), q, scale.set(pine ? w * 0.7 : w, pine ? h * 0.7 : w * 0.8, pine ? w * 0.7 : w)));
      });
      meshes.push(tufts);
    }
    for (const m of meshes) {
      m.instanceMatrix.needsUpdate = true;
      m.frustumCulled = false;
      this.meshes.push(m);
      this.group.add(m);
    }
    this.frame();
  }
}
