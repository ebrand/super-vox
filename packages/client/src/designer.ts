import './fullscreen.js';
import './envBadge.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  ALL_ITEMS,
  BLOCK_SIZE,
  DESIGN_MATERIALS,
  FIRST_DESIGN_ITEM,
  parseDesign,
  DESIGN_MAX_BLOCKS,
  DESIGN_MAX_INPUTS,
  DESIGN_MAX_VOXELS,
  GRID_SIZES,
  Material,
  PLAYER,
  RECIPES,
  STATIONS,
  stationOf,
  type DesignRole,
  isBlock,
  isWater,
  itemName,
  materialName,
  setDesigns,
  type BlockVoxel,
  type MaterialId,
  type ObjectDesign,
} from '@super-vox/shared';
import { DesignEditor, aimSurface, cellsIn, clipRegion, draftOf, newDraft, placeAgainst, regionBetween, shapeCells, type Region, type RoundShape, type WorkPlane } from './designEditor.js';
import { materialColor } from './materials.js';

/**
 * The object designer (designer.html): admins build objects of voxels in a box of up to 4 m a side,
 * in states, name them and give them recipes; saved to the server's one library (see the server's
 * DesignLibrary), they can be placed in every world. Anyone may look; only operators may save.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const say = (text: string, kind: '' | 'good' | 'bad' = '') => {
  statusEl.textContent = text;
  statusEl.className = kind;
};

/** A linear-light colour (as materials keep them) for CSS. */
const css = (c: readonly [number, number, number]) => `rgb(${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) ** (1 / 2.2) * 255)).join(' ')})`;
const sizeLabel = (units: number) => (units === BLOCK_SIZE ? '1 m' : `1/${BLOCK_SIZE / units} m`);

type Tool = 'build' | 'erase' | 'paint' | 'line' | 'box' | 'select' | RoundShape;
const ROUND: readonly Tool[] = ['circle', 'dome', 'sphere'];
const isRound = (t: Tool | string): t is RoundShape => (ROUND as readonly string[]).includes(t);
/** Tools that drag out a line, a box, or a round shape's radius (see drawing). */
const drags = (t: Tool): t is 'line' | 'box' | 'select' | RoundShape => t === 'line' || t === 'box' || t === 'select' || isRound(t);
/** Round shapes (circle, dome, sphere) as rings and shells, one voxel thick (see shapeCells). */
let hollow = false;

let library: ObjectDesign[] = [];
let canEdit = false;
let editor = new DesignEditor();
let tool: Tool = 'build';
let voxelSize = 4;
let material: MaterialId = Material.Planks;
/** A second click to confirm something (discarding changes, deleting), and what it was. */
let armed: { what: string; until: number } | null = null;

// --- The view ----------------------------------------------------------------------------------

const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
view.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d10);
// (Scene units: design units, 1/16 m.)
const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 5000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(0.6, 1, 0.8);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.5);
fill.position.set(-0.8, 0.4, -0.5);
scene.add(fill);

const cube = new THREE.BoxGeometry(1, 1, 1);
const voxelMaterial = new THREE.MeshLambertMaterial();
let voxelMesh: THREE.InstancedMesh | null = null;
/** The box, its floor grid and its front arrow (remade when the size or voxel size changes). */
const frame = new THREE.Group();
scene.add(frame);
const ghost = new THREE.Mesh(cube, new THREE.MeshBasicMaterial({ color: 0x40ff60, transparent: true, opacity: 0.35, depthWrite: false }));
const ghostEdges = new THREE.LineSegments(new THREE.EdgesGeometry(cube), new THREE.LineBasicMaterial({ color: 0x40ff60 }));
ghost.add(ghostEdges);
ghost.visible = false;
scene.add(ghost);
/** A round shape being drawn: its voxels as they'd go in (or come out). */
const SHAPE_PREVIEW_MAX = 40_000;
const shapePreview = new THREE.InstancedMesh(cube, new THREE.MeshBasicMaterial({ color: 0x40ff60, transparent: true, opacity: 0.35, depthWrite: false }), SHAPE_PREVIEW_MAX);
shapePreview.count = 0;
shapePreview.frustumCulled = false;
scene.add(shapePreview);

/** The selection (see DesignEditor.selection): a box outlined in blue. */
const selectionBox = new THREE.Mesh(cube, new THREE.MeshBasicMaterial({ color: 0x40a0ff, transparent: true, opacity: 0.12, depthWrite: false }));
selectionBox.add(new THREE.LineSegments(new THREE.EdgesGeometry(cube), new THREE.LineBasicMaterial({ color: 0x40a0ff })));
selectionBox.visible = false;
scene.add(selectionBox);
/**
 * The working plane: what aiming finds in empty space (with the box's far walls), so lines and
 * boxes can start in mid-air. Flat on the floor to begin with; raised, lowered and turned upright
 * (see stepPlane, turnPlane).
 */
let plane: WorkPlane = { axis: 1, at: 0 };
const planeGroup = new THREE.Group();
scene.add(planeGroup);

function resize(): void {
  const r = view.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(view);

/** Looks at the whole box from the front-right, above. */
function frameCamera(): void {
  const [W, H, D] = editor.extent;
  const r = Math.max(W, H, D);
  controls.target.set(W / 2, H / 3, D / 2);
  camera.position.set(W / 2 + r * 1.4, H / 2 + r * 1.2, D / 2 + r * 1.9);
  controls.update();
}

function lines(points: number[], color: number, opacity = 1): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
}

function drawFrame(): void {
  for (const c of [...frame.children]) {
    frame.remove(c);
    c.traverse((o) => (o instanceof THREE.LineSegments || o instanceof THREE.Mesh) && o.geometry.dispose());
  }
  const [W, H, D] = editor.extent;
  // The floor: metres plainly, half metres lighter, and the voxel size's grid (when finer) faintly.
  const fine: number[] = [], halves: number[] = [], metres: number[] = [];
  const HALF = BLOCK_SIZE / 2, step = Math.min(voxelSize, HALF);
  const tier = (v: number) => (v % BLOCK_SIZE === 0 ? metres : v % HALF === 0 ? halves : fine);
  for (let x = 0; x <= W; x += step) tier(x).push(x, 0, 0, x, 0, D);
  for (let z = 0; z <= D; z += step) tier(z).push(0, 0, z, W, 0, z);
  frame.add(lines(fine, 0x8b949e, 0.15), lines(halves, 0x8b949e, 0.35), lines(metres, 0x8b949e, 0.75));
  // The box's edges, and its metre marks up its corners.
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W, H, D)), new THREE.LineBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.5 }));
  box.position.set(W / 2, H / 2, D / 2);
  frame.add(box);
  const ticks: number[] = [];
  for (let y = BLOCK_SIZE; y < H; y += BLOCK_SIZE) ticks.push(0, y, 0, W, y, 0, 0, y, 0, 0, y, D, W, y, 0, W, y, D, 0, y, D, W, y, D);
  frame.add(lines(ticks, 0x58a6ff, 0.25));
  // The front (+z: toward whoever places it): an arrow pointing out of it.
  const arrow = new THREE.Mesh(
    new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(-4, 0), new THREE.Vector2(4, 0), new THREE.Vector2(0, 6)])),
    new THREE.MeshBasicMaterial({ color: 0xe3b341, side: THREE.DoubleSide }),
  );
  arrow.rotation.x = Math.PI / 2;
  arrow.position.set(W / 2, 0.05, D + 3);
  frame.add(arrow);
  frame.add(standIn(W / 2, -PLAYER.width));
  drawPlane();
}

