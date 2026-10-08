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
  type BuildOp,
  type BlockVoxel,
  regionBetween,
  buildCells,
  transformPieces,
  turnedSpan,
  voxelsIn,
  type ClientMessage,
  type Edit,
  type MaterialId,
  type ServerMessage,
} from '@super-vox/shared';
import type { ChunkManager } from './chunkManager.js';
import type { Aabb } from './physics.js';
import { digBox, placementBox, raycastVoxels, type Box, type SolidAt } from './picking.js';
import { solidAtFor, waterAtFor } from './worldQuery.js';
import { BuildMode, type Selection } from './buildMode.js';

/** While scrolling continuously, wheel travel (pixels) per further voxel-size step. */
const WHEEL_STEP = 30;
/** A pause this long (ms) starts a new scroll: its first movement steps immediately. */
const WHEEL_GESTURE_GAP = 200;

/** How far away voxels can be edited (units): 32 m. */
const REACH = 32 * UNITS_PER_METER;



/** Sizes the tool offers: the five that tile a 1 m block (1/16, 1/8, 1/4, 1/2, 1 m). */
export const TOOL_SIZES = GRID_SIZES;

/** Tool modes, in the order Tab cycles through them; the first is the default (build: creative only; explore: no tool at all, just looking round). */
export const MODES = ['hybrid', 'dig', 'place', 'build', 'explore'] as const;
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
/** Most faces a build's preview draws (more: just the box round its cells). */
const BUILD_PREVIEW_FACES = 120_000;

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
 * - build (creative): the object designer's shapes, in the world (see BuildMode): G picks line,
 *   box, circle, dome or sphere; click, aim, click (a box: and again, for its height); Shift as
 *   it starts: clears instead; H hollow, T thickness, U or ⌘Z undoes; right-click: never mind.
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
    // (Extrude copies voxels as they are: no size of its own.)
    if (this.mode === 'explore' || (this.mode === 'build' && this.builder.tool === 'extrude')) return null;
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
  /** Build mode: the shape being drawn (see BuildMode). */
  readonly builder = new BuildMode();
  /** ...its cells, as they'd go (green: filled; red: cleared), and the box round them; made when the shape changes. */
  private readonly buildCellsMesh: THREE.Mesh;
  private readonly buildCellsMaterial: THREE.MeshBasicMaterial;
  private readonly buildBox: THREE.Group;
  private shownBuild = '';
  /** Moves and copies sent, by message id: the selection as it was (put back if refused). */
  private readonly unselect = new Map<number, Selection>();
  /** Select: what's picked up (the voxels, as when picked up), and the ghost of it drawn where it'd go. */
  private carriedVoxels: BlockVoxel[] | null = null;
  private readonly selectBox: THREE.Group;
  /** What the shape drawn so far would make (voxels), or why it can't be built; '' when none is. */
  private buildNote = '';
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
    // (Extrude finds its face in the blocks as loaded here.)
    this.builder.reader = (bx, by, bz) => {
      const n = CHUNK_SIZE / BLOCK_SIZE;
      const chunk = this.chunks.chunkAt({ cx: floorDiv(bx, n), cy: floorDiv(by, n), cz: floorDiv(bz, n) });
      if (!chunk) return undefined;
      return chunk.blocks[blockIndex(mod(bx, n), mod(by, n), mod(bz, n))] ?? null;
    };
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
    this.buildCellsMaterial = new THREE.MeshBasicMaterial({ color: 0x40ff60, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide });
    this.buildCellsMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.buildCellsMaterial);
    this.buildCellsMesh.frustumCulled = false;
    this.buildBox = seeThroughOutline(box, 0x40ff60);
    this.selectBox = seeThroughOutline(box, 0x40c0ff);
    this.selectBox.visible = false;
    scene.add(this.selectBox);
    this.buildCellsMesh.visible = this.buildBox.visible = false;
    scene.add(this.buildCellsMesh, this.buildBox);
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
    return this.bigBoxes && (this.mode === 'dig' || this.mode === 'place') ? [...TOOL_SIZES, ...BIG_BOX_SIZES] : TOOL_SIZES;
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
    // (Build: creative only.)
    if (this.mode === 'build' && !this.bigBoxes) this.mode = 'explore';
    this.builder.cancel();
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
    if (!this.enabled || this.mode === 'explore') {
      this.hideAll();
      return this.tellSize();
    }
    this.aim();
    this.tellSize();
  }

  /**
   * Whether the tool works: off (just looking round, nothing in hand), nothing's aimed at, shown
   * or done: clicks and its keys do nothing.
   */
  enabled = true;

  /** Nothing shown: no outline, no previews, no mining ring. */
  private hideAll(): void {
    for (const o of [this.outline, this.preview, this.digPreview, this.digEntry, this.designPreview, this.designBlocksPreview, this.buildCellsMesh, this.buildBox, this.selectBox]) o.visible = false;
    this.miningHeld = false;
    this.mining = null;
    this.drawnAt = null;
    this.onMiningProgress?.(null);
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
    if (this.mode === 'build') {
      const origin = this.camera.getWorldPosition(new THREE.Vector3()).multiplyScalar(UNITS_PER_METER);
      const dir = this.camera.getWorldDirection(new THREE.Vector3());
      this.builder.move({ origin: [origin.x, origin.y, origin.z], dir: [dir.x, dir.y, dir.z] }, this.size, this.hit && { point: this.hit.point, normal: this.hit.normal });
    }
    this.showBuild();
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
    if (!this.enabled || this.mode === 'explore') return;
    this.setMeta(mods.meta);
    this.modifiers.alt = mods.alt;
    this.update(); // aim with the modifiers as they are right now
    if (button === 1) return this.breakSmaller(mods.shift ? MIN_VOXEL_SIZE : null);
    if (this.mode === 'build') return this.buildClick(button, !!mods.shift);
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
    const was = this.unselect.get(msg.id);
    this.unselect.delete(msg.id);
    if (!msg.ok && was) this.builder.select(was);
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
    if (this.mode === 'explore') return `mode: explore (Tab: hybrid / dig / place${this.bigBoxes ? ' / build' : ''} / explore) · just looking round: nothing in hand · Tab: back to the tools${msg}`;
    if (this.mode === 'build') {
      const b = this.builder;
      const round = b.tool === 'circle' || b.tool === 'dome' || b.tool === 'sphere';
      return (
        `mode: build (Tab: hybrid / dig / place / build / explore) · ${b.tool}${round ? (b.hollow ? `, hollow ${b.thickness} thick` : ', solid') : ''}${b.tool === 'extrude' ? '' : b.tool === 'select' ? ` · ${sizeLabel(this.size)} grid` : ` · ${sizeLabel(this.size)} ${this.material?.name ?? 'nothing (E: inventory)'}`} · ${b.stage}${this.buildNote ? ` · ${this.buildNote}` : ''}\n` +
        (b.tool === 'select'
          ? 'G: line / box / circle / dome / sphere / extrude / select · click a corner, its base, its height · V: move it · ⇧V: copy it · R: turn it (carried) · click: put it down · right-click: put back, again: select nothing · U or ⌘Z: undo · ⌘+wheel or [ ]: grid size'
          : b.tool === 'extrude'
          ? 'G: line / box / circle / dome / sphere / extrude / select · click a face (the flat face it is in lights up), aim out or in along it, click · right-click: never mind · U or ⌘Z: undo'
          : `G: line / box / circle / dome / sphere / extrude / select · click: start, then click again${b.tool === 'box' ? ' (base, then height)' : ''} · ⇧+click to start: clear instead · right-click: never mind · H: hollow · T: thickness · U or ⌘Z: undo · ⌘+wheel or [ ]: size`) +
        msg
      );
    }
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
      `mode: ${this.mode} (Tab: hybrid / dig / place${this.bigBoxes ? ' / build' : ''} / explore) · ${size} ${this.material?.name ?? 'nothing (E: inventory)'} · ${target}\n` +
      `${actions} · middle-click: break smaller (⇧: to 1/16 m) · B: break to size · X: remove · ⌘+wheel or [ ]: size · 1-9: hotbar · E: inventory · O: just look around` +
      msg
    );
  }

  /**
   * Build mode, a click: left starts the shape, takes it a step on, or (finished) builds it (with
   * Shift as it starts: clears it out); right: never mind.
   */
  private buildClick(button: number, shift: boolean): void {
    if (button === 2) {
      // (Select: what's picked up goes back; again, the selection goes.)
      if (this.builder.active) this.say(this.builder.carried ? 'put back' : 'never mind');
      else if (this.builder.selection) this.builder.select(null);
      this.builder.cancel();
      return;
    }
    if (button !== 0) return;
    const material = this.materialOf();
    if (!shift && !this.builder.active && this.builder.tool !== 'extrude' && this.builder.tool !== 'select' && (material === null || !isBlock(material) || !canPlace(material, 'creative') || isWater(material)))
      return this.say(material === null ? 'nothing in this hotbar slot to build with (E: inventory) · ⇧+click clears' : `a ${itemName(material)} can't be built with`);
    const origin = this.camera.getWorldPosition(new THREE.Vector3()).multiplyScalar(UNITS_PER_METER);
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    const aim = this.hit && { point: this.hit.point, normal: this.hit.normal };
    if (!this.builder.active && !aim) return this.say('aim at something to start from');
    const op = this.builder.click(aim, { origin: [origin.x, origin.y, origin.z], dir: [dir.x, dir.y, dir.z] }, this.size, material ?? Material.Stone, shift);
    this.onModeChange?.(this.mode);
    if (!op) return;
    if (typeof op === 'string') return this.say(op);
    if ('kind' in op && op.kind === 'transform') {
      const id = this.nextId++;
      this.pending.set(id, op.copy ? 'copy' : 'move');
      // (Put back as it was if the server won't: see onServerMessage.)
      this.unselect.set(id, { region: op.region, size: op.size });
      const { kind: _, ...t } = op;
      this.send({ type: 'transform', id, op: t });
      return;
    }
    if ('kind' in op) {
      const id = this.nextId++;
      this.pending.set(id, op.depth > 0 ? 'extrude' : 'cut back');
      this.send({ type: 'extrude', id, x: op.x, y: op.y, z: op.z, axis: op.axis, sign: op.sign, depth: op.depth });
      return;
    }
    const cells = buildCells(op);
    if (typeof cells === 'string') return this.say(`can't build that: ${cells}`);
    const id = this.nextId++;
    this.pending.set(id, op.clear ? 'clear' : 'build');
    this.send({ type: 'build', id, op });
  }

  /** Build mode: takes back the last shape built (the server keeps each player's last few). */
  private undoBuild(): void {
    this.builder.cancel();
    const id = this.nextId++;
    this.pending.set(id, 'undo');
    this.send({ type: 'undo', id });
  }

  /** Build mode's keys (true: it was one). */
  private buildKey(code: string, shift = false): boolean {
    const b = this.builder;
    if (code === 'KeyV' && b.tool === 'select') {
      if (!b.pickUp(shift)) this.say('select something first: click out a box');
      else {
        // (What's in it, now, as the ghost to carry.)
        const taken = b.reader && voxelsIn(b.reader, b.selection!.region);
        this.carriedVoxels = Array.isArray(taken) ? taken : null;
        if (typeof taken === 'string') this.say(taken);
        else if (taken && !taken.length) this.say('nothing in it to move (only its outline goes)');
      }
    } else if (code === 'KeyR' && b.tool === 'select') {
      if (!b.turn()) this.say('pick it up first (V: move, ⇧V: copy), then R turns it');
    } else if (code === 'KeyG') {
      b.nextTool();
      this.say(`build: ${b.tool}`);
    } else if (code === 'KeyH') {
      b.hollow = !b.hollow;
      this.say(b.tool === 'line' || b.tool === 'box' ? `hollow: ${b.hollow ? 'on' : 'off'} (for circles, domes and spheres)` : `${b.hollow ? 'hollow' : 'solid'} ${b.tool}`);
    } else if (code === 'KeyT') {
      b.thickness = (b.thickness % 4) + 1;
      if (!b.hollow) b.hollow = true;
      this.say(`hollow, ${b.thickness} voxel${b.thickness > 1 ? 's' : ''} thick`);
    } else if (code === 'KeyU') this.undoBuild();
    else return false;
    this.shownBuild = ''; // (redrawn: the shape may have changed)
    this.onModeChange?.(this.mode);
    return true;
  }

  /** Build mode: shows the shape drawn so far, voxel by voxel (big ones: the box round them). */
  private showBuild(): void {
    this.selectBox.visible = false;
    if (this.mode === 'build' && this.builder.tool === 'extrude') return this.showExtrude();
    if (this.mode === 'build' && this.builder.tool === 'select') return this.showSelect();
    const material = this.materialOf();
    const op = this.mode === 'build' ? this.builder.op(this.size, material ?? Material.Stone) : null;
    const key = op ? JSON.stringify(op) : '';
    if (key === this.shownBuild) return;
    this.shownBuild = key;
    this.buildNote = '';
    const cells = op && buildCells(op);
    if (!op || !cells || typeof cells === 'string' || cells.length === 0) {
      this.buildCellsMesh.visible = false;
      this.buildBox.visible = !!op;
      if (op && typeof cells === 'string') this.buildNote = `can't build that: ${cells}`;
      if (op) this.showBuildBox(op, null);
      return;
    }
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const c of cells) {
      lo[0] = Math.min(lo[0]!, c.x); lo[1] = Math.min(lo[1]!, c.y); lo[2] = Math.min(lo[2]!, c.z);
      hi[0] = Math.max(hi[0]!, c.x); hi[1] = Math.max(hi[1]!, c.y); hi[2] = Math.max(hi[2]!, c.z);
    }
    const color = op.clear ? 0xff4040 : 0x40ff60;
    this.buildCellsMaterial.color.set(color);
    // Only its outside faces (every cube's own, translucent, would stack up into a solid wall of colour).
    const faces = surfaceFaces(cells, op.size, lo, hi, BUILD_PREVIEW_FACES);
    const each = faces !== null;
    this.buildCellsMesh.visible = each;
    if (faces) {
      // (A new geometry each time, the old one let go: its buffers on the GPU too.)
      this.buildCellsMesh.geometry.dispose();
      this.buildCellsMesh.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(faces, 3));
      // (Made from lo, so the numbers stay small: far out, a float's too coarse for 1/16 m.)
      this.buildCellsMesh.position.set(lo[0]! / UNITS_PER_METER, lo[1]! / UNITS_PER_METER, lo[2]! / UNITS_PER_METER);
      this.buildCellsMesh.scale.setScalar(1 / UNITS_PER_METER);
    }
    const n = cells.length;
    this.buildNote = `${op.clear ? 'clears' : 'builds'} ${n} voxel${n === 1 ? '' : 's'} of ${sizeLabel(op.size)}${each ? '' : ' (too many to show each: the box round them)'}`;
    this.showBuildBox(op, { lo, hi });
  }

  /**
   * Build mode, Extrude: the face aimed at, lit up (what a click would take); started, each of its
   * voxels' columns as far as they'd go (whole copies), or the depth they'd cut back.
   */
  private showExtrude(): void {
    const x = this.builder.extrusion;
    const aim = !x && this.hit ? { point: this.hit.point, normal: this.hit.normal } : null;
    // (Worked out again only when what's aimed at, or how far, changes.)
    const key = x ? `x ${x.at} ${x.axis} ${x.sign} ${x.depth}` : aim ? `a ${this.hit!.cell} ${aim.normal}` : '';
    if (key === this.shownBuild) return;
    this.shownBuild = key;
    this.buildNote = '';
    this.buildBox.visible = false;
    const f = x ?? (aim ? this.builder.faceAt(aim) : null);
    if (!f || typeof f === 'string') {
      this.buildCellsMesh.visible = false;
      if (typeof f === 'string') this.buildNote = f;
      return;
    }
    const depth = x?.depth ?? 0, d = Math.abs(depth);
    const height = (v: { size: number }) => (depth > 0 ? Math.floor(d / v.size) * v.size : d);
    const o = f.face[0]!;
    const faces = extrudeFaces(f.face, f.axis, f.sign, depth < 0 ? -1 : 1, height, [o.x, o.y, o.z], BUILD_PREVIEW_FACES);
    this.buildCellsMaterial.color.set(depth < 0 ? 0xff4040 : depth > 0 ? 0x40ff60 : 0x40c0ff);
    this.buildCellsMesh.visible = !!faces;
    if (faces) {
      this.buildCellsMesh.geometry.dispose();
      this.buildCellsMesh.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(faces, 3));
      this.buildCellsMesh.position.set(o.x / UNITS_PER_METER, o.y / UNITS_PER_METER, o.z / UNITS_PER_METER);
      this.buildCellsMesh.scale.setScalar(1 / UNITS_PER_METER);
    }
    const n = f.face.length, grown = depth > 0 ? f.face.reduce((t, v) => t + Math.floor(d / v.size), 0) : 0;
    this.buildNote = `a face of ${n} voxel${n === 1 ? '' : 's'}` + (depth > 0 ? ` · extrudes ${grown} voxel${grown === 1 ? '' : 's'}${grown ? '' : ' (aim further: whole copies only)'}` : depth < 0 ? ` · cuts back ${d / UNITS_PER_METER} m (what it touches goes)` : '');
  }

  /** Select: the box selected (or being clicked out), cyan; picked up, a ghost of what's in it where it'd go. */
  private showSelect(): void {
    const b = this.builder, sel = b.selection, f = b.carried;
    const op = b.op(this.size, Material.Stone);
    const region = f && sel && f.to
      ? (() => {
          const [w, h, d] = turnedSpan(sel.region, f.turns);
          return { x0: f.to.x, y0: f.to.y, z0: f.to.z, x1: f.to.x + w, y1: f.to.y + h, z1: f.to.z + d };
        })()
      : op?.shape.kind === 'box'
        ? regionBetween(op.shape.a, op.shape.b, op.size)
        : sel?.region ?? null;
    if (region) {
      const M = UNITS_PER_METER;
      this.selectBox.visible = true;
      this.selectBox.scale.set((region.x1 - region.x0) / M + 0.01, (region.y1 - region.y0) / M + 0.01, (region.z1 - region.z0) / M + 0.01);
      this.selectBox.position.set((region.x0 + region.x1) / 2 / M, (region.y0 + region.y1) / 2 / M, (region.z0 + region.z1) / 2 / M);
    }
    const key = f && sel && f.to ? `s ${JSON.stringify(f)} ${JSON.stringify(sel)}` : '';
    if (key === this.shownBuild) return;
    this.shownBuild = key;
    this.buildBox.visible = false;
    this.buildNote = sel ? `${(sel.region.x1 - sel.region.x0) / UNITS_PER_METER} x ${(sel.region.y1 - sel.region.y0) / UNITS_PER_METER} x ${(sel.region.z1 - sel.region.z0) / UNITS_PER_METER} m selected (on the ${sizeLabel(sel.size)} grid)` : '';
    const pieces = f && sel && f.to && this.carriedVoxels ? transformPieces(this.carriedVoxels, { region: sel.region, size: sel.size, to: f.to, turns: f.turns, copy: f.copy }) : null;
    const faces = Array.isArray(pieces) && pieces.length ? pieceFaces(pieces, [f!.to!.x, f!.to!.y, f!.to!.z], BUILD_PREVIEW_FACES) : null;
    this.buildCellsMesh.visible = !!faces;
    if (faces) {
      this.buildCellsMaterial.color.set(0x40c0ff);
      this.buildCellsMesh.geometry.dispose();
      this.buildCellsMesh.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(faces, 3));
      this.buildCellsMesh.position.set(f!.to!.x / UNITS_PER_METER, f!.to!.y / UNITS_PER_METER, f!.to!.z / UNITS_PER_METER);
      this.buildCellsMesh.scale.setScalar(1 / UNITS_PER_METER);
    }
    if (f && Array.isArray(pieces)) this.buildNote += ` · ${f.copy ? 'copies' : 'moves'} ${this.carriedVoxels!.length} voxel${this.carriedVoxels!.length === 1 ? '' : 's'}${f.turns ? `, turned ${f.turns * 90}°` : ''}`;
  }

  /** The box round a shape's cells (lo..hi: their corners, units; null: just where it started). */
  private showBuildBox(op: BuildOp, span: { lo: number[]; hi: number[] } | null): void {
    const box = this.buildBox;
    box.visible = true;
    for (const line of box.children) ((line as THREE.LineSegments).material as THREE.LineBasicMaterial).color.set(op.clear ? 0xff4040 : 0x40ff60);
    const lo = span?.lo ?? [0, 0, 0], hi = span?.hi ?? [0, 0, 0];
    if (!span) {
      const c = op.shape.kind === 'box' ? op.shape.a : { x: op.shape.spec.centre.x - op.size / 2, y: op.shape.spec.centre.y - op.size / 2, z: op.shape.spec.centre.z - op.size / 2 };
      [lo[0], lo[1], lo[2]] = [c.x, c.y, c.z];
      [hi[0], hi[1], hi[2]] = [c.x, c.y, c.z];
    }
    const M = UNITS_PER_METER;
    box.scale.set((hi[0]! - lo[0]! + op.size) / M + 0.01, (hi[1]! - lo[1]! + op.size) / M + 0.01, (hi[2]! - lo[2]! + op.size) / M + 0.01);
    box.position.set((lo[0]! + hi[0]! + op.size) / 2 / M, (lo[1]! + hi[1]! + op.size) / 2 / M, (lo[2]! + hi[2]! + op.size) / 2 / M);
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
    this.buildCellsMesh.removeFromParent();
    this.buildCellsMesh.geometry.dispose();
    this.buildBox.removeFromParent();
    this.selectBox.removeFromParent();
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
    if (!this.enabled) return;
    // Tab and Alt have browser defaults (focus moves, menu bar); the game uses them.
    if (e.code === 'Tab' || e.code === 'AltLeft' || e.code === 'AltRight') e.preventDefault();
    if (this.mode === 'build' && e.code === 'KeyZ' && (e.metaKey || e.ctrlKey) && !e.repeat) {
      e.preventDefault();
      return this.undoBuild();
    }
    if (e.ctrlKey || e.repeat || (e.metaKey && e.code !== 'MetaLeft' && e.code !== 'MetaRight')) return;
    if (e.code === 'Tab') {
      this.cycleMode();
      return;
    }
    // (Exploring: no tool, only Tab on to the next.)
    if (this.mode === 'explore') return;
    if (this.mode === 'build' && this.buildKey(e.code, e.shiftKey)) return;
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
    if (this.mode === 'place' || this.mode === 'build' || !this.target) return null;
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
 * The faces of `cells` (of `size`, within lo..hi) that aren't against another of them: two
 * triangles each, as positions (units, from lo); null if there are more than `most`.
 */
export function surfaceFaces(cells: readonly { x: number; y: number; z: number }[], size: number, lo: readonly number[], hi: readonly number[], most: number): Float32Array | null {
  // (Numbered in a grid a cell wider than lo..hi all round, so neighbours are plain offsets.)
  const nx = (hi[0]! - lo[0]!) / size + 3, ny = (hi[1]! - lo[1]!) / size + 3, nz = (hi[2]! - lo[2]!) / size + 3;
  const index = (c: { x: number; y: number; z: number }) => ((c.y - lo[1]!) / size + 1) * nx * nz + ((c.z - lo[2]!) / size + 1) * nx + ((c.x - lo[0]!) / size + 1);
  // (A grid of flags while that's small enough; a set of the numbers when it isn't: a big thin shell.)
  let has: (i: number) => boolean;
  if (nx * ny * nz <= 8_000_000) {
    const filled = new Uint8Array(nx * ny * nz);
    for (const c of cells) filled[index(c)] = 1;
    has = (i) => filled[i] === 1;
  } else {
    const filled = new Set(cells.map(index));
    has = (i) => filled.has(i);
  }
  // Each side: the step to the neighbour, the axis it's across, and which end of the cell.
  const sides = [[1, 0, 1], [-1, 0, 0], [nx * nz, 1, 1], [-nx * nz, 1, 0], [nx, 2, 1], [-nx, 2, 0]] as const;
  const open: number[] = [];
  for (let k = 0; k < cells.length; k++) {
    const i = index(cells[k]!);
    for (let f = 0; f < 6; f++) if (!has(i + sides[f]![0])) open.push(k * 6 + f);
    if (open.length > most) return null;
  }
  const out = new Float32Array(open.length * 18);
  let o = 0;
  const corner = [0, 0, 0];
  for (const kf of open) {
    const c = cells[Math.floor(kf / 6)]!, [, axis, end] = sides[kf % 6]!;
    const base = [c.x - lo[0]!, c.y - lo[1]!, c.z - lo[2]!];
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    // The quad's corners (0,0) (1,0) (1,1), (0,0) (1,1) (0,1) across u and v.
    for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]] as const) {
      corner[axis] = base[axis]! + end * size;
      corner[u] = base[u]! + a * size;
      corner[v] = base[v]! + b * size;
      out[o++] = corner[0]!;
      out[o++] = corner[1]!;
      out[o++] = corner[2]!;
    }
  }
  return out;
}

