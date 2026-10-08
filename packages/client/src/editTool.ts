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
  editMiningTime,
  isTool,
  canPlace,
  canHarvest,
  pickaxeTierFor,
  BIG_BOX_SIZES,
  facingOfYaw,
  ATTACK_REACH,
  Item,
  isBlock,
  isWater,
  BOAT,
  drawCharge,
  isObjectMaterial,
  isUsableMaterial,
  isFood,
  isExplosive,
  itemName,
  materialName,
  objectKindOf,
  inObjectParts,
  objectCells,
  ownsWholeBlocks,
  objectName,
  designById,
  designOfItem,
  designAnchor,
  designOrigin,
  designSpan,
  designVoxelBox,
  usable,
  isBed,
  isStationKind,
  isSword,
  rockNote,
  SWORDS,
  objectStation,
  type PlacedObject,
  type ItemId,
  MIN_VOXEL_SIZE,
  nextBreakSize,
  type ClientMessage,
  type Edit,
  type MaterialId,
  type ServerMessage,
} from '@super-vox/shared';
import type { ChunkManager } from './chunkManager.js';
import type { Aabb } from './physics.js';
import { digBox, placementBox, raycastVoxels, type Box, type SolidAt } from './picking.js';
import { solidAtFor, waterAtFor } from './worldQuery.js';

/** While scrolling continuously, wheel travel (pixels) per further voxel-size step. */
const WHEEL_STEP = 30;
/** A pause this long (ms) starts a new scroll: its first movement steps immediately. */
const WHEEL_GESTURE_GAP = 200;

/** How far away voxels can be edited (units): 32 m. */
const REACH = 32 * UNITS_PER_METER;



/** Sizes the tool offers: the five that tile a 1 m block (1/16, 1/8, 1/4, 1/2, 1 m). */
export const TOOL_SIZES = GRID_SIZES;

/** Tool modes, in the order Tab cycles through them; the first is the default. */
export const MODES = ['hybrid', 'dig', 'place'] as const;
export type Mode = (typeof MODES)[number];

/** "1 m", "1/2 m", ... "1/16 m" for a size in units. */
export function sizeLabel(size: number): string {
  return size >= BLOCK_SIZE && size % BLOCK_SIZE === 0 ? `${size / BLOCK_SIZE} m` : BLOCK_SIZE % size === 0 ? `1/${BLOCK_SIZE / size} m` : `${size}/16 m`;
}

/** Modifier keys held at the time of an action. */
export interface Modifiers {
  meta: boolean;
  alt: boolean;
  /** (Middle click: break the aimed voxel all the way down, to 1/16 m.) */
  shift?: boolean;
}

/** The standard tool size closest to `size` (ties go to the smaller). */
function nearestToolSize(size: number): number {
  return TOOL_SIZES.reduce((best, s) => (Math.abs(s - size) < Math.abs(best - size) ? s : best));
}

const floorDiv = (v: number, m: number) => Math.floor(v / m);
/** What a sword cuts. */
const LEAVES = new Set<number>([Material.Leaves, Material.Needles, Material.JungleLeaves, Material.AcaciaLeaves]);
const mod = (v: number, m: number) => ((v % m) + m) % m;

/**
 * Crosshair voxel editing, in three modes cycled with Tab:
 *
 * - hybrid (default, Minecraft-like): left click removes the voxel you aim
 *   at, right click places a voxel of the hotbar's material, the same size as
 *   the voxel aimed at, against its face, snapped to that size so voxels stack
 *   simply. While Command is held, the wheel picks a different size (previewed)
 *   for placements made with it still held; letting go matches the target
 *   again. Otherwise only the target outline shows. Right click opens and
 *   closes gates and doors, and places the fence, gate or door in hand.
 * - dig: left click removes the voxel you aim at. Holding Command shows the
 *   dig box (the selected size, just inside the surface you aim at): its
 *   entry face is marked on that surface and its volume shows faintly through
 *   the ground. Command + left click removes every voxel with any part inside it.
 * - place: a preview of the selected size shows against the face you aim
 *   at; left click places it.
 *
 * In dig and place, Option positions the box in 1/16 m steps instead of
 * snapping to its size. In every mode, middle click breaks the aimed voxel into the next
 * smaller size (with Shift, into 1/16 m voxels), B breaks it into the selected size, X removes it. The size
 * (one of the five standard sizes) changes with Command+wheel or [ ]; the material is the
 * selected hotbar slot (see InventoryUi; water fills whole blocks and flows). The server applies
 * edits (in survival, from your inventory) and sends back changed chunks.
 */
export class EditTool {
  mode: Mode = MODES[0];
  /** Called whenever the mode changes (and once when set), e.g. to update an on-screen tag. */
  onModeChange: ((mode: Mode) => void) | null = null;
  /** Called when the size chosen changes (see chosenSize): stepped through, or (hybrid) let go of with ⌘. */
  onSizeChange: ((size: number | null) => void) | null = null;

  /**
   * The size (units) placing and digging will use, to show: in dig and place, the selected size; in
   * hybrid while ⌘ is held, the one placed (picked with ⌘+wheel, or matching what's aimed at); else
   * null (hybrid without ⌘: it matches whatever's aimed at, as it goes).
   */
  get chosenSize(): number | null {
    if (this.mode !== 'hybrid') return this.size;
    if (!this.modifiers.meta) return null;
    return this.hybridSize ?? (this.target ? nearestToolSize(this.target.size) : null);
  }
  /** Index into TOOL_SIZES of the selected size. */
  private sizeIndex = TOOL_SIZES.indexOf(4);
  private target: Box | null = null;
  /** The aimed voxel's material, and the unit cell and face the aim hit (for objects). */
  private targetMaterial: MaterialId | null = null;
  private hit: { cell: [number, number, number]; normal: [number, number, number]; point: [number, number, number]; distance: number } | null = null;
  /** Finds a mob along a ray (units), for hitting it (set by the game; see EntityView.pick). */
  pickEntity: ((origin: readonly number[], dir: readonly number[], maxDist: number) => { id: number; dist: number } | null) | null = null;
  /** Finds a boat along a ray (units), to get into or take (set by the game; see BoatView.pick). */
  pickBoat: ((origin: readonly number[], dir: readonly number[], maxDist: number) => { id: number; dist: number } | null) | null = null;
  /** We're in boat `id` now (the server said so). */
  onBoarded: ((id: number) => void) | null = null;
  /** A bow let go, drawn `charge` (0..1): shoot (the game sends it, from the eye, the way we look). */
  onShoot: ((charge: number) => void) | null = null;
  /** When the bow in hand started being drawn (right button held; ms), if it is. */
  private drawnAt: number | null = null;

