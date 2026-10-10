import * as THREE from 'three';
import { RIPE, cropStage, type Village } from '@super-vox/shared';

/** Each stage's stalks: how tall (m), and their colour (sown, shoots, green, ripe). */
const STAGES: { h: number; color: number }[] = [
  { h: 0.08, color: 0x6f8f3a },
  { h: 0.32, color: 0x5f9a35 },
  { h: 0.62, color: 0x7aa33c },
  { h: 0.85, color: 0xd8b545 },
];
/** Stalks to a block: where in it (m across, along), a little off a grid. */
const STALKS: [number, number][] = [
  [0.2, 0.18], [0.5, 0.22], [0.8, 0.17], [0.22, 0.5], [0.52, 0.47], [0.79, 0.52], [0.18, 0.82], [0.49, 0.8], [0.81, 0.83],
];

/** A block's stalks of a stage, as one geometry: thin boxes standing on its floor (its least corner at the origin); ripe, with ears. */
function stalksGeometry(stage: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const { h } = STAGES[stage]!;
  for (const [x, z] of STALKS) {
    const g = new THREE.BoxGeometry(0.05, h, 0.05);
    g.translate(x, h / 2, z);
    parts.push(g);
    if (stage === RIPE) {
      const ear = new THREE.BoxGeometry(0.09, 0.16, 0.09);
      ear.translate(x, h + 0.05, z);
      parts.push(ear);
    }
  }
  // (One geometry: the parts' positions merged.)
  const pos: number[] = [];
  for (const p of parts) {
    const ni = p.toNonIndexed(), a = ni.getAttribute('position');
    for (let i = 0; i < a.count; i++) pos.push(a.getX(i), a.getY(i), a.getZ(i));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/**
 * Wheat on the villages' fields (see villages.ts): each sown block's stalks, as tall and as gold as
 * its stage (worked out from when it was sown, by the server's clock), lit with the day.
 */
export class CropView {
  readonly group = new THREE.Group();
  private readonly materials = STAGES.map((s) => new THREE.MeshBasicMaterial({ color: s.color }));
  private readonly geometries = STAGES.map((_, i) => stalksGeometry(i));
  private readonly meshes: THREE.InstancedMesh[] = [];
  private villages: readonly Village[] = [];
  private shownKey = '';
  private lookedAt = 0;

  constructor(
    private readonly daylight: () => number,
    /** Now, by the server's clock (ms). */
    private readonly serverNow: () => number,
  ) {}

  setVillages(villages: readonly Village[]): void {
    this.villages = villages;
    this.shownKey = '';
    this.lookedAt = 0;
    this.frame();
  }

  /** Each frame: lit with the day; the stalks made again when any block's stage has changed. */
  frame(): void {
    const light = Math.max(0.15, this.daylight());
    STAGES.forEach((s, i) => this.materials[i]!.color.setHex(s.color).multiplyScalar(light));
    // (Looked at a second at a time: stages take minutes.)
    if (performance.now() - this.lookedAt < 1000) return;
    this.lookedAt = performance.now();
    const now = this.serverNow();
    // (What stage every block's at, as a key: unchanged, nothing to do.)
    const blocks: { x: number; y: number; z: number; stage: number }[] = [];
    for (const v of this.villages)
      for (const f of v.fields) {
        if (!f.tilled) continue;
        f.sown.forEach((s, i) => {
          const stage = cropStage(s, now);
          if (stage >= 0) blocks.push({ x: f.bx + (i % f.w), y: f.tops[i]!, z: f.bz + Math.floor(i / f.w), stage });
        });
      }
    const key = blocks.map((b) => b.stage).join('');
    if (key === this.shownKey) return;
    this.shownKey = key;
    for (const m of this.meshes) m.removeFromParent();
    this.meshes.length = 0;
    const matrix = new THREE.Matrix4();
    STAGES.forEach((_, stage) => {
      const these = blocks.filter((b) => b.stage === stage);
      if (!these.length) return;
      const mesh = new THREE.InstancedMesh(this.geometries[stage]!, this.materials[stage]!, these.length);
      these.forEach((b, i) => mesh.setMatrixAt(i, matrix.makeTranslation(b.x, b.y, b.z)));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.group.add(mesh);
    });
  }
}
