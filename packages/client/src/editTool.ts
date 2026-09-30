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
import { digBox, placementBox, raycastVoxels, type Box, type SolidAt } from './picking.js';

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

/** Sizes the tool offers: the five that tile a 1 m block (1/16, 1/8, 1/4, 1/2, 1 m). */
export const TOOL_SIZES = GRID_SIZES;

/** Tool modes, in the order Tab cycles through them. */
export const MODES = ['off', 'dig', 'place'] as const;
export type Mode = (typeof MODES)[number];

/** "1 m", "1/2 m", ... "1/16 m" for a size in units. */
export function sizeLabel(size: number): string {
  return size === BLOCK_SIZE ? '1 m' : BLOCK_SIZE % size === 0 ? `1/${BLOCK_SIZE / size} m` : `${size}/16 m`;
}

/** Modifier keys held at the time of an action. */
export interface Modifiers {
  meta: boolean;
  alt: boolean;
}

const floorDiv = (v: number, m: number) => Math.floor(v / m);
const mod = (v: number, m: number) => ((v % m) + m) % m;

/**
 * Crosshair voxel editing, in three modes cycled with Tab:
 *
 * - off: no editing; clicks only capture the mouse.
 * - dig: left click removes the voxel you aim at. Holding Command shows the
 *   dig box (the selected size, just inside the surface you aim at): its
 *   entry face is marked on that surface and its volume shows faintly through
 *   the ground. Command + left click removes every voxel with any part inside it.
 * - place: a preview of the selected size shows against the face you aim
 *   at; left click places it.
 *
 * In dig and place, Option positions the box in 1/16 m steps instead of
 * snapping to its size, middle click breaks the aimed voxel into the next
 * smaller size, B breaks it into the selected size, X removes it. The size
 * (one of the five standard sizes) changes with Command+wheel or [ ], the
 * material with 1-3. The server applies edits and sends back changed chunks.
 */
export class EditTool {
  mode: Mode = 'off';
  /** Index into TOOL_SIZES of the selected size. */
  private sizeIndex = TOOL_SIZES.indexOf(4);
  materialIndex = 0;
  private target: Box | null = null;
  private placement: (Box & { valid: boolean; reason: string }) | null = null;
  private dig: Box | null = null;
  /** Outward normal of the face the dig box starts at (the surface aimed at). */
  private digNormal: [number, number, number] = [0, 1, 0];
  private message = '';
  private messageUntil = 0;
  private nextId = 1;
  private readonly pending = new Map<number, string>();
  private readonly outline: THREE.LineSegments;
  private readonly preview: THREE.Mesh;
  private readonly previewMaterial: THREE.MeshBasicMaterial;
  private readonly digPreview: THREE.Mesh;
  /** The dig box's entry face, drawn on the surface so it's clear where digging starts. */
  private readonly digEntry: THREE.Group;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;
  private readonly onBlur: () => void;
  private readonly modifiers: Modifiers = { meta: false, alt: false };
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
    // The dig box's volume lies inside solid ground, so it is drawn faintly through everything.
    this.digPreview = new THREE.Mesh(
      box,
      new THREE.MeshBasicMaterial({ color: 0xff8a20, transparent: true, opacity: 0.18, depthWrite: false, depthTest: false }),
    );
    this.digPreview.renderOrder = 10;
    // Its entry face sits on the aimed surface and is depth-tested, so it reads as lying on it.
    const plane = new THREE.PlaneGeometry(1, 1);
    const entryFill = new THREE.Mesh(
      plane,
      new THREE.MeshBasicMaterial({
        color: 0xff8a20, transparent: true, opacity: 0.55, depthWrite: false,
        side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }),
    );
    const entryBorder = new THREE.LineSegments(new THREE.EdgesGeometry(plane), new THREE.LineBasicMaterial({ color: 0xffc070 }));
    this.digEntry = new THREE.Group().add(entryFill, entryBorder);
    this.digEntry.renderOrder = 11;
    this.outline.visible = this.preview.visible = this.digPreview.visible = this.digEntry.visible = false;
    scene.add(this.outline, this.preview, this.digPreview, this.digEntry);
    this.onKeyDown = (e) => {
      this.readModifiers(e);
      this.handleKey(e);
    };
    this.onKeyUp = (e) => {
      this.readModifiers(e);
      if (!e.metaKey) this.wheelTravel = 0;
    };
    this.onBlur = () => {
      this.modifiers.meta = this.modifiers.alt = false;
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

  /** Switches to the next mode (off -> dig -> place -> off). */
  cycleMode(): void {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]!;
  }

  /** Re-aims from the camera; call every frame. */
  update(): void {
    this.target = this.placement = this.dig = null;
    if (this.mode !== 'off') {
      const origin = this.camera.getWorldPosition(new THREE.Vector3()).multiplyScalar(UNITS_PER_METER);
      const dir = this.camera.getWorldDirection(new THREE.Vector3());
      const hit = raycastVoxels([origin.x, origin.y, origin.z], [dir.x, dir.y, dir.z], REACH, this.solidAt);
      this.target = hit ? this.voxelBox(hit.cell) : null;
      if (hit && this.target) {
        const fine = this.modifiers.alt;
        if (this.mode === 'place') {
          const p = placementBox(hit, this.target, this.size, fine);
          const reason = p.valid ? this.occupied(p) : 'would cross a 1 m gridline';
          this.placement = { ...p, valid: !reason, reason };
        } else if (this.modifiers.meta) {
          this.dig = digBox(hit, this.target, this.size, fine);
          this.digNormal = hit.normal;
        }
      }
    }
    this.show(this.outline, this.target, 1.004);
    this.show(this.preview, this.placement, 0.999);
    this.show(this.digPreview, this.dig, 1.002);
    this.showEntry();
    this.previewMaterial.color.set(this.placement?.valid ? 0x40ff60 : 0xff4040);
  }