  /** How far the bow in hand is drawn (0..1), if it's being drawn. */
  get bowDraw(): number | null {
    return this.drawnAt === null ? null : drawCharge(performance.now() - this.drawnAt);
  }

  /**
   * Whether what's in hand breaks voxels (and takes down objects and boats), in hybrid: a pickaxe,
   * an axe, a shovel, or nothing (a bare hand: a new survival player has no tools). Anything else
   * (a sword, food, a bow, a block...) doesn't.
   */
  get breaks(): boolean {
    const held = this.materialOf();
    return held === null || isTool(held);
  }

  /**
   * Whether the voxel aimed at is outlined (hybrid): when what's in hand can do something to it or
   * against it (break it; place a block, an object, a torch there; a bucket, a hammer, a boat), or
   * it's something anything can (light an explosive; cut leaves with a sword; open a door, a gate,
   * a design that changes, a station or a bed). Not with a sword at stone, or pork, say.
   */
  private outlined(): boolean {
    if (this.mode !== 'hybrid' || this.breaks) return true;
    const held = this.materialOf()!;
    const m = this.targetMaterial;
    if (held === Item.Bucket || held === Item.Boat || held === Item.GeologistsHammer) return true;
    if (isBlock(held) ? canPlace(held, this.survival ? 'survival' : 'creative') : objectKindOf(held) !== null || !!designOfItem(held)) return true;
    if (m !== null && (isExplosive(m) || isUsableMaterial(m) || (isSword(held) && LEAVES.has(m)))) return true;
    const design = this.aimedDesign();
    return !!design && (isBed(design) || isStationKind(objectStation(design)) || usable(design));
  }

  /**
   * Hybrid, a block in hand: the size a click would place (picked to match the voxel aimed at, or
   * chosen with ⌘+wheel), and why it wouldn't fit, if it wouldn't; null otherwise.
   */
  get placing(): { size: number; why: string } | null {
    const held = this.materialOf();
    if (this.mode !== 'hybrid' || !this.placement || held === null || !isBlock(held) || !canPlace(held, this.survival ? 'survival' : 'creative')) return null;
    return { size: this.placement.size, why: this.placement.valid ? '' : this.placement.reason };
  }

