import * as THREE from 'three';
import {
  BLOCK_SIZE,
  CHUNK_SIZE,
  GRID_SIZES,
  Material,
  UNITS_PER_METER,
  blockIndex,
  blockVoxelContaining,
  breakSizesFor,
  nextBreakSize,
  voxelAt,
  type ClientMessage,
  type Edit,
  type ServerMessage,
} from '@super-vox/shared';
import type { ChunkManager } from './chunkManager.js';
import { placementBox, raycastVoxels, type Box, type SolidAt } from './picking.js';

/** While scrolling continuously, wheel travel (pixels) per further voxel-size step. */
const WHEEL_STEP = 30;
/** A pause this long (ms) starts a new scroll: its first movement steps immediately. */
const WHEEL_GESTURE_GAP = 200;

/** How far away voxels can be edited (units): 32 m. */
const REACH = 32 * UNITS_PER_METER;

const MATERIALS = [
  { id: Material.Stone, name: 'stone' },
  { id: Material.Dirt, name: 'dirt' },
  { id: Material.Grass, name: 'grass' },
] as const;

const floorDiv = (v: number, m: number) => Math.floor(v / m);
const mod = (v: number, m: number) => ((v % m) + m) % m;

/**
 * Crosshair voxel editing: left click or X removes the voxel you aim at;
 * middle click breaks it into the next smaller size that divides it
 * (1 m -> 1/2 m -> 1/4 m ...); right click places a voxel of the selected
 * size against the face you aim at (a preview shows while Command is held;
 * holding Option moves it in 1/16 m steps instead of snapping to its size);
 * B breaks the aimed voxel into pieces of the selected size. [ and ] change
 * the size (1..16 units), 1-3 the material. The server applies edits and
 * sends back the changed chunks.
 */
/** Sizes the tool offers: the five that tile a 1 m block (1/16, 1/8, 1/4, 1/2, 1 m). */
export const TOOL_SIZES = GRID_SIZES;

/** "1 m", "1/2 m", ... "1/16 m" for a size in units. */
export function sizeLabel(size: number): string {
  return size === BLOCK_SIZE ? '1 m' : BLOCK_SIZE % size === 0 ? `1/${BLOCK_SIZE / size} m` : `${size}/16 m`;
}