  /**
   * A mouse button pressed while the mouse is captured: 0 = left, 1 = middle.
   * `mods` are the modifier keys held at that moment.
   */
  click(button: number, mods: Modifiers = this.modifiers): void {
    this.modifiers.meta = mods.meta;
    this.modifiers.alt = mods.alt;
    if (this.mode === 'off') return;
    this.update(); // aim with the modifiers as they are right now
    if (button === 1) return this.breakSmaller();
    if (button !== 0) return;
    if (this.mode === 'place') {
      if (!this.placement) return;
      if (!this.placement.valid) return this.say(`can't place: ${this.placement.reason}`);
      const { x, y, z, size } = this.placement;
      this.submit({ op: 'place', x, y, z, size, material: this.material.id }, 'place');
    } else if (this.dig) {
      const { x, y, z, size } = this.dig;
      this.submit({ op: 'removeBox', x, y, z, size }, 'dig');
    } else {
      this.remove();
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
    const msg = performance.now() < this.messageUntil ? `\n${this.message}` : '';
    if (this.mode === 'off') return 'mode: off (Tab: dig / place)' + msg;
    const size = sizeLabel(this.size);
    const target = this.target ? `aiming at a ${sizeLabel(this.target.size)} voxel` : 'nothing in reach';
    const actions =
      this.mode === 'dig'
        ? 'click: remove · ⌘+click: remove everything in the box (⌘ shows it)'
        : 'click: place';
    return (
      `mode: ${this.mode} (Tab) · ${size} ${this.material.name} · ${target}\n` +
      `${actions} · ⌥: 1/16 m steps · middle-click: break smaller · B: break to size · X: remove · ⌘+wheel or [ ]: size · 1-3: material` +
      msg
    );
  }

  /** Shows a message on the overlay for a few seconds. */
  say(text: string): void {
    this.message = text;
    this.messageUntil = performance.now() + 4000;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.outline.removeFromParent();
    this.preview.removeFromParent();
    this.digPreview.removeFromParent();
    this.digEntry.removeFromParent();
  }

  private readModifiers(e: KeyboardEvent): void {
    this.modifiers.meta = e.metaKey;
    this.modifiers.alt = e.altKey;
  }

  private handleKey(e: KeyboardEvent): void {
    // Tab and Alt have browser defaults (focus moves, menu bar); the game uses them.
    if (e.code === 'Tab' || e.code === 'AltLeft' || e.code === 'AltRight') e.preventDefault();
    if (e.ctrlKey || e.repeat || (e.metaKey && e.code !== 'MetaLeft' && e.code !== 'MetaRight')) return;
    if (e.code === 'Tab') {
      this.cycleMode();
      return;
    }
    if (e.code === 'BracketLeft') this.stepSize(-1, false);
    else if (e.code === 'BracketRight') this.stepSize(1, false);
    else if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3') this.materialIndex = Number(e.code.slice(5)) - 1;
    else if (this.mode === 'off') return;
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

  private breakSmaller(): void {
    if (!this.target) return;
    const piece = nextBreakSize(this.target.size);
    if (piece === null) return this.say(`can't break a ${sizeLabel(this.target.size)} voxel any smaller`);
    this.submit({ op: 'break', x: this.target.x, y: this.target.y, z: this.target.z, pieceSize: piece }, 'break');
  }

  private remove(): void {
    if (this.target) this.submit({ op: 'remove', x: this.target.x, y: this.target.y, z: this.target.z }, 'remove');
  }

  private submit(edit: Edit, label: string): void {
    const id = this.nextId++;
    this.pending.set(id, label);
    this.send({ type: 'edit', id, edit });
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

  /** Places the entry-face marker on the dig box's face that lies on the aimed surface. */
  private showEntry(): void {
    const b = this.dig;
    this.digEntry.visible = b !== null;
    if (!b) return;
    const n = new THREE.Vector3(...this.digNormal);
    const s = b.size / UNITS_PER_METER;
    const center = new THREE.Vector3(b.x + b.size / 2, b.y + b.size / 2, b.z + b.size / 2).divideScalar(UNITS_PER_METER);
    // The face on the surface is the one the normal points out of; lift it a hair off the surface.
    this.digEntry.position.copy(center).addScaledVector(n, s / 2 + 0.002);
    this.digEntry.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    this.digEntry.scale.set(s, s, 1);
  }

  private show(obj: THREE.Object3D, b: Box | null, scale: number): void {
    obj.visible = b !== null;
    if (!b) return;
    obj.scale.setScalar((b.size / UNITS_PER_METER) * scale);
    obj.position.set((b.x + b.size / 2) / UNITS_PER_METER, (b.y + b.size / 2) / UNITS_PER_METER, (b.z + b.size / 2) / UNITS_PER_METER);
  }
}