  /** Whether something's being mined (survival, the button held). */
  get miningNow(): boolean {
    return this.mining !== null;
  }
  /** Requests to get into a boat, by message id: the boat's. */
  private readonly boarding = new Map<number, number>();
  private placement: (Box & { valid: boolean; reason: string }) | null = null;
  private dig: Box | null = null;
  /** Outward normal of the face the dig box starts at (the surface aimed at). */
  private digNormal: [number, number, number] = [0, 1, 0];
  private message = '';
  private messageUntil = 0;
  private nextId = 1;
  private readonly pending = new Map<number, string>();
  private readonly outline: THREE.LineSegments;
  /** Where a designed object in hand would go, when one's aimed somewhere: the box around its voxels (green)... */
  private readonly designPreview: THREE.Object3D;
  /** ...and the 1 m blocks it would take (amber; off the grid, a block more along each shifted axis). */
  private readonly designBlocksPreview: THREE.Object3D;
  /** Designed objects placed in the world (see setPlacedObjects), by each block they take ("bx,by,bz"; off the grid, several may share one). */
  private readonly designCells = new Map<string, PlacedObject[]>();
  /** Round worlds: blocks around (block X wraps); null: they don't. */
  wrapBlocks: number | null = null;
  private readonly preview: THREE.Mesh;
  private readonly previewMaterial: THREE.MeshBasicMaterial;
  private readonly digPreview: THREE.Mesh;
  /** The dig box's entry face, drawn on the surface so it's clear where digging starts. */
  private readonly digEntry: THREE.Group;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;
  private readonly onBlur: () => void;
  private readonly modifiers: Modifiers = { meta: false, alt: false };
  /** Hybrid mode: size chosen with Command+wheel, overriding "match the target" while Command is held. */
  private hybridSize: number | null = null;
  /** Accumulated wheel movement not yet turned into a size step. */
  private wheelTravel = 0;
  private lastWheelAt = -Infinity;
  /**
   * Survival: removing is mining, holding the left button for as long as what's aimed at takes
   * (see mining.ts; the server checks), with the progress shown (onMiningProgress: 0..1, or null).
   */
  survival = false;
  /** Right-clicked a furnace or stove (see stations.ts): to open it. */
  onStation: ((o: PlacedObject) => void) | null = null;
  /** Whenever the tool says something (see say): to show it on screen. */
  onSay: ((text: string) => void) | null = null;
  /** A geologist's hammer tapped on `material` (for its sound). */
  onTap: ((material: MaterialId) => void) | null = null;
  onMiningProgress: ((fraction: number | null) => void) | null = null;
  /** The left button held to mine; what's being mined (and since when, needing how long, ms); what was last mined. */
  private miningHeld = false;
  private mining: { key: string; edit: Edit & { op: 'remove' | 'removeBox' }; start: number; need: number } | null = null;
  private mined: string | null = null;

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly chunks: ChunkManager,
    private readonly send: (msg: ClientMessage) => void,
    /** The material to place (the selected hotbar slot), if any. */
    private readonly materialOf: () => MaterialId | null,
    /** The player's body (units), which placement must not overlap; null if not colliding. */
    private readonly body: () => Aabb | null = () => null,
  ) {
    this.solidAt = solidAtFor(chunks);
    const waterAt = waterAtFor(chunks);
    // With a bucket in hand, water stops the aim (to fill it there).
    this.solidOrWaterAt = (x, y, z) => {
      const s = this.solidAt(x, y, z);
      if (s !== false) return s;
      return waterAt(x, y, z);
    };
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.outline = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0xffffff }));
    this.designPreview = seeThroughOutline(box, 0x40ff60);
    this.designPreview.visible = false;
    scene.add(this.designPreview);
    this.designBlocksPreview = seeThroughOutline(box, 0xffb030);
    this.designBlocksPreview.visible = false;
    scene.add(this.designBlocksPreview);
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
      // (Typing in a text field, such as the inventory's search: not for the tool.)
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      this.handleKey(e);
    };
    this.onKeyUp = (e) => {
      this.readModifiers(e);
      if (!e.metaKey) this.wheelTravel = 0;
    };
    this.onBlur = () => {
      this.setMeta(false);
      this.modifiers.alt = false;
    };
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  /**
   * Creative: dig and place modes also have boxes over 1 m (BIG_BOX_SIZES): dig boxes, and fill
   * boxes in place mode (whole 1 m blocks of the material, replacing what's there).
   */
  bigBoxes = false;

  /** The sizes to choose from in this mode. */
  private sizes(): readonly number[] {
    return this.bigBoxes && this.mode !== 'hybrid' ? [...TOOL_SIZES, ...BIG_BOX_SIZES] : TOOL_SIZES;
  }

  /** Selected size in units; always one of the sizes on offer (see sizes). Setting snaps to the nearest. */
  get size(): number {
    const sizes = this.sizes();
    return sizes[Math.min(this.sizeIndex, sizes.length - 1)]!;
  }

  set size(units: number) {
    const sizes = this.sizes();
    let best = 0;
    sizes.forEach((s, i) => {
      if (Math.abs(s - units) < Math.abs(sizes[best]! - units)) best = i;
    });
    this.sizeIndex = best;
  }

  /**
   * Size of a voxel placed against `target`. In hybrid mode: a size chosen
   * with Command+wheel while Command is still held, else the target's own
   * size (so voxels stack like-for-like; the nearest standard size if it
   * isn't one). Otherwise the selected size.
   */
  placeSize(target: Box): number {
    if (this.mode !== 'hybrid') return this.size;
    // A size chosen with Command+wheel holds while Command does.
    if (this.hybridSize !== null && this.modifiers.meta) return this.hybridSize;
    return nearestToolSize(target.size);
  }

  /**
   * Steps the size up (+1) or down (-1) through TOOL_SIZES, wrapping or
   * stopping at the ends. In hybrid mode this picks the size of the next
   * placement, starting from the size it would otherwise have.
   */
  stepSize(dir: 1 | -1, wrap: boolean): void {
    const n = this.sizes().length;
    const from =
      this.mode === 'hybrid'
        ? TOOL_SIZES.indexOf(this.hybridSize ?? (this.target ? nearestToolSize(this.target.size) : this.size))
        : Math.min(this.sizeIndex, n - 1);
    const next = from + dir;
    const index = wrap ? (next + n) % n : Math.max(0, Math.min(n - 1, next));
    if (this.mode === 'hybrid') this.hybridSize = TOOL_SIZES[index]!;
    else this.sizeIndex = index;
    this.toldSize = undefined; // (stepped: say so, even if it's come round to the same)
    this.tellSize();
  }

  /** The material placements use (the selected hotbar slot), if any. */
  get material(): { id: MaterialId; name: string } | null {
    const id = this.materialOf();
    return id === null ? null : { id, name: itemName(id) };
  }

  /** Switches to the next mode (hybrid -> dig -> place -> hybrid). */
  cycleMode(): void {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]!;
    this.hybridSize = null;
    this.onModeChange?.(this.mode);
  }

  /** The designed objects placed in the world (from the server: see the `objects` message). */
  setPlacedObjects(objects: readonly PlacedObject[]): void {
    this.designCells.clear();
    for (const o of objects)
      for (const [dx, dy, dz] of objectCells(o)) {
        const key = `${this.wrapBlock(o.x + dx)},${o.y + dy},${o.z + dz}`;
        this.designCells.set(key, [...(this.designCells.get(key) ?? []), o]);
      }
  }

  private wrapBlock(bx: number): number {
    const n = this.wrapBlocks;
    return n ? ((bx % n) + n) % n : bx;
  }

  /** The designed object aimed at, if it's one. */
  private aimedDesign(): PlacedObject | undefined {
    if (!this.target) return undefined;
    const b = (v: number) => floorDiv(v, BLOCK_SIZE);
    const here = this.designCells.get(`${this.wrapBlock(b(this.target.x))},${b(this.target.y)},${b(this.target.z)}`) ?? [];
    // (A design may share its blocks with what's beside it, other designs too: only within its parts.)
    const B = BLOCK_SIZE, n = this.wrapBlocks ? this.wrapBlocks * B : null;
    const target = this.target;
    return here.find((o) => {
      if (ownsWholeBlocks(o)) return true;
      let x = target.x - o.x * B;
      if (n) x = ((x % n) + n) % n;
      return inObjectParts(o, x, target.y - o.y * B, target.z - o.z * B);
    });
  }

  /** The block an object placed now would go in (beside the face aimed at), and the way it would face. */
  private objectSpot(): { x: number; y: number; z: number; facing: ReturnType<typeof facingOfYaw> } | null {
    if (!this.hit) return null;
    const [x, y, z] = this.hit.cell.map((c, a) => floorDiv(c + this.hit!.normal[a]!, BLOCK_SIZE)) as [number, number, number];
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    return { x, y, z, facing: facingOfYaw(Math.atan2(-dir.x, -dir.z)) };
  }

  /**
   * Where a design placed now would go, to the 1/4 m (see designAnchor): the block its front row's
   * middle stands in, and its shift from the 1 m grid (units).
   */
  private designSpot(): { x: number; y: number; z: number; offset: [number, number, number]; facing: ReturnType<typeof facingOfYaw> } | null {
    const spot = this.objectSpot();
    if (!spot || !this.hit) return null;
    const anchor = designAnchor(this.hit.cell, this.hit.normal, this.hit.point);
    const [x, y, z] = anchor.map((v) => floorDiv(v, BLOCK_SIZE)) as [number, number, number];
    return { x, y, z, offset: [anchor[0] - x * BLOCK_SIZE, anchor[1] - y * BLOCK_SIZE, anchor[2] - z * BLOCK_SIZE], facing: spot.facing };
  }

  /** Shows where the designed object in hand would go (its whole box), if one is. */
  private showDesignPreview(): void {
    const held = this.materialOf();
    // (Not a boat: that goes in the water, see launchBoat.)
    const design = this.mode === 'hybrid' && held !== null ? designOfItem(held) : undefined;
    if (design?.role === 'boat') {
      this.designPreview.visible = this.designBlocksPreview.visible = false;
      return;
    }
    const spot = design && this.designSpot();
    this.designPreview.visible = this.designBlocksPreview.visible = !!spot;
    if (!design || !spot) return;
    const at = designOrigin(design, spot.facing, spot.x, spot.y, spot.z);
    const [w, h, d] = designSpan(design, spot.facing);
    const [ox, oy, oz] = spot.offset.map((v) => v / BLOCK_SIZE) as [number, number, number];
    // Its voxels' box (metres; none drawn: its whole box).
    const B = BLOCK_SIZE, v = designVoxelBox(design, spot.facing) ?? { x0: 0, y0: 0, z0: 0, x1: w * B, y1: h * B, z1: d * B };
    const [vw, vh, vd] = [(v.x1 - v.x0) / B, (v.y1 - v.y0) / B, (v.z1 - v.z0) / B];
    this.designPreview.scale.set(vw + 0.004, vh + 0.004, vd + 0.004);
    this.designPreview.position.set(at.x + ox + (v.x0 + v.x1) / 2 / B, at.y + oy + (v.y0 + v.y1) / 2 / B, at.z + oz + (v.z0 + v.z1) / 2 / B);
    // The blocks (a little outside, so where they meet its voxels' box both show).
    const [bw, bh, bd] = [w + (ox > 0 ? 1 : 0), h + (oy > 0 ? 1 : 0), d + (oz > 0 ? 1 : 0)];
    this.designBlocksPreview.scale.set(bw + 0.02, bh + 0.02, bd + 0.02);
    this.designBlocksPreview.position.set(at.x + bw / 2, at.y + bh / 2, at.z + bd / 2);
  }

  /** Re-aims from the camera; call every frame. */
  update(): void {
    this.aim();
    this.tellSize();
  }

  /** Says if the size chosen changed (see onSizeChange): it can with what's aimed at, in hybrid with ⌘ held. */
  private tellSize(): void {
    const size = this.chosenSize;
    if (size === this.toldSize) return;
    this.toldSize = size;
    this.onSizeChange?.(size);
  }
  private toldSize: number | null | undefined = undefined;

  /** Works out what's aimed at, and where a placement or dig would go. */
  private aim(): void {
    this.target = this.placement = this.dig = null;
    this.targetMaterial = null;
    this.hit = null;
    {
      const origin = this.camera.getWorldPosition(new THREE.Vector3()).multiplyScalar(UNITS_PER_METER);
      const dir = this.camera.getWorldDirection(new THREE.Vector3());
      // (With a bucket or a boat in hand, water stops the aim: to fill it there, or put the boat in.)
      const held = this.materialOf();
      const hit = raycastVoxels([origin.x, origin.y, origin.z], [dir.x, dir.y, dir.z], REACH, held === Item.Bucket || held === Item.Boat ? this.solidOrWaterAt : this.solidAt);
      const aimed = hit ? this.voxelBox(hit.cell) : null;
      this.target = aimed;
      if (hit && aimed) {
        this.hit = hit;
        this.targetMaterial = aimed.material;
        // Hybrid keeps things simple: always snapped to the size.
        const fine = this.mode !== 'hybrid' && this.modifiers.alt;
        if (this.mode === 'place' && this.size > BLOCK_SIZE) {
          // A fill box: on the 1 m grid, against the aimed face; it replaces what's there (so only
          // the player standing in it stops it).
          const p = placementBox(hit, aimed, this.size, false);
          const axis = hit.normal[0] !== 0 ? 0 : hit.normal[1] !== 0 ? 1 : 2;
          const corner = [p.x, p.y, p.z];
          corner[axis] = hit.normal[axis]! > 0 ? Math.ceil(corner[axis]! / BLOCK_SIZE) * BLOCK_SIZE : Math.floor((corner[axis]! + this.size) / BLOCK_SIZE) * BLOCK_SIZE - this.size;
          const box = { x: corner[0]!, y: corner[1]!, z: corner[2]!, size: this.size };
          const reason = this.inBody(box) ? "you're standing there" : '';
          this.placement = { ...box, valid: !reason, reason };
        } else if (this.mode === 'place' || this.mode === 'hybrid') {
          const p = placementBox(hit, aimed, this.placeSize(aimed), fine);
          // Crossing 1 m gridlines is fine: the server places it as block-sized pieces.
          const reason = this.occupied(p);
          this.placement = { ...p, valid: !reason, reason };
        } else if (this.modifiers.meta) {
          this.dig = digBox(hit, aimed, this.size, fine);
          this.digNormal = hit.normal;
        }
      }
    }
    this.show(this.outline, this.outlined() ? this.target : null, 1.004);
    this.showDesignPreview();
    // Hybrid previews only while Command is held (when choosing a size), like Minecraft otherwise.
    const preview = this.mode === 'place' || (this.mode === 'hybrid' && this.modifiers.meta);
    this.show(this.preview, preview ? this.placement : null, 0.999);
    this.show(this.digPreview, this.dig, 1.002);
    this.showEntry();
    this.previewMaterial.color.set(this.placement?.valid ? 0x40ff60 : 0xff4040);
    this.stepMining();
  }

  /**
   * A mouse button pressed while the mouse is captured: 0 = left, 1 = middle,
   * 2 = right. `mods` are the modifier keys held at that moment.
   */
  click(button: number, mods: Modifiers = this.modifiers): void {
    this.setMeta(mods.meta);
    this.modifiers.alt = mods.alt;
    this.update(); // aim with the modifiers as they are right now
    if (button === 1) return this.breakSmaller(mods.shift ? MIN_VOXEL_SIZE : null);
    if (this.mode === 'hybrid') {
      const held = this.materialOf();
      // A bow: right button held draws it (let go: it shoots; see release).
      if (button === 2 && held === Item.Bow) {
        this.drawnAt = performance.now();
        return;
      }
      // A boat in reach, nearer than the voxel aimed at: right-click gets in, left-click takes it.
      const boat = this.aimedBoat();
      if (boat && (button === 2 || (button === 0 && this.breaks))) {
        const id = this.nextId++;
        if (button === 2) {
          this.pending.set(id, 'getting in');
          this.boarding.set(id, boat);
          this.send({ type: 'boatBoard', id, boat });
        } else {
          this.pending.set(id, 'taking the boat');
          this.send({ type: 'boatTake', id, boat });
        }
        return;
      }
      if (button === 2 && held === Item.Boat) return this.launchBoat();
      if (button === 0) {
        // A mob in reach, nearer than the voxel aimed at: hit it (with the sword in hand, if any).
        const origin = this.camera.getWorldPosition(new THREE.Vector3()).multiplyScalar(UNITS_PER_METER);
        const dir = this.camera.getWorldDirection(new THREE.Vector3());
        const mob = this.pickEntity?.([origin.x, origin.y, origin.z], [dir.x, dir.y, dir.z], ATTACK_REACH * UNITS_PER_METER);
        if (mob && (!this.hit || mob.dist < this.hit.distance)) {
          const weapon = isSword(held) ? held : null;
          this.send({ type: 'attack', target: mob.id, weapon });
          return;
        }
        // Explosives light; a sword cuts leaves (a sweep); otherwise left-click removes.
        if (this.target && this.targetMaterial !== null && isExplosive(this.targetMaterial)) this.ignite();
        else if (held !== null && isSword(held) && this.targetMaterial !== null && LEAVES.has(this.targetMaterial)) this.cut(held);
        // A geologist's hammer taps what it's aimed at, and names it, instead of mining it.
        else if (held === Item.GeologistsHammer) {
          if (this.target && this.targetMaterial !== null) this.tap(this.targetMaterial);
        } else if (!this.breaks) return; // (only a tool, or a bare hand, breaks things)
        else if (this.survival) this.miningHeld = true; // (mined as it's held: see stepMining)
        else this.remove();
      } else if (button === 2) {
        // Right-click: with a bucket, fills it at water or pours it out; makes a bed ours; opens and
        // closes gates and doors; with a fence, gate or door in hand, places one.
        const design = this.aimedDesign();
        if (held === Item.Bucket) this.bucket();
        else if (design && isBed(design)) this.use('bed');
        else if (design && isStationKind(objectStation(design))) this.onStation?.(design);
        else if (design && usable(design)) this.use();
        else if (!design && this.targetMaterial !== null && isUsableMaterial(this.targetMaterial)) this.use();
        else if (held !== null && isFood(held)) this.eat(held);
        else if (this.material && (objectKindOf(this.material.id) || designOfItem(this.material.id))) this.placeObject(this.material.id);
        else this.place();
      }
      return;
    }
    if (button !== 0) return;
    if (this.mode === 'place') {
      this.place();
    } else if (this.dig) {
      const { x, y, z, size } = this.dig;
      if (this.survival) this.miningHeld = true;
      else this.submit({ op: 'removeBox', x, y, z, size }, 'dig');
    } else if (this.survival) {
      this.miningHeld = true;
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

  /** The boat aimed at, if one's in reach and nearer than the voxel aimed at. */
  private aimedBoat(): number | null {
    const origin = this.camera.getWorldPosition(new THREE.Vector3()).multiplyScalar(UNITS_PER_METER);
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const boat = this.pickBoat?.([origin.x, origin.y, origin.z], [dir.x, dir.y, dir.z], BOAT.reach);
    return boat && (!this.hit || boat.dist < this.hit.distance) ? boat.id : null;
  }

  /** Puts the boat in hand in the water aimed at (on its top), pointing the way we look. */
  private launchBoat(): void {
    if (!this.hit || this.targetMaterial === null || !isWater(this.targetMaterial) || this.hit.normal[1] <= 0) return this.say('a boat goes in the water: aim at its surface');
    const [x, y, z] = this.hit.point;
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const id = this.nextId++;
    this.pending.set(id, 'putting the boat in');
    this.send({ type: 'boatLaunch', id, x, y: y - BOAT.draft, z, yaw: Math.atan2(-dir.x, -dir.z) });
  }

  /** Handles editResult messages; returns true if the message was one. */
  onServerMessage(msg: ServerMessage): boolean {
    if (msg.type !== 'editResult') return false;
    const what = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    const boat = this.boarding.get(msg.id);
    this.boarding.delete(msg.id);
    if (msg.ok && boat !== undefined) this.onBoarded?.(boat);
    if (!msg.ok) this.say(`${what ?? 'edit'} failed: ${msg.error}`);
    else if (msg.note) this.say(msg.note);
    return true;
  }

  hudLines(): string {
    const msg = performance.now() < this.messageUntil ? `\n${this.message}` : '';
    const size =
      this.mode === 'hybrid'
        ? this.hybridSize !== null && this.modifiers.meta
          ? `places ${sizeLabel(this.hybridSize)} while ⌘ is held`
          : 'places matching size (⌘+wheel: choose)'
        : sizeLabel(this.size);
    const opensHere = this.targetMaterial !== null && isUsableMaterial(this.targetMaterial);
    const design = this.aimedDesign();
    const states = design && designById(design.design ?? '')?.states;
    const next = design && states && usable(design) ? states[((design.state ?? 0) + 1) % states.length]!.name : null;
    const target = !this.target
      ? 'nothing in reach'
      : design
        ? `aiming at a ${objectName(design)}${isBed(design) ? ' (right-click: make it your bed)' : isStationKind(objectStation(design)) ? ' (right-click: open it)' : next ? ` (right-click: ${next})` : ''} (left-click: take it down)`
      : this.targetMaterial !== null && isObjectMaterial(this.targetMaterial)
        ? `aiming at a ${materialName(this.targetMaterial)}${opensHere ? ' (right-click: open / close)' : ''} (left-click: take it down)`
        : this.targetMaterial !== null && isExplosive(this.targetMaterial)
          ? `aiming at ${sizeLabel(this.target.size)} of ${materialName(this.targetMaterial)}${this.mode === 'hybrid' ? ' (click: light it, then stand back)' : ''}`
          : `aiming at a ${sizeLabel(this.target.size)} voxel${this.needsPickaxe()}`;
    const held = this.materialOf();
    const actions =
      this.mode === 'hybrid'
        ? held === Item.Bucket
          ? 'click: remove · right-click: fill the bucket at water, or pour it out'
          : held !== null && isSword(held)
            ? `click: cut leaves (${SWORDS[held]!.cut > 0 ? `${2 * SWORDS[held]!.cut + 1} x ${2 * SWORDS[held]!.cut + 1} x ${2 * SWORDS[held]!.cut + 1} m` : '1 m'}), or remove · right-click: place`
            : 'click: remove · right-click: place (⌘+wheel: pick size, ⌘ shows it)'
        : this.mode === 'dig'
          ? `click: remove · ⌘+click: remove everything in the box (⌘ shows it) · ⌥: 1/16 m steps${this.bigBoxes ? ' · boxes up to 16 m' : ''}`
          : this.size > BLOCK_SIZE
            ? 'click: fill the box (whole 1 m blocks, replacing what\'s there)'
            : `click: place · ⌥: 1/16 m steps${this.bigBoxes ? ' · bigger sizes: fill boxes up to 16 m' : ''}`;
    return (
      `mode: ${this.mode} (Tab: hybrid / dig / place) · ${size} ${this.material?.name ?? 'nothing (E: inventory)'} · ${target}\n` +
      `${actions} · middle-click: break smaller (⇧: to 1/16 m) · B: break to size · X: remove · ⌘+wheel or [ ]: size · 1-9: hotbar · E: inventory` +
      msg
    );
  }

  /** A geologist's hammer tapped on `material`: what it is, said. */
  private tap(material: MaterialId): void {
    this.say(rockNote(material));
    this.onTap?.(material);
  }

  /** Shows a message on the overlay for a few seconds. */
  say(text: string): void {
    this.message = text;
    this.messageUntil = performance.now() + 4000;
    this.onSay?.(text);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.outline.removeFromParent();
    this.designPreview.removeFromParent();
    this.designBlocksPreview.removeFromParent();
    this.preview.removeFromParent();
    this.digPreview.removeFromParent();
    this.digEntry.removeFromParent();
  }

  private readModifiers(e: KeyboardEvent): void {
    this.setMeta(e.metaKey);
    this.modifiers.alt = e.altKey;
  }

  /** Command held or not; letting go of it drops a size chosen in hybrid (back to matching the target). */
  private setMeta(held: boolean): void {
    if (!held) this.hybridSize = null;
    this.modifiers.meta = held;
    this.tellSize();
  }

  private handleKey(e: KeyboardEvent): void {
    // Tab and Alt have browser defaults (focus moves, menu bar); the game uses them.
    if (e.code === 'Tab' || e.code === 'AltLeft' || e.code === 'AltRight') e.preventDefault();
    if (e.ctrlKey || e.repeat || (e.metaKey && e.code !== 'MetaLeft' && e.code !== 'MetaRight')) return;
    if (e.code === 'Tab') {
      this.cycleMode();
      return;
    }
    // (In hybrid the size follows the target unless Command is held, so [ ] only work in dig and place.)
    if ((e.code === 'BracketLeft' || e.code === 'BracketRight') && this.mode === 'hybrid') this.say('hybrid: hold ⌘ and turn the wheel to choose a size');
    else if (e.code === 'BracketLeft') this.stepSize(-1, false);
    else if (e.code === 'BracketRight') this.stepSize(1, false);
    else if (e.code === 'KeyX') {
      if (this.mode !== 'hybrid' || this.breaks) this.remove();
      else this.say('hold a pickaxe, an axe or a shovel (or nothing) to break things');
    }
    else if (e.code === 'KeyB' && this.target) {
      if (!breakSizesFor(this.target.size).includes(this.size)) {
        const options = breakSizesFor(this.target.size).map(sizeLabel).join(', ') || 'nothing smaller';
        this.say(`a ${sizeLabel(this.target.size)} voxel breaks into ${options}, not ${sizeLabel(this.size)}`);
        return;
      }
      this.submit({ op: 'break', x: this.target.x, y: this.target.y, z: this.target.z, pieceSize: this.size }, 'break');
    }
  }

  private place(): void {
    if (!this.placement) return;
    if (!this.placement.valid) return this.say(`can't place ${sizeLabel(this.placement.size)}: ${this.placement.reason}`);
    const { x, y, z, size } = this.placement;
    const material = this.material;
    if (!material) {
      this.say('nothing in this hotbar slot (E: inventory)');
      return;
    }
    if (!isBlock(material.id)) {
      this.say(`a ${material.name} can't be placed${this.mode === 'hybrid' ? '' : ' in this mode (Tab: hybrid)'}`);
      return;
    }
    if (size > BLOCK_SIZE) this.submit({ op: 'fillBox', x, y, z, size, material: material.id }, 'fill');
    else this.submit({ op: 'place', x, y, z, size, material: material.id }, 'place');
  }

  /** Fills the bucket at the water aimed at, or pours it into the block beside the face aimed at. */
  private bucket(): void {
    if (!this.hit) return;
    const fill = this.targetMaterial !== null && isWater(this.targetMaterial);
    const cell = fill ? this.hit.cell : (this.hit.cell.map((c, a) => c + this.hit!.normal[a]!) as [number, number, number]);
    const [x, y, z] = cell.map((c) => floorDiv(c, BLOCK_SIZE)) as [number, number, number];
    const id = this.nextId++;
    this.pending.set(id, fill ? 'fill' : 'pour');
    this.send({ type: 'bucket', id, x, y, z, fill });
  }

  /** Survival: what the voxel aimed at is, if the tool in hand won't get anything from it (see canHarvest). */
  private needsPickaxe(): string {
    const m = this.targetMaterial, held = this.materialOf();
    if (!this.survival || m === null || canHarvest(m, isTool(held) ? held : null)) return '';
    return ` of ${materialName(m)} (needs a ${pickaxeTierFor(m) > 1 ? 'stone ' : ''}pickaxe to give anything)`;
  }

  /** A sword's sweep through the leaves aimed at. */
  private cut(sword: ItemId): void {
    if (!this.target) return;
    const id = this.nextId++;
    this.pending.set(id, 'cut');
    this.send({ type: 'cut', id, sword, x: floorDiv(this.target.x, BLOCK_SIZE), y: floorDiv(this.target.y, BLOCK_SIZE), z: floorDiv(this.target.z, BLOCK_SIZE) });
  }

  /** Opens or closes the gate or door aimed at (or makes the bed aimed at ours). */
  private use(what = 'open'): void {
    if (!this.target) return;
    const id = this.nextId++;
    this.pending.set(id, what);
    this.send({ type: 'use', id, x: this.target.x, y: this.target.y, z: this.target.z });
  }

  /** Eats one of `food` (survival; the server says if we can't). */
  private eat(food: ItemId): void {
    if (!this.survival) return this.say('creative: no need to eat');
    this.send({ type: 'eat', item: food });
  }

  /**
   * Places an object (fence, gate, door, table; a design: the middle of its front row) in the 1 m
   * block beside the face aimed at, facing the way we look.
   */
  private placeObject(item: ItemId): void {
    if (designOfItem(item)) {
      // (To the 1/4 m: see designSpot.)
      const at = this.designSpot();
      if (!at) return;
      const id = this.nextId++;
      this.pending.set(id, 'place');
      const shifted = at.offset.some((v) => v !== 0);
      this.send({ type: 'placeObject', id, item, x: at.x, y: at.y, z: at.z, facing: at.facing, ...(shifted ? { offset: at.offset } : {}) });
      return;
    }
    const spot = this.objectSpot();
    if (!spot) return;
    const { x, y, z } = spot;
    let { facing } = spot, wall = false;
    if (item === Item.Torch) {
      // On the face aimed at: a top, standing; a side, on that wall (facing it); not under things.
      const [nx, ny, nz] = this.hit!.normal;
      if (ny < 0) return this.say('a torch goes on a floor or a wall, not under something');
      if (ny === 0) {
        wall = true;
        facing = nx > 0 ? 'w' : nx < 0 ? 'e' : nz > 0 ? 'n' : 's';
      }
    }
    const id = this.nextId++;
    this.pending.set(id, 'place');
    this.send({ type: 'placeObject', id, item, x, y, z, facing, ...(wall ? { wall } : {}) });
  }

  /** Breaks the aimed voxel into pieces of `to` (null: the next size down). */
  private breakSmaller(to: number | null = null): void {
    if (!this.target) return;
    const piece = to !== null && to < this.target.size ? to : to === null ? nextBreakSize(this.target.size) : null;
    if (piece === null) return this.say(`can't break a ${sizeLabel(this.target.size)} voxel any smaller`);
    this.submit({ op: 'break', x: this.target.x, y: this.target.y, z: this.target.z, pieceSize: piece }, 'break');
  }

  private remove(): void {
    if (this.survival) return this.say('survival: hold the left button to mine');
    if (this.target) this.submit({ op: 'remove', x: this.target.x, y: this.target.y, z: this.target.z }, 'remove');
  }

  /** Lights the explosive (TNT, C4) aimed at (the server blows it after its fuse). */
  private ignite(): void {
    if (!this.target) return;
    const id = this.nextId++;
    this.pending.set(id, 'light');
    this.send({ type: 'ignite', id, x: this.target.x, y: this.target.y, z: this.target.z });
  }

  /** A mouse button let go (0 = left): stops mining. */
  release(button: number): void {
    if (button === 2 && this.drawnAt !== null) {
      const charge = drawCharge(performance.now() - this.drawnAt);
      this.drawnAt = null;
      if (this.materialOf() === Item.Bow) this.onShoot?.(charge);
      this.onMiningProgress?.(null);
      return;
    }
    if (button !== 0) return;
    this.miningHeld = false;
    this.stepMining();
  }

  /** What holding the left button would mine now: the dig box (dig mode) or the voxel aimed at; null for nothing. */
  private aimedRemoval(): (Edit & { op: 'remove' | 'removeBox' }) | null {
    if (this.mode === 'dig' && this.dig) return { op: 'removeBox', x: this.dig.x, y: this.dig.y, z: this.dig.z, size: this.dig.size };
    if (this.mode === 'place' || !this.target) return null;
    if (this.mode === 'hybrid' && this.targetMaterial !== null && isExplosive(this.targetMaterial)) return null; // (lit, not mined)
    if (this.mode === 'hybrid' && !this.breaks) return null;
    const held = this.materialOf();
    if (held !== null && isSword(held) && this.targetMaterial !== null && LEAVES.has(this.targetMaterial)) return null;
    return { op: 'remove', x: this.target.x, y: this.target.y, z: this.target.z };
  }

  /**
   * Survival, each frame: mining what's aimed at while the left button is held (telling the server
   * when it starts), and taking it out once it's been mined long enough. Aiming elsewhere starts
   * again on the new thing; letting go stops.
   */
  private stepMining(): void {
    // Drawing a bow: how far, shown as mining is (put away: no longer drawn).
    if (this.drawnAt !== null) {
      if (this.materialOf() !== Item.Bow) this.drawnAt = null;
      else return this.onMiningProgress?.(drawCharge(performance.now() - this.drawnAt));
    }
    const edit = this.survival && this.miningHeld ? this.aimedRemoval() : null;
    // (With the tool in hand: changing it starts again, at its pace.)
    const held = this.materialOf();
    const tool = isTool(held) ? held : null;
    const key = edit && JSON.stringify([edit, tool]);
    if (!edit || key !== this.mined) this.mined = null;
    if (!edit || key === this.mined) {
      this.mining = null;
      this.onMiningProgress?.(null);
      return;
    }
    const now = performance.now();
    if (this.mining?.key !== key) {
      const need = editMiningTime(edit, (cx, cy, cz) => this.chunks.chunkAt({ cx, cy, cz }), tool) * 1000;
      this.mining = { key: key!, edit, start: now, need };
      this.send({ type: 'mine', x: edit.x, y: edit.y, z: edit.z, ...(tool !== null ? { tool } : {}) });
    }
    const m = this.mining!;
    if (now - m.start < m.need) {
      this.onMiningProgress?.((now - m.start) / m.need);
      return;
    }
    // Mined: out it comes (and the next thing aimed at starts, once this one's gone).
    this.submit(m.edit, m.edit.op === 'removeBox' ? 'dig' : 'remove');
    this.mined = m.key;
    this.mining = null;
    this.onMiningProgress?.(null);
  }

  private submit(edit: Edit, label: string): void {
    const id = this.nextId++;
    this.pending.set(id, label);
    this.send({ type: 'edit', id, edit });
  }

  private readonly solidAt: SolidAt;
  private readonly solidOrWaterAt: SolidAt;

  /** World box of the voxel covering unit cell `cell`. */
  private voxelBox([x, y, z]: [number, number, number]): (Box & { material: MaterialId }) | null {
    const chunk = this.chunks.chunkAt({ cx: floorDiv(x, CHUNK_SIZE), cy: floorDiv(y, CHUNK_SIZE), cz: floorDiv(z, CHUNK_SIZE) });
    if (!chunk) return null;
    const [lx, ly, lz] = [mod(x, CHUNK_SIZE), mod(y, CHUNK_SIZE), mod(z, CHUNK_SIZE)];
    const block = chunk.blocks[blockIndex(floorDiv(lx, BLOCK_SIZE), floorDiv(ly, BLOCK_SIZE), floorDiv(lz, BLOCK_SIZE))] ?? null;
    const v = blockVoxelContaining(block, mod(lx, BLOCK_SIZE), mod(ly, BLOCK_SIZE), mod(lz, BLOCK_SIZE));
    if (!v) return null;
    return { x: x - mod(x, BLOCK_SIZE) + v.x, y: y - mod(y, BLOCK_SIZE) + v.y, z: z - mod(z, BLOCK_SIZE) + v.z, size: v.size, material: v.material };
  }

  /** Whether the box overlaps the player. */
  private inBody(b: Box): boolean {
    const body = this.body();
    return !!body && [0, 1, 2].every((a) => {
      const lo = [b.x, b.y, b.z][a]!;
      return lo < body.max[a]! && body.min[a]! < lo + b.size;
    });
  }

  /** '' if every cell of the box is loaded and empty and clear of the player, else why not. */
  private occupied(b: Box): string {
    if (this.inBody(b)) return "you're standing there";
    for (let y = b.y; y < b.y + b.size; y++) {
      for (let z = b.z; z < b.z + b.size; z++) {
        for (let x = b.x; x < b.x + b.size; x++) {
          const s = this.solidAt(x, y, z);
          if (s === undefined) return 'not loaded yet';
          if (s) {
            // (What's in the way, and how big: why it doesn't fit.)
            const v = this.voxelBox([x, y, z]);
            return v ? `${sizeLabel(v.size)} of ${materialName(v.material)} is in the way` : 'space is occupied';
          }
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

/**
 * A box's edges in `color`: bright where nothing's in front of them, faint where something is (the
 * ground, half a wall), so they're never hidden and it's still plain where they meet things.
 */
function seeThroughOutline(box: THREE.BufferGeometry, color: number): THREE.Group {
  const edges = new THREE.EdgesGeometry(box);
  const seen = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color }));
  const hidden = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.3 }));
  hidden.renderOrder = 9;
  return new THREE.Group().add(seen, hidden);
}