const standInMaterial = new THREE.MeshLambertMaterial({ color: 0x5a6f8c, transparent: true, opacity: 0.8 });
/**
 * A player for scale (as tall and wide as one: PLAYER), standing behind the box at (x, z), facing
 * its back: head, body, arms and legs.
 */
function standIn(x: number, z: number): THREE.Group {
  const h = PLAYER.height, w = PLAYER.width, g = new THREE.Group();
  const part = (px: number, y0: number, y1: number, width: number, depth: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(width, y1 - y0, depth), standInMaterial);
    m.position.set(px, (y0 + y1) / 2, 0);
    g.add(m);
  };
  const legs = h * 0.45, body = h * 0.78, arm = w * 0.2, torso = w - 2 * arm;
  part(-torso / 4, 0, legs, torso / 2 - 0.2, w / 2.4);
  part(torso / 4, 0, legs, torso / 2 - 0.2, w / 2.4);
  part(0, legs, body, torso, w / 2.4);
  part(-(torso + arm) / 2 - 0.1, legs + 1, body, arm, w / 3);
  part((torso + arm) / 2 + 0.1, legs + 1, body, arm, w / 3);
  part(0, body + 0.2, h, h - body - 0.2, h - body - 0.2);
  g.position.set(x, 0, z);
  return g;
}