/**
 * Extrude's preview: each voxel of a face (side `axis`, `sign`) as a column out of it (`dir` 1) or
 * into it (-1), `height(v)` units long (0: just its face, lit, a hair out); as triangles (units,
 * from `origin`), the columns' outsides only (between two, the taller's wall above the other's
 * top). Null if more than `most` rectangles.
 */
export function extrudeFaces(
  face: readonly { x: number; y: number; z: number; size: number }[],
  axis: 0 | 1 | 2,
  sign: 1 | -1,
  dir: 1 | -1,
  height: (v: { size: number }) => number,
  origin: readonly number[],
  most: number,
): Float32Array | null {
  const K = ['x', 'y', 'z'] as const, k = K[axis];
  const ua = ((axis + 1) % 3) as 0 | 1 | 2, va = ((axis + 2) % 3) as 0 | 1 | 2;
  // The face's voxels by size, then by where they are across it.
  const bySize = new Map<number, Map<string, (typeof face)[number]>>();
  for (const v of face) {
    let m = bySize.get(v.size);
    if (!m) bySize.set(v.size, (m = new Map()));
    m.set(`${v[K[ua]]},${v[K[va]]}`, v);
  }
  const at = (u: number, w: number) => {
    for (const [s, m] of bySize) {
      const v = m.get(`${Math.floor(u / s) * s},${Math.floor(w / s) * s}`);
      if (v) return v;
    }
    return undefined;
  };
  const step = Math.min(...face.map((v) => v.size));
  const out: number[] = [];
  let rects = 0;
  // A rectangle square to axis `f` at `c`, over r1 on the next axis round and r2 on the one after.
  const rect = (f: number, c: number, r1: readonly number[], r2: readonly number[]) => {
    rects++;
    const a1 = (f + 1) % 3, a2 = (f + 2) % 3, p = [0, 0, 0];
    for (const [i, j] of [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]] as const) {
      p[f] = c - origin[f]!;
      p[a1] = r1[i]! - origin[a1]!;
      p[a2] = r2[j]! - origin[a2]!;
      out.push(p[0]!, p[1]!, p[2]!);
    }
  };
  // (Order a range low to high: the columns may go either way along the axis.)
  const span = (a: number, b: number) => (a < b ? [a, b] : [b, a]);
  const across = (u: number[], w: number[], f: 0 | 1 | 2) => (((f + 1) % 3) === ua ? [u, w] : [w, u]);
  for (const v of face) {
    const p = v[k] + (sign > 0 ? v.size : 0), h = height(v), u0 = v[K[ua]], w0 = v[K[va]], s = v.size;
    const out1 = p + sign * dir * h;
    if (h === 0) {
      const [r1, r2] = across([u0, u0 + s], [w0, w0 + s], axis);
      rect(axis, p + sign * 0.1, r1!, r2!);
      continue;
    }
    for (const c of [p, out1]) {
      const [r1, r2] = across([u0, u0 + s], [w0, w0 + s], axis);
      rect(axis, c, r1!, r2!);
    }
    // Its four sides, a step at a time: a wall where the column beside it is shorter (or none).
    for (const [side, c, inside] of [[ua, u0, u0 - 1], [ua, u0 + s, u0 + s], [va, w0, w0 - 1], [va, w0 + s, w0 + s]] as const) {
      for (let t = 0; t < s; t += step) {
        const n = side === ua ? at(inside, w0 + t) : at(u0 + t, inside);
        const hn = n ? height(n) : 0;
        if (hn >= h) continue;
        const along = side === ua ? [w0 + t, w0 + t + step] : [u0 + t, u0 + t + step];
        const up = span(p + sign * dir * hn, out1);
        // (A wall square to `side`: over the main axis and the other across-axis, in the right order.)
        if ((side + 1) % 3 === axis) rect(side, c, up, along);
        else rect(side, c, along, up);
      }
    }
    if (rects > most) return null;
  }
  return new Float32Array(out);
}

