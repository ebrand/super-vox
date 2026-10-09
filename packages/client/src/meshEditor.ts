import './header.js';
import './fullscreen.js';
import './envBadge.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { CLIP_IDS, poseClip, type AnimationLibrary, type Avatar, type ClipId, type FigureKind, type FigureMesh, type MeshLibrary } from '@super-vox/shared';
import { FigureEdit, PIECES, mirrorOf, type Piece } from './meshEdit.js';
import { PlayerFigure, fromMesh, madeModel, modelOf, setAnimations, setMeshes, toMesh } from './playerFigure.js';

/**
 * The mesh editor (admins): the player figures (the man, the woman, their hair) as everyone sees
 * them. Pick a piece; move, turn or scale it about its joint (the joints below following), or pick
 * its corners and move them; left and right alike if asked. Seen standing as edited, or doing any
 * of the animation designer's clips. Saved, it's the server's mesh library: every player's figure
 * at once (and the animation designer's). See FigureEdit for the editing itself.
 */

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const status = (text: string, kind: '' | 'good' | 'bad' = '') => {
  statusEl.textContent = text;
  statusEl.className = kind;
};

let library: MeshLibrary = { figures: {} };
let canEdit = false;
let kind: FigureKind = 'man';
let edit = new FigureEdit(toMesh(madeModel('man')));
/** What's saved of this figure (to tell if it's changed). */
let savedJson = '';
let piece: Piece = 'chest';
let mode: 'piece' | 'corners' = 'piece';
let tool: 'translate' | 'rotate' | 'scale' = 'translate';
const selected = new Set<number>();

// --- The view.
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
view.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1f26);
const camera = new THREE.PerspectiveCamera(35, 1, 0.02, 100);
camera.position.set(1.6, 1.5, -2.6); // (in front: the figure faces -z)
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 0.95, 0);
orbit.update();
scene.add(new THREE.GridHelper(4, 16, 0x3a414b, 0x262c34));
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSize(0.7);
scene.add(gizmo.getHelper());
const handle = new THREE.Object3D();
scene.add(handle);

const COLOURED: Omit<Avatar, 'figure'> = { skin: '#d9b99b', shirt: '#6f93c0', trousers: '#4a5568', shoes: '#2d2a26', hair: '#5a3d27' };
const PLAIN: Omit<Avatar, 'figure'> = { skin: '#c9b3b3', shirt: '#c9b3b3', trousers: '#c9b3b3', shoes: '#c9b3b3', hair: '#9c8584' };
let figure: PlayerFigure | null = null;
/** The picked piece's material (brighter: its own, to let go of when drawn again). */
let pickedMaterial: THREE.Material | null = null;
/** The corners of the piece picked, as points (the picked ones red). */
let points: THREE.Points | null = null;