export class EditTool {
  /** Index into TOOL_SIZES of the selected size. */
  private sizeIndex = TOOL_SIZES.indexOf(4);
  materialIndex = 0;
  private target: Box | null = null;
  private placement: (Box & { valid: boolean; reason: string }) | null = null;
  private message = '';
  private messageUntil = 0;
  private nextId = 1;
  private readonly pending = new Map<number, string>();
  private readonly outline: THREE.LineSegments;
  private readonly preview: THREE.Mesh;
  private readonly previewMaterial: THREE.MeshBasicMaterial;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;
  private readonly onBlur: () => void;
  /** The placement preview is only shown while Command (Meta) is held. */
  private showPreview = false;
  /** While Option (Alt) is held, placement moves in 1/16 m steps instead of snapping to the size. */
  private finePlacement = false;
  /** Accumulated wheel movement not yet turned into a size step. */
  private wheelTravel = 0;
  private lastWheelAt = -Infinity;

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly chunks: ChunkManager,
    private readonly send: (msg: ClientMessage) => void,
  ) {
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.outline = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0xffffff }));
    this.previewMaterial = new THREE.MeshBasicMaterial({ color: 0x40ff60, transparent: true, opacity: 0.3, depthWrite: false });
    this.preview = new THREE.Mesh(box, this.previewMaterial);
    this.outline.visible = this.preview.visible = false;
    scene.add(this.outline, this.preview);
    this.onKeyDown = (e) => {
      this.showPreview = e.metaKey;
      this.finePlacement = e.altKey;
      // Keep Alt from focusing a browser menu bar on some platforms.
      if (e.code === 'AltLeft' || e.code === 'AltRight') e.preventDefault();
      this.handleKey(e);
    };
    this.onKeyUp = (e) => {
      this.showPreview = e.metaKey;
      this.finePlacement = e.altKey;
      if (!e.metaKey) this.wheelTravel = 0;
    };
    this.onBlur = () => {
      this.showPreview = false;
      this.finePlacement = false;
    };
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  /** Selected size in units; always one of TOOL_SIZES. Setting snaps to the nearest. */
  get size(): number {
    return TOOL_SIZES[this.sizeIndex]!;
  }

  set size(units: number) {
    let best = 0;
    TOOL_SIZES.forEach((s, i) => {
      if (Math.abs(s - units) < Math.abs(TOOL_SIZES[best]! - units)) best = i;
    });
    this.sizeIndex = best;
  }

  /** Steps the size up (+1) or down (-1) through TOOL_SIZES, wrapping or stopping at the ends. */
  stepSize(dir: 1 | -1, wrap: boolean): void {
    const n = TOOL_SIZES.length;
    const next = this.sizeIndex + dir;
    this.sizeIndex = wrap ? (next + n) % n : Math.max(0, Math.min(n - 1, next));
  }

  get material(): (typeof MATERIALS)[number] {
    return MATERIALS[this.materialIndex]!;
  }

  /** Re-aims from the camera; call every frame. */
  update(): void {
    const origin = this.camera.getWorldPosition(new THREE.Vector3()).multiplyScalar(UNITS_PER_METER);
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const hit = raycastVoxels([origin.x, origin.y, origin.z], [dir.x, dir.y, dir.z], REACH, this.solidAt);
    this.target = hit ? this.voxelBox(hit.cell) : null;
    if (hit && this.target) {
      const p = placementBox(hit, this.target, this.size, this.finePlacement);
      let reason = p.valid ? '' : 'would cross a 1 m gridline';
      if (!reason) reason = this.occupied(p);
      this.placement = { ...p, valid: !reason, reason };
    } else {
      this.placement = null;
    }
    this.show(this.outline, this.target, 1.004);
    this.show(this.preview, this.showPreview ? this.placement : null, 0.999);
    this.previewMaterial.color.set(this.placement?.valid ? 0x40ff60 : 0xff4040);
  }

  /**
   * Mouse button from the camera controls: 0 = left (remove), 1 = middle
   * (break into the next smaller size that divides it), 2 = right (place).
   */
  click(button: number): void {
    if (button === 0) {
      this.remove();
    } else if (button === 1 && this.target) {
      const piece = nextBreakSize(this.target.size);
      if (piece === null) return this.say(`can't break a ${sizeLabel(this.target.size)} voxel any smaller`);
      this.submit({ op: 'break', x: this.target.x, y: this.target.y, z: this.target.z, pieceSize: piece }, 'break');
    } else if (button === 2 && this.placement) {
      if (!this.placement.valid) return this.say(`can't place: ${this.placement.reason}`);
      const { x, y, z, size } = this.placement;
      this.submit({ op: 'place', x, y, z, size, material: this.material.id }, 'place');
    }
  }

  /**
   * Scrolls through the tool sizes (wrapping): up is bigger. The first
   * movement of a scroll steps at once, however small, so a single nudge
   * always changes the size; continued scrolling steps every WHEEL_STEP pixels.
   * `now` is for tests.
   */
  scrollSize(deltaY: number, now = performance.now()): void {
    if (deltaY === 0) return;
    const newGesture = now - this.lastWheelAt > WHEEL_GESTURE_GAP;
    this.lastWheelAt = now;
    if (newGesture) {
      this.wheelTravel = 0;
      this.stepSize(deltaY < 0 ? 1 : -1, true);
      return;
    }
    this.wheelTravel += deltaY;
    while (Math.abs(this.wheelTravel) >= WHEEL_STEP) {
      const dir = this.wheelTravel < 0 ? 1 : -1;
      this.wheelTravel += dir * WHEEL_STEP;
      this.stepSize(dir, true);
    }
  }

  /** Handles editResult messages; returns true if the message was one. */
  onServerMessage(msg: ServerMessage): boolean {
    if (msg.type !== 'editResult') return false;
    const what = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (!msg.ok) this.say(`${what ?? 'edit'} failed: ${msg.error}`);
    return true;
  }

  hudLines(): string {
    const size = sizeLabel(this.size);
    const target = this.target ? `aiming at a ${sizeLabel(this.target.size)} voxel` : 'nothing in reach';
    const msg = performance.now() < this.messageUntil ? `\n${this.message}` : '';
    return (
      `tool: ${size} ${this.material.name} · ${target}\n` +
      'click/X: remove · middle-click: break smaller · right-click: place (⌘ preview, ⌥ fine 1/16 m) · B: break to size · ⌘+wheel or [ ]: size · 1-3: material' +
      msg
    );
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.outline.removeFromParent();
    this.preview.removeFromParent();
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.repeat) return;
    if (e.code === 'BracketLeft') this.stepSize(-1, false);
    else if (e.code === 'BracketRight') this.stepSize(1, false);
    else if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3') this.materialIndex = Number(e.code.slice(5)) - 1;
    else if (e.code === 'KeyX') this.remove();
    else if (e.code === 'KeyB' && this.target) {
      if (!breakSizesFor(this.target.size).includes(this.size)) {
        const options = breakSizesFor(this.target.size).map(sizeLabel).join(', ') || 'nothing smaller';
        this.say(`a ${sizeLabel(this.target.size)} voxel breaks into ${options}, not ${sizeLabel(this.size)}`);
        return;
      }
      this.submit({ op: 'break', x: this.target.x, y: this.target.y, z: this.target.z, pieceSize: this.size }, 'break');
    }
  }

  private remove(): void {
    if (this.target) this.submit({ op: 'remove', x: this.target.x, y: this.target.y, z: this.target.z }, 'remove');
  }

  private submit(edit: Edit, label: string): void {
    const id = this.nextId++;
    this.pending.set(id, label);
    this.send({ type: 'edit', id, edit });
  }

  /** Shows a message on the overlay for a few seconds. */
  say(text: string): void {
    this.message = text;
    this.messageUntil = performance.now() + 4000;
  }

  private readonly solidAt: SolidAt = (x, y, z) => {
    const chunk = this.chunks.chunkAt({ cx: floorDiv(x, CHUNK_SIZE), cy: floorDiv(y, CHUNK_SIZE), cz: floorDiv(z, CHUNK_SIZE) });
    if (chunk === undefined) return undefined;
    if (chunk === null) return false;
    return voxelAt(chunk, mod(x, CHUNK_SIZE), mod(y, CHUNK_SIZE), mod(z, CHUNK_SIZE)) !== null;
  };

  /** World box of the voxel covering unit cell `cell`. */
  private voxelBox([x, y, z]: [number, number, number]): Box | null {
    const chunk = this.chunks.chunkAt({ cx: floorDiv(x, CHUNK_SIZE), cy: floorDiv(y, CHUNK_SIZE), cz: floorDiv(z, CHUNK_SIZE) });
    if (!chunk) return null;
    const [lx, ly, lz] = [mod(x, CHUNK_SIZE), mod(y, CHUNK_SIZE), mod(z, CHUNK_SIZE)];
    const block = chunk.blocks[blockIndex(floorDiv(lx, BLOCK_SIZE), floorDiv(ly, BLOCK_SIZE), floorDiv(lz, BLOCK_SIZE))] ?? null;
    const v = blockVoxelContaining(block, mod(lx, BLOCK_SIZE), mod(ly, BLOCK_SIZE), mod(lz, BLOCK_SIZE));
    if (!v) return null;
    return { x: x - mod(x, BLOCK_SIZE) + v.x, y: y - mod(y, BLOCK_SIZE) + v.y, z: z - mod(z, BLOCK_SIZE) + v.z, size: v.size };
  }

  /** '' if every cell of the box is loaded and empty, else why not. */
  private occupied(b: Box): string {
    for (let y = b.y; y < b.y + b.size; y++) {
      for (let z = b.z; z < b.z + b.size; z++) {
        for (let x = b.x; x < b.x + b.size; x++) {
          const s = this.solidAt(x, y, z);
          if (s === undefined) return 'not loaded yet';
          if (s) return 'space is occupied';
        }
      }
    }
    return '';
  }

  private show(obj: THREE.Object3D, b: Box | null, scale: number): void {
    obj.visible = b !== null;
    if (!b) return;
    const s = b.size / UNITS_PER_METER;
    obj.scale.setScalar(s * scale);
    obj.position.set((b.x + b.size / 2) / UNITS_PER_METER, (b.y + b.size / 2) / UNITS_PER_METER, (b.z + b.size / 2) / UNITS_PER_METER);
  }
}