/**
 * The outsides of cubes (`pieces`: each on its own size's grid, none overlapping, any sizes): each
 * face not against another of them, as triangles (units, from `origin`); a face partly against
 * smaller ones, in squares of the smallest size. Null if more than `most` squares.
 */
export function pieceFaces(pieces: readonly { x: number; y: number; z: number; size: number }[], origin: readonly number[], most: number): Float32Array | null {
  const bySize = new Map<number, Set<string>>();
  for (const p of pieces) {
    let m = bySize.get(p.size);
    if (!m) bySize.set(p.size, (m = new Set()));
    m.add(`${p.x},${p.y},${p.z}`);
  }
  // (Covered at a point by a piece at least `atLeast` across, or any.)
  const covered = (x: number, y: number, z: number, atLeast = 0) => {
    for (const [s, m] of bySize) if (s >= atLeast && m.has(`${Math.floor(x / s) * s},${Math.floor(y / s) * s},${Math.floor(z / s) * s}`)) return true;
    return false;
  };
  const sizes = [...bySize.keys()];
  if (pieces.length > most) return null;
  const out: number[] = [];
  let rects = 0;
  const rect = (f: number, c: number, r1: readonly number[], r2: readonly number[]) => {
    rects++;
    const a1 = (f + 1) % 3, a2 = (f + 2) % 3, q = [0, 0, 0];
    for (const [i, j] of [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]] as const) {
      q[f] = c - origin[f]!;
      q[a1] = r1[i]! - origin[a1]!;
      q[a2] = r2[j]! - origin[a2]!;
      out.push(q[0]!, q[1]!, q[2]!);
    }
  };
  for (const p of pieces) {
    const lo = [p.x, p.y, p.z], s = p.size;
    for (let f = 0; f < 3; f++)
      for (const side of [0, 1]) {
        const c = lo[f]! + side * s;
        const a1 = (f + 1) % 3, a2 = (f + 2) % 3;
        // Against one as big or bigger: covered, all of it. No smaller ones about: open, all of it.
        const mid = [0, 0, 0];
        mid[f] = side ? c + 0.5 : c - 0.5;
        mid[a1] = lo[a1]! + s / 2;
        mid[a2] = lo[a2]! + s / 2;
        if (covered(mid[0]!, mid[1]!, mid[2]!, s)) continue;
        const smaller = sizes.filter((z) => z < s);
        if (!smaller.length) {
          rect(f, c, [lo[a1]!, lo[a1]! + s], [lo[a2]!, lo[a2]! + s]);
          continue;
        }
        const step = Math.min(...smaller), beyond = side ? c + step / 2 : c - step / 2;
        // The face's squares (of the smallest size) with nothing beyond them.
        const open: [number, number][] = [];
        for (let u = 0; u < s; u += step)
          for (let v = 0; v < s; v += step) {
            const q = [0, 0, 0];
            q[f] = beyond;
            q[a1] = lo[a1]! + u + step / 2;
            q[a2] = lo[a2]! + v + step / 2;
            if (!covered(q[0]!, q[1]!, q[2]!)) open.push([u, v]);
          }
        if (open.length === (s / step) ** 2) rect(f, c, [lo[a1]!, lo[a1]! + s], [lo[a2]!, lo[a2]! + s]);
        else for (const [u, v] of open) rect(f, c, [lo[a1]! + u, lo[a1]! + u + step], [lo[a2]! + v, lo[a2]! + v + step]);
      }
    if (rects > most) return null;
  }
  return new Float32Array(out);
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