function resize(): void {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

/** Where piece `p`'s joint is standing (the hair: the head's). */
const pivotOf = (p: Piece) => edit.pivot(p);

/** The figure as edited, drawn again (and the corners and handle with it). */
function redraw(): void {
  if (figure) {
    scene.remove(figure.root);
    figure.dispose();
  }
  const look = { ...($<HTMLInputElement>('parts-coloured').checked ? COLOURED : PLAIN), figure: kind } as Avatar;
  figure = new PlayerFigure(look, fromMesh(edit.mesh));
  scene.add(figure.root);
  posePreview(performance.now());
  // The picked piece stands out (the others a little dimmed).
  figure.tint(0.75);
  const pickedMesh = piece === 'hair' ? figure.joints.get('head')!.children.find((o) => o.name === 'hair') : figure.joints.get(piece)!.children.find((o) => o.name.endsWith(' part'));
  pickedMaterial?.dispose();
  pickedMaterial = null;
  if (pickedMesh) {
    const m = ((pickedMesh as THREE.Mesh).material as THREE.MeshBasicMaterial).clone();
    m.color.multiplyScalar(1.3);
    (pickedMesh as THREE.Mesh).material = pickedMaterial = m;
  }
  showCorners();
  placeHandle();
  refresh();
}

function showCorners(): void {
  if (points) {
    scene.remove(points);
    points.geometry.dispose();
    (points.material as THREE.Material).dispose();
    points = null;
  }
  if (mode !== 'corners' || playing) return;
  const cs = edit.corners(piece), at = pivotOf(piece);
  const pos = new Float32Array(cs.length * 3), col = new Float32Array(cs.length * 3);
  cs.forEach((c, i) => {
    pos.set([c.at.x + at.x, c.at.y + at.y, c.at.z + at.z], i * 3);
    col.set(selected.has(i) ? [1, 0.25, 0.2] : [0.95, 0.95, 0.95], i * 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  points = new THREE.Points(g, new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, vertexColors: true, depthTest: false }));
  points.renderOrder = 10;
  scene.add(points);
}

/** The handle: on the piece's joint (whole piece), or the middle of the corners picked; none while playing. */
function placeHandle(): void {
  gizmo.detach();
  if (playing || !canEdit) return;
  if (mode === 'piece') {
    handle.position.copy(pivotOf(piece));
    gizmo.setMode(tool);
  } else {
    if (!selected.size) return;
    const cs = edit.corners(piece), at = pivotOf(piece), mid = new THREE.Vector3();
    for (const i of selected) mid.add(cs[i]!.at);
    handle.position.copy(mid.divideScalar(selected.size).add(at));
    gizmo.setMode('translate');
  }
  handle.rotation.set(0, 0, 0);
  handle.scale.set(1, 1, 1);
  gizmo.attach(handle);
}

// --- Dragging the handle: each step from where the drag began (one change to undo).
let dragFrom: { mesh: FigureMesh; at: THREE.Vector3 } | null = null;
gizmo.addEventListener('dragging-changed', (e) => {
  const on = (e as unknown as { value: boolean }).value;
  orbit.enabled = !on;
  if (on) {
    dragFrom = { mesh: edit.snapshot(), at: handle.position.clone() };
    edit.beginDrag();
  } else {
    edit.endDrag();
    dragFrom = null;
    redraw();
  }
});
gizmo.addEventListener('objectChange', () => {
  if (!dragFrom) return;
  const mirror = $<HTMLInputElement>('mirror').checked;
  if (mode === 'corners') edit.moveCorners(piece, [...selected], handle.position.clone().sub(dragFrom.at), mirror, dragFrom.mesh);
  else {
    const m = new THREE.Matrix4().compose(handle.position.clone().sub(dragFrom.at), handle.quaternion, handle.scale);
    edit.transformPiece(piece, m, mirror, dragFrom.mesh);
  }
  // (The figure follows as it's dragged.)
  redrawFigureOnly();
});
/** Just the figure (during a drag: the handle's being held). */
function redrawFigureOnly(): void {
  if (figure) {
    scene.remove(figure.root);
    figure.dispose();
  }
  const look = { ...($<HTMLInputElement>('parts-coloured').checked ? COLOURED : PLAIN), figure: kind } as Avatar;
  figure = new PlayerFigure(look, fromMesh(edit.mesh));
  figure.tint(0.75);
  scene.add(figure.root);
  showCorners();
}

// --- Picking: a piece by clicking it; corners by clicking near them.
const ray = new THREE.Raycaster();
let downAt: { x: number; y: number } | null = null;
renderer.domElement.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4 || gizmo.dragging || !figure) return;
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (mode === 'corners' && adding) {
    // Adding a point: where the piece was clicked.
    const mesh = piece === 'hair' ? figure.joints.get('head')!.children.find((o) => o.name === 'hair') : figure.joints.get(piece)!.children.find((o) => o.name.endsWith(' part'));
    const hit = mesh ? ray.intersectObject(mesh, false)[0] : undefined;
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return status(`click a face of ${piece} to add a point there`, 'bad');
    const made = edit.addPoint(piece, hit.faceIndex, mesh!.worldToLocal(hit.point.clone()), $<HTMLInputElement>('mirror').checked);
    adding = false;
    selected.clear();
    if (made >= 0) selected.add(made);
    redraw();
    return;
  }
  if (mode === 'corners' && points) {
    // The nearest corner on screen within a few pixels.
    const cs = edit.corners(piece), at = pivotOf(piece);
    let best = -1, bestD = 12;
    cs.forEach((c, i) => {
      const s = c.at.clone().add(at).project(camera);
      const d = Math.hypot(((s.x + 1) / 2) * r.width - (e.clientX - r.left), ((1 - s.y) / 2) * r.height - (e.clientY - r.top));
      if (d < bestD) (bestD = d), (best = i);
    });
    if (best >= 0) {
      if (!e.shiftKey) selected.clear();
      if (selected.has(best) && e.shiftKey) selected.delete(best);
      else selected.add(best);
      showCorners();
      placeHandle();
      refresh();
      return;
    }
  }
  const hit = ray.intersectObject(figure.root, true).find((h) => h.object.name.endsWith(' part') || h.object.name === 'hair');
  if (hit) pick(hit.object.name === 'hair' ? 'hair' : (hit.object.name.replace(' part', '') as Piece));
});

function pick(p: Piece): void {
  if (p !== piece) selected.clear();
  piece = p;
  redraw();
}

