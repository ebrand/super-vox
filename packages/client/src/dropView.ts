import * as THREE from 'three';
import { UNITS_PER_METER, deltaX, type DroppedItem, type ItemId, type WorldConfig } from '@super-vox/shared';
import { entityBrightness } from './entities.js';
import { iconSvg } from './icons.js';

/** How big a dropped thing is drawn (m), and how it bobs (m, per second). */
const SIZE = 0.42, BOB = 0.06, BOB_RATE = 2.2;

interface Shown {
  drop: DroppedItem;
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  phase: number;
  litAt: number;
}

/**
 * What's dropped on the ground (see DroppedItem): each drawn as its item's icon (see icons.ts),
 * facing the eye, bobbing a little above where it lies, shaded by the light there.
 */
export class DropView {
  private readonly shown = new Map<number, Shown>();
  private readonly textures = new Map<ItemId, THREE.Texture>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: WorldConfig,
    private readonly cameraX: () => number,
    private readonly light: (x: number, y: number, z: number) => { sky: number; block: number } | null = () => null,
    private readonly daylight: () => number = () => 1,
  ) {}

  /** What's on the ground now (from the server): new ones appear, gone ones (picked up) go. */
  setDrops(list: readonly DroppedItem[]): void {
    const seen = new Set<number>();
    for (const d of list) {
      seen.add(d.id);
      if (this.shown.has(d.id)) continue;
      const material = new THREE.SpriteMaterial({ map: this.texture(d.item), transparent: true, depthWrite: false });
      const sprite = new THREE.Sprite(material);
      sprite.scale.setScalar(SIZE);
      sprite.name = `drop ${d.id}`;
      this.scene.add(sprite);
      this.shown.set(d.id, { drop: d, sprite, material, phase: (d.id * 1.7) % (Math.PI * 2), litAt: -Infinity });
    }
    for (const [id, s] of this.shown) {
      if (seen.has(id)) continue;
      this.scene.remove(s.sprite);
      s.material.dispose();
      this.shown.delete(id);
    }
  }

  /** Places them for this frame. */
  frame(now = performance.now()): void {
    const camX = this.cameraX();
    for (const s of this.shown.values()) {
      const d = s.drop;
      const x = camX + deltaX(this.world, camX, d.x);
      const bob = SIZE / 2 + 0.08 + Math.sin((now / 1000) * BOB_RATE + s.phase) * BOB;
      s.sprite.position.set(x / UNITS_PER_METER, d.y / UNITS_PER_METER + bob, d.z / UNITS_PER_METER);
      if (now - s.litAt > 500) {
        s.litAt = now;
        const l = this.light(d.x, d.y + 4, d.z);
        s.material.color.setScalar(l ? entityBrightness(l.sky, l.block, this.daylight()) : 1);
      }
    }
  }

  get count(): number {
    return this.shown.size;
  }

  /** An item's icon as a texture (made once; until it's drawn, plain). */
  private texture(item: ItemId): THREE.Texture {
    let t = this.textures.get(item);
    if (t) return t;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    this.textures.set(item, t);
    const svg = iconSvg(item);
    const ctx = canvas.getContext('2d');
    if (!ctx) return t;
    if (!svg) {
      ctx.fillStyle = '#c08060';
      ctx.fillRect(12, 12, 40, 40);
      t.needsUpdate = true;
      return t;
    }
    const img = new Image();
    const texture = t;
    img.onload = () => {
      ctx.drawImage(img, 0, 0, 64, 64);
      texture.needsUpdate = true;
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace('width="100%" height="100%"', 'width="64" height="64"'))}`;
    return t;
  }
}