/** Shows the selection where it is now. */
function drawSelection(): void {
  const r = editor.selection;
  selectionBox.visible = !!r;
  if (!r) return;
  selectionBox.scale.set(r.x1 - r.x0 + 0.2, r.y1 - r.y0 + 0.2, r.z1 - r.z0 + 0.2);
  selectionBox.position.set((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, (r.z0 + r.z1) / 2);
}

function drawVoxels(): void {
  if (voxelMesh) {
    scene.remove(voxelMesh);
    voxelMesh.dispose();
  }
  const vs = editor.voxels;
  voxelMesh = new THREE.InstancedMesh(cube, voxelMaterial, Math.max(1, vs.length));
  voxelMesh.count = vs.length;
  const m = new THREE.Matrix4(), c = new THREE.Color();
  vs.forEach((v, i) => {
    // (A hair smaller than the voxel: neighbours of the same material still read as voxels.)
    const s = v.size - Math.min(0.06, v.size * 0.04);
    m.makeScale(s, s, s).setPosition(v.x + v.size / 2, v.y + v.size / 2, v.z + v.size / 2);
    voxelMesh!.setMatrixAt(i, m);
    voxelMesh!.setColorAt(i, c.setRGB(...materialColor(v.material)));
  });
  scene.add(voxelMesh);
}

// --- Aiming and clicking ------------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
/** What the pointer's over: a voxel (its index, and the face's point and normal), or the floor. */
let aim: { index: number | null; point: THREE.Vector3; normal: THREE.Vector3 } | null = null;
let shift = false, alt = false;
/** The pointer's last move over the view (to aim again after a change: what's under it changed). */
let lastPointer: PointerEvent | null = null;

function aimAt(e: PointerEvent): void {
  lastPointer = e;
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  shift = e.shiftKey;
  alt = e.altKey;
  raycaster.setFromCamera(pointer, camera);
  aim = null;
  if (drawing) return draw();
  const hit = voxelMesh && editor.voxels.length ? raycaster.intersectObject(voxelMesh, false)[0] : undefined;
  if (hit && hit.instanceId !== undefined && hit.face) {
    aim = { index: hit.instanceId, point: hit.point.clone(), normal: hit.face.normal.clone() };
  } else {
    // Empty space: the working plane, or the box's far side.
    const { origin, direction } = raycaster.ray;
    const s = aimSurface(origin.toArray(), direction.toArray(), editor.extent, plane);
    if (s) aim = { index: null, point: new THREE.Vector3(...s.point), normal: new THREE.Vector3(...s.normal) };
  }
  showAim();
}

/** What a click would do now. */
function action(): Tool | 'pick' {
  if (alt) return 'pick';
  if (shift) return 'erase';
  return tool;
}

/** The voxel a build would place, against what's aimed at. */
function buildVoxel(): BlockVoxel | null {
  if (!aim) return null;
  const v = aim.index === null ? null : editor.voxels[aim.index]!;
  // Against a voxel's face: the point's a hair inside it on the face (so step out); clamp onto the face first.
  const point = [aim.point.x, aim.point.y, aim.point.z];
  if (v) {
    const lo = [v.x, v.y, v.z];
    point.forEach((c, a) => (point[a] = Math.min(lo[a]! + v.size - 0.001, Math.max(lo[a]! + 0.001, c))));
    const n = [aim.normal.x, aim.normal.y, aim.normal.z];
    n.forEach((d, a) => d !== 0 && (point[a] = d > 0 ? lo[a]! + v.size : lo[a]!));
    return { ...placeAgainst(point, n, voxelSize), size: voxelSize, material };
  }
  // On the plane or a wall: against it, on the side facing us.
  return { ...placeAgainst(point, [aim.normal.x, aim.normal.y, aim.normal.z], voxelSize), size: voxelSize, material };
}

const hoverEl = $('hover');
function showAim(): void {
  if (drawing) return draw();
  let act = action();
  // (Lines, boxes and round shapes start like a build: from where one would go.)
  if (act === 'line' || act === 'box' || isRound(act)) act = 'build';
  const target = aim?.index != null ? editor.voxels[aim.index] : undefined;
  ghost.visible = false;
  hoverEl.textContent = '';
  if (!aim) return;
  let box: { x: number; y: number; z: number; size: number } | null = null;
  let ok = true;
  if (act === 'build') {
    const v = buildVoxel();
    if (v) {
      const why = editor.refuse(v);
      box = v;
      ok = !why;
      hoverEl.textContent = why ? `can't build: ${why}` : `${sizeLabel(v.size)} of ${materialName(v.material)}`;
    }
  } else if (target) {
    box = target;
    ok = act !== 'erase';
    hoverEl.textContent = `${sizeLabel(target.size)} of ${materialName(target.material)}${act === 'pick' ? ' (click: use it)' : act === 'paint' ? ` → ${materialName(material)}` : act === 'select' ? ' (drag: select)' : ' (click: erase)'}`;
  }
  if (!box) return;
  const grow = act === 'build' ? 0 : 0.1;
  ghost.visible = true;
  ghost.scale.setScalar(box.size + grow);
  ghostEdges.scale.setScalar(1);
  ghost.position.set(box.x + box.size / 2, box.y + box.size / 2, box.z + box.size / 2);
  const color = act === 'pick' ? 0xffffff : !ok ? 0xff4040 : act === 'paint' ? 0xe3b341 : act === 'select' ? 0x40a0ff : 0x40ff60;
  (ghost.material as THREE.MeshBasicMaterial).color.set(color);
  (ghost.material as THREE.MeshBasicMaterial).opacity = act === 'build' ? 0.35 : 0.15;
  (ghostEdges.material as THREE.LineBasicMaterial).color.set(color);
}

function click(): void {
  if (!aim) return;
  const act = action();
  const i = aim.index;
  if (act === 'build') {
    const v = buildVoxel();
    const why = v && editor.place(v);
    if (why) say(`can't build there: ${why}`, 'bad');
  } else if (i !== null) {
    if (act === 'erase') editor.remove(i);
    else if (act === 'paint') editor.paint(i, material);
    else {
      material = editor.voxels[i]!.material;
      voxelSize = editor.voxels[i]!.size;
      drawFrame();
    }
  }
  changed();
}

// --- Lines and boxes ----------------------------------------------------------------------------

type Cell = { x: number; y: number; z: number };
/**
 * A line or box being drawn (Line, Box tools; shift: clearing instead of filling): the cell it
 * started from and the axis out of the face it started on; a line or a box's base is dragged out
 * (`end`), then a box is raised or lowered along that axis (`depth`, units) and clicked to finish.
 */
let drawing: { kind: 'line' | 'box' | 'select' | RoundShape; clear: boolean; start: Cell; axis: number; sign: 1 | -1; end: Cell; stage: 'drag' | 'raise'; depth: number; from: number } | null = null;

/** A round shape's radius (units, between cell centres) as drawn: from the centre cell to the one the pointer's over, on its plane. */
function roundRadius(d: NonNullable<typeof drawing>): number {
  return Math.hypot(d.end.x - d.start.x, d.end.y - d.start.y, d.end.z - d.start.z);
}

/** The cells of the round shape being drawn. */
function roundCells(d: NonNullable<typeof drawing>): Cell[] {
  return shapeCells(d.kind as RoundShape, d.start, d.axis as 0 | 1 | 2, d.sign, roundRadius(d), voxelSize, hollow);
}

/** Where a line or box would start: the cell a build would fill, or (clearing) the cell in what's aimed at. */
function startCell(clear: boolean): { cell: Cell; normal: number[] } | null {
  if (!aim) return null;
  const normal = [aim.normal.x, aim.normal.y, aim.normal.z].map(Math.round);
  if (!clear) {
    const v = buildVoxel();
    return v ? { cell: { x: v.x, y: v.y, z: v.z }, normal } : null;
  }
  // (On the plane or a wall, nothing's there to clear: from the cell a build would fill.)
  if (aim.index === null) {
    const v = buildVoxel();
    return v ? { cell: { x: v.x, y: v.y, z: v.z }, normal } : null;
  }
  const p = [aim.point.x, aim.point.y, aim.point.z].map((c, a) => c - normal[a]! * 0.01);
  const [x, y, z] = p.map((c) => Math.floor(c / voxelSize) * voxelSize) as [number, number, number];
  return { cell: { x, y, z }, normal };
}

const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

/**
 * Along axis `axis` through `origin`: the point nearest the pointer's ray (as `t`, units from
 * `origin`), and how far it is from the pointer on screen (NDC); null if the axis points at the eye.
 */
function alongAxis(origin: THREE.Vector3, axis: number): { t: number; off: number } | null {
  const u = AXES[axis]!, d = raycaster.ray.direction, w0 = origin.clone().sub(raycaster.ray.origin);
  const b = u.dot(d), denom = 1 - b * b;
  if (denom < 1e-4) return null;
  const t = (b * d.dot(w0) - u.dot(w0)) / denom;
  const p = origin.clone().addScaledVector(u, t).project(camera);
  return { t, off: Math.hypot(p.x - pointer.x, p.y - pointer.y) };
}

const centre = (c: Cell) => new THREE.Vector3(c.x + voxelSize / 2, c.y + voxelSize / 2, c.z + voxelSize / 2);
const snap = (t: number) => Math.round(t / voxelSize) * voxelSize;
const cellAxes = ['x', 'y', 'z'] as const;

/** The region drawn so far (clipped to the box), or null. */
function drawnRegion(): Region | null {
  if (!drawing) return null;
  const end = { ...drawing.end };
  if (drawing.kind !== 'line') end[cellAxes[drawing.axis]!] = drawing.start[cellAxes[drawing.axis]!] + drawing.depth;
  return clipRegion(regionBetween(drawing.start, end, voxelSize), editor.extent);
}

/** Follows the pointer: a line snaps to the axis it's dragged along; a box's base lies on the face it started on, then rises. */
function draw(): void {
  const d = drawing!;
  const o = centre(d.start);
  if (d.stage === 'raise') {
    // (From where the pointer was when the base was let go: it starts as a slab.)
    const a = alongAxis(o, d.axis);
    if (a) d.depth = snap(a.t - d.from);
  } else if (isRound(d.kind)) {
    // The radius: out across the plane through the centre cell (as a box's base).
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(AXES[d.axis]!, o);
    const p = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (p) {
      d.end = { x: Math.floor(p.x / voxelSize) * voxelSize, y: Math.floor(p.y / voxelSize) * voxelSize, z: Math.floor(p.z / voxelSize) * voxelSize };
      d.end[cellAxes[d.axis]!] = d.start[cellAxes[d.axis]!];
    }
    showShape(d);
    return;
  } else if (d.kind === 'line') {
    let best: { axis: number; t: number; off: number } | null = null;
    for (let axis = 0; axis < 3; axis++) {
      const a = alongAxis(o, axis);
      if (a && (!best || a.off < best.off)) best = { axis, ...a };
    }
    if (best) {
      d.end = { ...d.start };
      d.end[cellAxes[best.axis]!] += snap(best.t);
    }
  } else {
    // On the plane through the start cell's middle, across the axis out of its face.
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(AXES[d.axis]!, o);
    const p = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (p) {
      d.end = { x: Math.floor(p.x / voxelSize) * voxelSize, y: Math.floor(p.y / voxelSize) * voxelSize, z: Math.floor(p.z / voxelSize) * voxelSize };
      d.end[cellAxes[d.axis]!] = d.start[cellAxes[d.axis]!];
    }
  }
  const r = drawnRegion();
  ghost.visible = !!r;
  if (!r) {
    hoverEl.textContent = 'outside the box';
    return;
  }
  const size = [r.x1 - r.x0, r.y1 - r.y0, r.z1 - r.z0];
  ghost.scale.set(size[0]! + 0.1, size[1]! + 0.1, size[2]! + 0.1);
  ghostEdges.scale.setScalar(1);
  ghost.position.set((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, (r.z0 + r.z1) / 2);
  const color = d.kind === 'select' ? 0x40a0ff : d.clear ? 0xff4040 : 0x40ff60;
  (ghost.material as THREE.MeshBasicMaterial).color.set(color);
  (ghost.material as THREE.MeshBasicMaterial).opacity = 0.25;
  (ghostEdges.material as THREE.LineBasicMaterial).color.set(color);
  const n = size.map((s) => s / voxelSize);
  const what = d.kind === 'select' ? `select ${n.join(' × ')} of ${sizeLabel(voxelSize)}` : `${n.join(' × ')} of ${sizeLabel(voxelSize)}${d.clear ? ': clear it' : ` ${materialName(material)}: ${n[0]! * n[1]! * n[2]!} voxels`}`;
  hoverEl.textContent = d.stage === 'raise' ? `${what} · move to raise it, click to finish (Esc: stop)` : what;
}

/** Shows the round shape being drawn, voxel by voxel, and says what it is. */
function showShape(d: NonNullable<typeof drawing>): void {
  const cells = roundCells(d);
  const m = new THREE.Matrix4(), half = voxelSize / 2;
  shapePreview.count = Math.min(cells.length, SHAPE_PREVIEW_MAX);
  for (let i = 0; i < shapePreview.count; i++) {
    const c = cells[i]!;
    m.makeScale(voxelSize * 0.96, voxelSize * 0.96, voxelSize * 0.96).setPosition(c.x + half, c.y + half, c.z + half);
    shapePreview.setMatrixAt(i, m);
  }
  shapePreview.instanceMatrix.needsUpdate = true;
  (shapePreview.material as THREE.MeshBasicMaterial).color.set(d.clear ? 0xff4040 : 0x40ff60);
  ghost.visible = false;
  const radiusM = Math.round(roundRadius(d) / voxelSize) * voxelSize / BLOCK_SIZE;
  const name = d.kind === 'circle' ? (hollow ? 'ring' : 'circle') : `${hollow ? 'hollow ' : ''}${d.kind}`;
  hoverEl.textContent = `${name}, radius ${radiusM} m of ${sizeLabel(voxelSize)}${d.clear ? ': clear it' : ` ${materialName(material)}: ${cells.length} voxels`} · let go to ${d.clear ? 'clear' : 'make'} it (Esc: stop)`;
}

function hideShape(): void {
  shapePreview.count = 0;
}

/** Fills (or clears) what's been drawn. */
function finishDrawing(): void {
  const d = drawing!;
  const r = drawnRegion();
  drawing = null;
  controls.enabled = true;
  if (isRound(d.kind)) {
    hideShape();
    const cells = roundCells(d);
    if (d.clear) {
      const n = editor.clearCells(cells, voxelSize);
      say(n ? `cleared ${n} voxel${n === 1 ? '' : 's'}` : 'nothing there to clear');
    } else {
      const { placed, skipped } = editor.fill(cells, voxelSize, material);
      say(`${placed} voxel${placed === 1 ? '' : 's'} in${skipped ? `, ${skipped} skipped (taken, or outside the box)` : ''}`, placed ? '' : 'bad');
    }
    changed();
    return;
  }
  if (d.kind === 'select') {
    editor.selection = r;
    sayMove();
  } else if (r) {
    if (d.clear) {
      const n = editor.clearRegion(r);
      say(n ? `cleared ${n} voxel${n === 1 ? '' : 's'}` : 'nothing there to clear');
    } else {
      const { placed, skipped } = editor.fill(cellsIn(r, voxelSize), voxelSize, material);
      say(`${placed} voxel${placed === 1 ? '' : 's'} in${skipped ? `, ${skipped} skipped (taken)` : ''}`, placed ? '' : 'bad');
    }
  }
  changed();
}

// --- Moving a selection --------------------------------------------------------------------------

/** Says what's selected and how far a move goes. */
function sayMove(): void {
  if (!editor.selection) return say('nothing selected');
  const { inside, partly } = editor.selected();
  if (!inside.length) return say(`nothing wholly inside the selection${partly ? ` (${partly} only partly inside: they stay put)` : ''}`, 'bad');
  say(`${inside.length} voxel${inside.length === 1 ? '' : 's'} selected${partly ? `, ${partly} only partly inside (they stay put)` : ''} · moves ${sizeLabel(editor.moveStep(voxelSize))} at a time (arrows, shift ↑ ↓: up and down)`);
}

const DIRECTIONS = ['left', 'right', 'down', 'up', 'back', 'front'];

/** Moves the selection and what's in it a step along `axis` (0 x, 1 y, 2 z) in direction `dir`. */
function moveSelection(axis: 0 | 1 | 2, dir: 1 | -1): void {
  const why = editor.move(axis, dir, voxelSize);
  if (why) return say(`can't move it: ${why}`, 'bad');
  changed();
  const { inside } = editor.selected();
  say(`moved ${inside.length} voxel${inside.length === 1 ? '' : 's'} ${DIRECTIONS[axis * 2 + (dir > 0 ? 1 : 0)]} ${sizeLabel(editor.moveStep(voxelSize))}`);
}

/**
 * The arrow keys, as the view is turned: up and down move away from and toward the eye, left and
 * right across it (each along whichever of x and z is nearest); `vertical`: up and down are up and down.
 */
function arrowMove(key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight', vertical: boolean): void {
  if (vertical && (key === 'ArrowUp' || key === 'ArrowDown')) return moveSelection(1, key === 'ArrowUp' ? 1 : -1);
  const forward = camera.getWorldDirection(new THREE.Vector3()).setY(0);
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
  const v = key === 'ArrowUp' ? forward : key === 'ArrowDown' ? forward.negate() : key === 'ArrowRight' ? right : right.negate();
  if (Math.abs(v.x) >= Math.abs(v.z)) moveSelection(0, v.x > 0 ? 1 : -1);
  else moveSelection(2, v.z > 0 ? 1 : -1);
}

function stopDrawing(): void {
  if (!drawing) return;
  drawing = null;
  hideShape();
  controls.enabled = true;
  showAim();
}

let down: { x: number; y: number; button: number } | null = null;
/** A box being raised was clicked to finish: that press isn't the start of anything else. */
let finishing = false;
// (Caught before the view's controls see it: a press that starts a line or box mustn't turn the view.)
view.addEventListener(
  'pointerdown',
  (e) => {
    if (e.target !== renderer.domElement) return;
    down = { x: e.clientX, y: e.clientY, button: e.button };
    if (e.button !== 0) return;
    if (drawing?.stage === 'raise') {
      controls.enabled = false;
      finishing = true;
      aimAt(e);
      finishDrawing();
      controls.enabled = false; // (until the button's up: this press doesn't turn the view)
      return;
    }
    if (drags(tool) && !e.altKey) {
      aimAt(e);
      // (Shift: as the press says, or as the keyboard last did. A selection starts in what's aimed at, as clearing does.)
      const clear = tool !== 'select' && (e.shiftKey || shift);
      const s = startCell(clear || tool === 'select');
      if (!s) return;
      const axis = Math.max(0, s.normal.findIndex((c) => c !== 0));
      const sign: 1 | -1 = (s.normal[axis] ?? 1) < 0 ? -1 : 1;
      drawing = { kind: tool, clear, start: s.cell, axis, sign, end: { ...s.cell }, stage: 'drag', depth: 0, from: 0 };
      controls.enabled = false;
      draw();
    }
  },
  { capture: true },
);
renderer.domElement.addEventListener('pointerup', (e) => {
  if (finishing) {
    finishing = false;
    controls.enabled = true;
    down = null;
    return;
  }
  if (drawing?.stage === 'drag') {
    aimAt(e);
    if (drawing.kind === 'line' || isRound(drawing.kind)) finishDrawing();
    else {
      drawing.stage = 'raise';
      drawing.from = alongAxis(centre(drawing.start), drawing.axis)?.t ?? 0;
      controls.enabled = true;
      draw();
    }
    down = null;
    return;
  }
  // A click, not a drag (turning or moving the view).
  if (down && e.button === 0 && down.button === 0 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5 && !drags(tool)) {
    aimAt(e);
    click();
  }
  down = null;
});
renderer.domElement.addEventListener('pointermove', aimAt);
renderer.domElement.addEventListener('pointerleave', () => {
  lastPointer = null;
  aim = null;
  showAim();
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// --- The panels ---------------------------------------------------------------------------------

const toolsEl = $('tools'), sizesEl = $('sizes'), mirrorEl = $<HTMLButtonElement>('mirror');
const hollowEl = $<HTMLButtonElement>('hollow');
hollowEl.onclick = () => {
  hollow = !hollow;
  if (drawing && isRound(drawing.kind)) draw();
  renderPanels();
};
const undoEl = $<HTMLButtonElement>('undo'), redoEl = $<HTMLButtonElement>('redo');
for (const b of toolsEl.querySelectorAll<HTMLButtonElement>('button')) b.onclick = () => setTool(b.dataset.tool as Tool);
for (const s of GRID_SIZES) {
  const b = document.createElement('button');
  b.textContent = sizeLabel(s);
  b.dataset.size = String(s);
  b.title = `${sizeLabel(s)} voxels (${GRID_SIZES.indexOf(s) + 1})`;
  b.onclick = () => setVoxelSize(s);
  sizesEl.append(b);
}
mirrorEl.onclick = () => {
  editor.mirror = !editor.mirror;
  renderPanels();
};
undoEl.onclick = () => {
  editor.undo();
  changed(true);
};
redoEl.onclick = () => {
  editor.redo();
  changed(true);
};

// --- The working plane --------------------------------------------------------------------------

const PLANE_NAMES = ['upright (side)', 'flat', 'upright (front)'];
const planeEl = $('plane-at');

/** Draws the working plane (but not when it lies on the floor: the floor's grid is there). */
function drawPlane(): void {
  for (const c of [...planeGroup.children]) {
    planeGroup.remove(c);
    c.traverse((o) => (o instanceof THREE.LineSegments || o instanceof THREE.Mesh) && o.geometry.dispose());
  }
  const ext = editor.extent;
  plane.at = Math.max(0, Math.min(ext[plane.axis]!, plane.at));
  const m = (plane.at / BLOCK_SIZE).toFixed(3).replace(/\.?0+$/, '');
  planeEl.textContent = plane.axis === 1 && plane.at === 0 ? 'plane: floor' : `${PLANE_NAMES[plane.axis]} ${m} m ${plane.axis === 1 ? 'up' : plane.axis === 2 ? 'from back' : 'from left'}`;
  if (plane.axis === 1 && plane.at === 0) return;
  // Its two in-plane axes (u, v) and the grid on it: metres plainly, the voxel size faintly.
  const [u, v] = [0, 1, 2].filter((a) => a !== plane.axis) as [number, number];
  const pt = (pu: number, pv: number) => {
    const p = [0, 0, 0];
    p[plane.axis] = plane.at;
    p[u] = pu;
    p[v] = pv;
    return p;
  };
  const fine: number[] = [], metres: number[] = [];
  const step = Math.min(voxelSize, BLOCK_SIZE / 2);
  for (let a = 0; a <= ext[u]!; a += step) (a % BLOCK_SIZE ? fine : metres).push(...pt(a, 0), ...pt(a, ext[v]!));
  for (let b = 0; b <= ext[v]!; b += step) (b % BLOCK_SIZE ? fine : metres).push(...pt(0, b), ...pt(ext[u]!, b));
  planeGroup.add(lines(fine, 0x58a6ff, 0.18), lines(metres, 0x58a6ff, 0.5));
  const quad = new THREE.Mesh(
    new THREE.BufferGeometry().setFromPoints([pt(0, 0), pt(ext[u]!, 0), pt(ext[u]!, ext[v]!), pt(0, 0), pt(ext[u]!, ext[v]!), pt(0, ext[v]!)].map((p) => new THREE.Vector3(...p))),
    new THREE.MeshBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }),
  );
  planeGroup.add(quad);
}

/** Moves the working plane a voxel size along its axis (up, or back to front, or left to right). */
function stepPlane(dir: 1 | -1): void {
  plane.at = Math.round((plane.at + dir * voxelSize) / voxelSize) * voxelSize;
  drawPlane();
  showAim();
}

/** Turns the working plane: flat, upright facing the front, upright facing the side (each at the box's middle when upright). */
function turnPlane(): void {
  const next = ({ 1: 2, 2: 0, 0: 1 } as const)[plane.axis];
  const mid = Math.floor(editor.extent[next]! / 2 / voxelSize) * voxelSize;
  plane = { axis: next, at: next === 1 ? 0 : mid };
  drawPlane();
  showAim();
}

function resetPlane(): void {
  plane = { axis: 1, at: 0 };
  drawPlane();
  showAim();
}

$('plane-down').onclick = () => stepPlane(-1);
$('plane-up').onclick = () => stepPlane(1);
$('plane-turn').onclick = () => turnPlane();
$('plane-home').onclick = () => resetPlane();
for (const b of $('move').querySelectorAll<HTMLButtonElement>('button[data-axis]')) b.onclick = () => moveSelection(Number(b.dataset.axis) as 0 | 1 | 2, Number(b.dataset.dir) as 1 | -1);
$('move-done').onclick = () => {
  editor.selection = null;
  changed();
  say('nothing selected');
};

function setTool(t: Tool): void {
  stopDrawing();
  tool = t;
  renderPanels();
  showAim();
}

function setVoxelSize(s: number): void {
  voxelSize = s;
  drawFrame();
  renderPanels();
  showAim();
}

const palette = $('palette');
for (const m of DESIGN_MATERIALS) {
  const b = document.createElement('button');
  b.style.background = css(materialColor(m));
  b.title = materialName(m);
  b.dataset.material = String(m);
  b.onclick = () => {
    material = m;
    renderPanels();
    showAim();
  };
  palette.append(b);
}

const nameEl = $<HTMLInputElement>('name');
nameEl.oninput = () => editor.set((d) => (d.name = nameEl.value));
nameEl.onchange = () => renderLibrary();
const sizeEls = (['x', 'y', 'z'] as const).map((a) => $<HTMLSelectElement>(`size-${a}`));
for (const el of sizeEls) {
  for (let n = 1; n <= DESIGN_MAX_BLOCKS; n++) el.append(new Option(String(n), String(n)));
  el.onchange = () => {
    const dropped = editor.resize(sizeEls.map((s) => Number(s.value)) as [number, number, number]);
    if (dropped) say(`${dropped} voxel${dropped === 1 ? '' : 's'} outside the new size went (undo brings them back)`, 'bad');
    drawFrame();
    frameCamera();
    changed(true);
  };
}

const statesEl = $('states');
$('add-state').onclick = () => {
  if (!editor.addState(`state ${editor.draft.states.length + 1}`)) say('that’s as many states as there can be', 'bad');
  changed(true);
};
$('clear').onclick = () => {
  editor.clear();
  changed(true);
};

const roleEl = $<HTMLSelectElement>('role');
roleEl.append(new Option('nothing (an object of its own)', ''), ...STATIONS.map((s) => new Option(`the ${s.name}`, s.role)));
roleEl.onchange = () => {
  const role = (roleEl.value || null) as DesignRole | null;
  editor.set((d) => {
    if (role) d.role = role;
    else delete d.role;
  });
  changed();
};

/** The saved design (not this one) standing in for station `role`, if any. */
const holderOf = (role: DesignRole) => library.find((d) => d.role === role && d.id !== editor.draft.id);

/** The stations, each with who stands in for it now (so taking one from another design isn't a surprise). */
function renderRoles(): void {
  const saved = editor.draft.id ? library.find((d) => d.id === editor.draft.id)?.role : undefined;
  for (const o of roleEl.options) {
    if (!o.value) continue;
    const role = o.value as DesignRole, holder = holderOf(role);
    o.textContent = `the ${stationOf(role).name}${holder ? ` (now: ${holder.name})` : saved === role ? ' (this one)' : ' (none yet)'}`;
  }
  const role = editor.draft.role, holder = role && holderOf(role);
  const warning = $('role-warning');
  warning.hidden = !holder;
  if (holder) warning.textContent = `Saving takes the ${stationOf(role).name} away from ${holder.name} (it then stands in for nothing).`;
}

/** How a station's made, for people: "8 cobblestone, at a crafting table". */
function stationRecipe(role: DesignRole): string {
  const s = stationOf(role);
  const r = role === 'crafting-table' ? RECIPES.find((x) => x.id === 'crafting-table') : s.recipe && { ...s.recipe };
  if (!r) return `no recipe yet: creative only`;
  return `its recipe: ${r.inputs.map(([id, n]) => `${n} ${itemName(id)}`).join(' + ')}${r.table ? ', at a crafting table' : ''}`;
}
const craftableEl = $<HTMLInputElement>('craftable'), countEl = $<HTMLInputElement>('count'), tableEl = $<HTMLInputElement>('table');
const recipeRows = $('recipe-rows');
craftableEl.onchange = () => {
  editor.set((d) => (d.recipe = craftableEl.checked ? { inputs: [[Material.Planks, 1]], count: 1, table: true } : null));
  renderPanels();
};
countEl.onchange = () => editor.set((d) => d.recipe && (d.recipe.count = Math.max(1, Math.min(64, Math.round(Number(countEl.value)) || 1))));
tableEl.onchange = () => editor.set((d) => d.recipe && (d.recipe.table = tableEl.checked));
$('add-input').onclick = () => {
  editor.set((d) => {
    if (!d.recipe || d.recipe.inputs.length >= DESIGN_MAX_INPUTS) return;
    const free = ingredients().find((id) => !d.recipe!.inputs.some(([i]) => i === id));
    if (free !== undefined) d.recipe.inputs.push([free, 1]);
  });
  renderPanels();
};

/** What recipes can take: anything players can have, but water (and not this object). */
function ingredients(): number[] {
  const self = library.find((d) => d.id === editor.draft.id)?.item;
  return ALL_ITEMS.filter((id) => !(isBlock(id) && isWater(id)) && id !== self);
}

function renderRecipe(): void {
  const role = editor.draft.role;
  renderRoles();
  roleEl.value = role ?? '';
  $('role-note').hidden = $('recipe-station').hidden = !role;
  $('recipe-own').hidden = !!role;
  if (role) {
    const s = stationOf(role);
    $('role-note').textContent = `The ${s.name} item places it, and gives one back when it's taken down; for ${s.use}. One object at most is the ${s.name}.`;
    $('recipe-station').textContent = `Made as the ${s.name} (${stationRecipe(role)}).`;
  }
  const r = editor.draft.recipe;
  craftableEl.checked = !!r;
  $('recipe').hidden = !r;
  $('no-recipe').hidden = !!r;
  recipeRows.replaceChildren();
  if (!r) return;
  countEl.value = String(r.count);
  tableEl.checked = r.table;
  r.inputs.forEach(([id, n], k) => {
    const row = document.createElement('div');
    row.className = 'row';
    const sel = document.createElement('select');
    for (const i of ingredients()) sel.append(new Option(`${itemName(i)}${isBlock(i) ? ' (m³)' : ''}`, String(i), false, i === id));
    sel.onchange = () => editor.set((d) => (d.recipe!.inputs[k]![0] = Number(sel.value)));
    const amount = document.createElement('input');
    amount.type = 'number';
    amount.min = '1';
    amount.max = '64';
    amount.value = String(n);
    amount.onchange = () => editor.set((d) => (d.recipe!.inputs[k]![1] = Math.max(1, Math.min(64, Math.round(Number(amount.value)) || 1))));
    const rm = document.createElement('button');
    rm.textContent = '✕';
    rm.title = 'Take it out';
    rm.disabled = r.inputs.length < 2;
    rm.onclick = () => {
      editor.set((d) => d.recipe!.inputs.splice(k, 1));
      renderPanels();
    };
    row.append(sel, amount, rm);
    recipeRows.append(row);
  });
  ($('add-input') as HTMLButtonElement).disabled = r.inputs.length >= DESIGN_MAX_INPUTS;
}

function renderStates(): void {
  statesEl.replaceChildren();
  editor.draft.states.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = i === editor.state ? 'current' : '';
    const pick = document.createElement('input');
    pick.type = 'radio';
    pick.name = 'state';
    pick.checked = i === editor.state;
    pick.title = 'Edit this state';
    pick.onchange = () => {
      editor.state = i;
      changed(true);
    };
    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 24;
    name.value = s.name;
    name.onfocus = () => {
      if (editor.state !== i) {
        editor.state = i;
        changed(true);
      }
    };
    name.onchange = () => editor.renameState(i, name.value.trim() || s.name);
    const count = document.createElement('span');
    count.className = 'note';
    count.textContent = String(s.voxels.length);
    count.title = 'voxels';
    const rm = document.createElement('button');
    rm.textContent = '✕';
    rm.title = 'Take this state away';
    rm.disabled = editor.draft.states.length < 2;
    rm.onclick = () => {
      editor.removeState(i);
      changed(true);
    };
    li.append(pick, name, count, rm);
    statesEl.append(li);
  });
}