// --- Seeing it move: the animation designer's clips.
let playing = false;
let playFrom = 0;
let animations: AnimationLibrary | null = null;
function posePreview(now: number): void {
  if (!figure) return;
  const clip = $<HTMLSelectElement>('clip').value as ClipId | '';
  if (!clip || !animations || !playing) {
    // (Editing: every joint straight, as the corners are kept.)
    figure.pose({ joints: {}, lean: 0, lift: 0 });
    return;
  }
  const c = animations.clips[clip], seconds = c.driver === 'time' ? (c.length ?? 1) : c.driver === 'stride' ? 1.1 : 1.2;
  const t = (((now - playFrom) / 1000 / seconds) % 1 + 1) % 1;
  figure.pose(poseClip(animations, clip, c.driver === 'still' ? 0 : t));
}
$('play').onclick = () => {
  if (!$<HTMLSelectElement>('clip').value) return;
  playing = !playing;
  playFrom = performance.now();
  redraw();
};
$<HTMLSelectElement>('clip').onchange = () => {
  if (!$<HTMLSelectElement>('clip').value) playing = false;
  redraw();
};
$<HTMLInputElement>('parts-coloured').onchange = () => redraw();

// --- Panels.
const pieceButtons = new Map<Piece, HTMLButtonElement>();
for (const p of PIECES) {
  const b = document.createElement('button');
  b.textContent = p;
  b.onclick = () => pick(p);
  pieceButtons.set(p, b);
  $('pieces').append(b);
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#modes button'))
  b.onclick = () => {
    mode = b.dataset.mode as typeof mode;
    redraw();
  };
for (const b of document.querySelectorAll<HTMLButtonElement>('#tools button'))
  b.onclick = () => {
    tool = b.dataset.tool as typeof tool;
    placeHandle();
    refresh();
  };
$('select-all').onclick = () => {
  edit.corners(piece).forEach((_, i) => selected.add(i));
  showCorners();
  placeHandle();
  refresh();
};
$('select-none').onclick = () => {
  selected.clear();
  showCorners();
  placeHandle();
  refresh();
};
$('select-shape').onclick = () => {
  for (const c of edit.shapeOf(piece, [...selected])) selected.add(c);
  showCorners();
  placeHandle();
  refresh();
};
$('delete').onclick = () => {
  if (!canEdit || !selected.size) return;
  const gone = edit.deleteCorners(piece, [...selected], $<HTMLInputElement>('mirror').checked);
  selected.clear();
  redraw();
  status(gone ? `took away ${gone} triangle${gone === 1 ? '' : 's'}` : 'nothing taken away: pick all of a shape (S), or all three corners of a triangle', gone ? '' : 'bad');
};
/** Adding a point: the next click on the piece puts one there. */
let adding = false;
$('split-edge').onclick = () => {
  const [a, b] = [...selected];
  if (selected.size !== 2 || a === undefined || b === undefined) return status('pick two corners with an edge between them', 'bad');
  const made = edit.splitEdge(piece, a, b, $<HTMLInputElement>('mirror').checked);
  if (made < 0) return status("those two have no edge between them: pick two of a triangle's corners", 'bad');
  selected.clear();
  selected.add(made);
  redraw();
};
$('add-point').onclick = () => {
  adding = !adding;
  refresh();
  if (adding) status(`click a face of ${piece}: a corner there`);
};
$('subdivide').onclick = () => {
  const n = edit.subdivide(piece, [...selected], $<HTMLInputElement>('mirror').checked);
  if (!n) return status("pick all three corners of a triangle (or a whole shape: S) to subdivide it", 'bad');
  // (Picked: what was, and what's new among it.)
  const cs = edit.corners(piece);
  selected.clear();
  redraw();
  status(`${n} triangle${n === 1 ? '' : 's'} in four (${cs.length} corners now)`);
};
$('undo').onclick = () => edit.undo() && redraw();
$('redo').onclick = () => edit.redo() && redraw();

function refresh(): void {
  for (const [p, b] of pieceButtons) b.classList.toggle('on', p === piece);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#modes button')) b.classList.toggle('on', b.dataset.mode === mode);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tools button')) b.classList.toggle('on', b.dataset.tool === tool);
  $('tools').hidden = mode !== 'piece';
  $('corner-tools').hidden = mode !== 'corners';
  $('add-tools').hidden = mode !== 'corners';
  $('add-point').classList.toggle('on', adding);
  $<HTMLButtonElement>('split-edge').disabled = !canEdit || selected.size !== 2;
  $<HTMLButtonElement>('add-point').disabled = !canEdit;
  $<HTMLButtonElement>('subdivide').disabled = !canEdit || selected.size < 3;
  const other = mirrorOf(piece);
  $('piece-about').textContent =
    mode === 'piece'
      ? `${piece}: ${tool === 'translate' ? 'moved, everything below it with it' : tool === 'rotate' ? 'turned about its joint, the joints below following' : 'scaled about its joint, the joints below following'}${other !== piece ? ` (and ${other}, mirrored)` : ''}`
      : `${piece}: ${edit.corners(piece).length} corners, ${selected.size} picked`;
  $<HTMLButtonElement>('undo').disabled = !canEdit || !edit.canUndo;
  $<HTMLButtonElement>('redo').disabled = !canEdit || !edit.canRedo;
  $<HTMLButtonElement>('delete').disabled = !canEdit || !selected.size;
  $<HTMLButtonElement>('select-shape').disabled = !selected.size;
  const dirty = JSON.stringify(edit.mesh) !== savedJson;
  $<HTMLButtonElement>('save').disabled = !canEdit || !dirty;
  $<HTMLButtonElement>('revert').disabled = !dirty;
  $<HTMLButtonElement>('made').disabled = !canEdit || !library.figures[kind];
  $('play').textContent = playing ? '❚❚ Pause' : '▶ Play';
  status(dirty ? 'changed (not saved)' : library.figures[kind] ? 'as edited (saved)' : 'as made', dirty ? '' : 'good');
}

/** The figure to edit: as saved, else as the game makes it now (the woman from the man as he is). */
function open(k: FigureKind): void {
  kind = k;
  const mesh = library.figures[k] ?? toMesh(modelOf(k));
  edit = new FigureEdit(mesh);
  savedJson = JSON.stringify(edit.mesh);
  selected.clear();
  redraw();
}
$<HTMLSelectElement>('kind').onchange = () => {
  if (JSON.stringify(edit.mesh) !== savedJson && !confirm('Leave this figure without saving?')) {
    $<HTMLSelectElement>('kind').value = kind;
    return;
  }
  open($<HTMLSelectElement>('kind').value as FigureKind);
};

async function put(next: MeshLibrary, done: string): Promise<void> {
  const res = await fetch('/api/meshes', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) });
  const body = (await res.json().catch(() => ({}))) as { library?: MeshLibrary; error?: string };
  if (!res.ok || !body.library) return status(`not saved: ${body.error ?? res.status}`, 'bad');
  library = body.library;
  setMeshes(library);
  open(kind);
  status(done, 'good');
}
$('save').onclick = () => void put({ figures: { ...library.figures, [kind]: edit.snapshot() } }, `saved: everyone's ${kind} from now on`);
$('revert').onclick = () => open(kind);
$('made').onclick = () => {
  const { [kind]: _gone, ...rest } = library.figures;
  void _gone;
  void put({ figures: rest }, `the ${kind} as the game makes ${kind === 'woman' ? 'her' : 'him'}, for everyone`);
};

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
  if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') {
    e.preventDefault();
    $(e.shiftKey ? 'redo' : 'undo').click();
  } else if (e.code === 'KeyW' || e.code === 'KeyE' || e.code === 'KeyR') {
    tool = e.code === 'KeyW' ? 'translate' : e.code === 'KeyE' ? 'rotate' : 'scale';
    placeHandle();
    refresh();
  } else if (e.code === 'KeyP' || e.code === 'KeyC') {
    mode = e.code === 'KeyP' ? 'piece' : 'corners';
    redraw();
  } else if (e.code === 'KeyA' && mode === 'corners') $('select-all').click();
  else if (e.code === 'KeyS' && mode === 'corners') $('select-shape').click();
  else if (e.code === 'KeyX' && mode === 'corners') $('split-edge').click();
  else if (e.code === 'KeyF' && mode === 'corners') $('add-point').click();
  else if (e.code === 'KeyD' && mode === 'corners') $('subdivide').click();
  else if ((e.code === 'Delete' || e.code === 'Backspace') && mode === 'corners') {
    e.preventDefault();
    $('delete').click();
  }
  else if (e.code === 'Escape') $('select-none').click();
  else if (e.code === 'Space') {
    e.preventDefault();
    $('play').click();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (JSON.stringify(edit.mesh) !== savedJson) e.preventDefault();
});

const frame = (now: number) => {
  if (playing) posePreview(now);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
};

// --- Opening.
for (const id of CLIP_IDS) $<HTMLSelectElement>('clip').append(new Option(id, id));
void (async () => {
  try {
    const [m, a] = await Promise.all([fetch('/api/meshes'), fetch('/api/animations')]);
    const mb = (await m.json()) as { library: MeshLibrary; canEdit: boolean };
    library = mb.library;
    canEdit = mb.canEdit;
    setMeshes(library);
    animations = ((await a.json()) as { library: AnimationLibrary }).library;
    setAnimations(animations);
  } catch {
    status("couldn't load the figures (as made, shown)", 'bad');
  }
  $('readonly').hidden = canEdit;
  resize();
  open('man');
  requestAnimationFrame(frame);
})();