function renderPanels(): void {
  for (const b of toolsEl.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', b.dataset.tool === tool);
  for (const b of sizesEl.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', Number(b.dataset.size) === voxelSize);
  for (const b of palette.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', Number(b.dataset.material) === material);
  $('material-name').textContent = materialName(material);
  mirrorEl.classList.toggle('on', editor.mirror);
  hollowEl.classList.toggle('on', hollow);
  $('move').hidden = !editor.selection;
  undoEl.disabled = !editor.canUndo;
  redoEl.disabled = !editor.canRedo;
  if (document.activeElement !== nameEl) nameEl.value = editor.draft.name;
  editor.draft.size.forEach((n, a) => (sizeEls[a]!.value = String(n)));
  renderStates();
  renderRecipe();
  const total = editor.draft.states.reduce((n, s) => n + s.voxels.length, 0);
  $('stats').textContent = `${editor.voxels.length} voxels in this state (at most ${DESIGN_MAX_VOXELS}), ${total} in all` + (editor.draft.id ? ` · id ${editor.draft.id}` : ' · not saved yet');
  ($('save') as HTMLButtonElement).disabled = !canEdit;
  ($('delete') as HTMLButtonElement).disabled = !canEdit || !editor.draft.id;
  ($('delete') as HTMLButtonElement).textContent = armed?.what === 'delete' && armed.until > performance.now() ? 'Really delete?' : 'Delete';
}

/** After a change: redraw what it touched (`all`: the panels too). */
function changed(all = false): void {
  drawVoxels();
  drawSelection();
  if (all) drawFrame();
  renderPanels();
  if (lastPointer) aimAt(lastPointer);
  else showAim();
  renderLibrary();
}

const libraryEl = $('library');
function renderLibrary(): void {
  libraryEl.replaceChildren();
  const entries = [...library];
  // A new one, not saved: listed first.
  if (!editor.draft.id) entries.unshift({ ...editor.body(), item: 0 } as ObjectDesign);
  for (const d of entries) {
    const li = document.createElement('li');
    const current = d.id === (editor.draft.id ?? editor.body().id) && (!!editor.draft.id || d.item === 0);
    li.className = current ? 'current' : '';
    const name = current ? editor.draft.name : d.name;
    const size = current ? editor.draft.size : d.size;
    const states = current ? editor.draft.states.length : d.states.length;
    li.innerHTML = '<div class="name"></div><div class="sub"></div>';
    li.querySelector('.name')!.textContent = `${name}${current && editor.dirty ? ' •' : ''}`;
    const role = current ? editor.draft.role : d.role;
    li.querySelector('.sub')!.textContent = `${size.join(' × ')} m · ${states} state${states === 1 ? '' : 's'}${d.item === 0 ? ' · not saved' : ''}${role ? ` · the ${stationOf(role).name}` : d.item !== 0 && !d.recipe ? ' · creative only' : ''}`;
    li.onclick = () => d.item !== 0 && open(d);
    libraryEl.append(li);
  }
}

/** Whether to go ahead and lose unsaved changes (a second click within a few seconds says yes). */
function discardOk(what: string): boolean {
  if (!editor.dirty) return true;
  if (armed?.what === what && armed.until > performance.now()) return true;
  armed = { what, until: performance.now() + 4000 };
  say('unsaved changes: click again to drop them', 'bad');
  return false;
}

function open(d: ObjectDesign | null): void {
  if (!discardOk(`open:${d?.id ?? 'new'}`)) return;
  armed = null;
  editor = new DesignEditor(d ? draftOf(d) : newDraft());
  say(d ? `editing ${d.name}` : 'a new object');
  drawFrame();
  frameCamera();
  changed(true);
}
$('new').onclick = () => open(null);

// --- Folding the side panels (more room to build; remembered in this browser) --------------------

const layoutEl = document.querySelector<HTMLElement>('.layout')!;
const FOLD_KEY = 'super-vox.designer.folded';
function setFolded(side: 'left' | 'right', folded: boolean): void {
  layoutEl.classList.toggle(`no-${side}`, folded);
  const btn = $<HTMLButtonElement>(`fold-${side}`);
  const toward = side === 'left' ? folded : !folded;
  btn.textContent = toward ? '›' : '‹';
  btn.title = `${folded ? 'Show' : 'Hide'} the ${side === 'left' ? 'library' : 'object panel'}`;
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify({ left: layoutEl.classList.contains('no-left'), right: layoutEl.classList.contains('no-right') }));
  } catch {
    // (No storage: it just isn't remembered.)
  }
}
for (const side of ['left', 'right'] as const) $(`fold-${side}`).onclick = () => setFolded(side, !layoutEl.classList.contains(`no-${side}`));
try {
  const saved = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') as { left?: boolean; right?: boolean };
  setFolded('left', !!saved.left);
  setFolded('right', !!saved.right);
} catch {
  setFolded('left', false);
  setFolded('right', false);
}

// --- Export and import --------------------------------------------------------------------------

/** A design as exported: without its item number (each server gives its own). */
const exported = (d: Omit<ObjectDesign, 'item'> & { item?: number }) => {
  const { item: _, ...rest } = d;
  return rest;
};

function download(name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('export-one').onclick = () => {
  const body = editor.body(new Set(library.map((d) => d.id)));
  download(`${body.id}.design.json`, { designs: [exported(body)] });
  say(`exported ${editor.draft.name}${editor.dirty ? ' (as it is now, unsaved changes and all)' : ''}`, 'good');
};
$('export-all').onclick = () => {
  if (!library.length) return say('the library is empty', 'bad');
  download('designs.json', { designs: library.map(exported) });
  say(`exported ${library.length} object${library.length === 1 ? '' : 's'}`, 'good');
};

const importEl = $<HTMLInputElement>('import-file');
$('import').onclick = () => importEl.click();
importEl.onchange = async () => {
  const files = [...(importEl.files ?? [])];
  importEl.value = '';
  const found: unknown[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(await f.text()) as unknown;
      // A file of them ({ designs: [...] }, as exported, or a server's library file), a list, or one.
      const list = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { designs?: unknown }).designs) ? (data as { designs: unknown[] }).designs : [data];
      found.push(...list);
    } catch {
      return say(`${f.name} isn't a design file`, 'bad');
    }
  }
  // Each checked as the server will (with a stand-in item number).
  const designs: ObjectDesign[] = [];
  for (const raw of found) {
    const d = parseDesign({ ...(raw as object), item: FIRST_DESIGN_ITEM });
    if (typeof d === 'string') return say(`can't import ${(raw as { name?: string })?.name ?? 'a design'}: ${d}`, 'bad');
    designs.push(d);
  }
  if (!designs.length) return say('nothing to import', 'bad');
  if (designs.length === 1) {
    // One: to look over, then save (a new id if this one's taken).
    if (!discardOk('import')) return;
    armed = null;
    const d = designs[0]!;
    const taken = library.some((x) => x.id === d.id);
    editor = new DesignEditor({ ...draftOf(d), id: taken ? null : d.id });
    editor.dirty = true;
    drawFrame();
    frameCamera();
    changed(true);
    return say(`imported ${d.name}: not saved yet${taken ? ' (one here has its id already: it saves as a new one)' : ''}`, 'good');
  }
  if (!canEdit) return say('importing several saves them: that is for admins', 'bad');
  let saved = 0;
  const skipped: string[] = [];
  for (const d of designs) {
    if (library.some((x) => x.id === d.id)) {
      skipped.push(d.name);
      continue;
    }
    const res = await fetch(`/api/designs/${encodeURIComponent(d.id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exported(d)) });
    if (!res.ok) return say(`stopped at ${d.name}: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText} (${saved} saved before it)`, 'bad');
    saved++;
  }
  library = ((await (await fetch('/api/designs')).json()) as { designs: ObjectDesign[] }).designs;
  setDesigns(library);
  renderLibrary();
  say(`imported ${saved}${skipped.length ? `; left alone (already here): ${skipped.join(', ')}` : ''}`, saved ? 'good' : 'bad');
};

$('save').onclick = async () => {
  const body = editor.body(new Set(library.map((d) => d.id)));
  say('saving…');
  const res = await fetch(`/api/designs/${encodeURIComponent(body.id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const reply = (await res.json().catch(() => ({}))) as { design?: ObjectDesign; error?: string };
  if (!res.ok || !reply.design) return say(`not saved: ${reply.error ?? res.statusText}`, 'bad');
  const saved = reply.design;
  // (Saving one can change others: taking over as the crafting table. The library as it is now.)
  library = ((await (await fetch('/api/designs')).json()) as { designs: ObjectDesign[] }).designs;
  setDesigns(library);
  editor.saved(saved.id);
  say(`saved ${saved.name}: in every world now`, 'good');
  changed();
};

$('delete').onclick = async () => {
  const id = editor.draft.id;
  if (!id) return;
  if (!(armed?.what === 'delete' && armed.until > performance.now())) {
    armed = { what: 'delete', until: performance.now() + 4000 };
    say('click Delete again to take it out of the library (placed ones stay; their items stop working)', 'bad');
    renderPanels();
    return;
  }
  armed = null;
  const res = await fetch(`/api/designs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) return say(`not deleted: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText}`, 'bad');
  library = library.filter((d) => d.id !== id);
  setDesigns(library);
  editor.dirty = false;
  say('deleted', 'good');
  open(library[0] ?? null);
};

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') {
    e.preventDefault();
    if (e.shiftKey) editor.redo();
    else editor.undo();
    return changed(true);
  }
  if (e.metaKey || e.ctrlKey) return;
  const n = Number(e.key);
  if (n >= 1 && n <= GRID_SIZES.length) setVoxelSize(GRID_SIZES[n - 1]!);
  else if (e.code === 'Escape') {
    // (A line or box being drawn first; then the selection.)
    if (drawing) stopDrawing();
    else if (editor.selection) {
      editor.selection = null;
      changed();
      say('nothing selected');
    }
  } else if ((e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight') && editor.selection) {
    e.preventDefault();
    arrowMove(e.code, e.shiftKey);
  }
  else if (e.code === 'BracketRight' || e.code === 'PageUp') stepPlane(1);
  else if (e.code === 'BracketLeft' || e.code === 'PageDown') stepPlane(-1);
  else if (e.code === 'KeyV') turnPlane();
  else if (e.code === 'Home') resetPlane();
  else if (e.code === 'KeyB') setTool('build');
  else if (e.code === 'KeyL') setTool('line');
  else if (e.code === 'KeyF') setTool('box');
  else if (e.code === 'KeyS') setTool('select');
  else if (e.code === 'KeyC') setTool('circle');
  else if (e.code === 'KeyD') setTool('dome');
  else if (e.code === 'KeyR') setTool('sphere');
  else if (e.code === 'KeyH') hollowEl.click();
  else if (e.code === 'KeyE') setTool('erase');
  else if (e.code === 'KeyP') setTool('paint');
  else if (e.code === 'KeyM') mirrorEl.click();
  if (e.key === 'Shift' || e.key === 'Alt') {
    shift = e.shiftKey;
    alt = e.altKey;
    showAim();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift' || e.key === 'Alt') {
    shift = e.shiftKey;
    alt = e.altKey;
    showAim();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (editor.dirty) e.preventDefault();
});

function loop(): void {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

async function start(): Promise<void> {
  resize();
  try {
    const res = await fetch('/api/designs');
    const body = (await res.json()) as { designs: ObjectDesign[]; canEdit: boolean };
    library = body.designs;
    canEdit = body.canEdit;
    setDesigns(library);
  } catch (err) {
    say(`couldn't load the library: ${err instanceof Error ? err.message : String(err)}`, 'bad');
  }
  const ro = $('readonly');
  ro.hidden = canEdit;
  ro.textContent = 'Looking only: saving designs is for admins (sign in on the menu page).';
  open(library[0] ?? null);
  say(library.length ? `${library.length} object${library.length === 1 ? '' : 's'} in the library` : 'the library is empty: build the first one');
  loop();
}
void start();
