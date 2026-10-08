import './header.js';
import './fullscreen.js';
import './envBadge.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import {
  ARROW,
  CLIP_IDS,
  FIGURE_JOINTS,
  Item,
  Material,
  clipSeconds,
  gripKind,
  itemName,
  poseFigure,
  type AnimationLibrary,
  type AnimSettings,
  type ClipId,
  type FigureJoint,
  type FigureState,
  type Grip,
  type GripKind,
} from '@super-vox/shared';
import { AnimEditor, nearestTurn } from './animEditor.js';
import { PlayerFigure } from './playerFigure.js';
import { heldModel } from './entities.js';
import { isCubeModel } from './itemModels.js';

/**
 * The animation designer: how players' figures move (see shared animations.ts), edited. Pick a clip;
 * pick a joint (click the figure, or the list) and turn it at the playhead with the handle or the
 * sliders (its key there changes, or a new one's made); move keys along the timeline. "As in game"
 * shows it as players will see it (blended by speed, looking about, digging or drawing a bow).
 * Speeds and grips too. Admins save it (one library for every world); others can look.
 */

const $ = (id: string) => document.getElementById(id)!;
const input = (id: string) => $(id) as HTMLInputElement;
const DEG = 180 / Math.PI;

const editor = new AnimEditor();
let canEdit = false;
let mode: 'edit' | 'game' = 'edit';
let gizmoFor: 'joint' | 'grip' = 'joint';
let playing = false;
/** The game preview's clock and stride. */
let gameTime = 0, gameStride = 0;

const CLIP_ABOUT: Record<ClipId, string> = {
  idle: 'Standing still (a pose).',
  walk: 'Walking: one stride (two steps), by how far they go.',
  run: 'Running: one stride, by how far they go (blended in from the run speeds).',
  swim: 'Swimming: a loop.',
  fly: 'Flying (a pose; it leans more the faster it goes: see Speeds).',
  jump: 'In the air: jumping or falling (a pose).',
  breathe: 'Breathing: a loop, added to every other pose.',
  dig: 'Digging and swings: one swing, over the arm and body only (played over and over while mining).',
  bow: 'Drawing a bow: from just raised (0) to fully drawn (1), over the arms, body and head.',
};
const DRIVER_LABEL: Record<string, [string, string]> = {
  time: ['0 s', 'loop'],
  stride: ['start of stride', 'a stride on'],
  draw: ['raised', 'fully drawn'],
  swing: ['start of swing', 'swung'],
  still: ['', ''],
};
const SETTINGS: { key: keyof AnimSettings; name: string; min: number; max: number; step: number; unit: string }[] = [
  { key: 'walkFull', name: 'Full walk at', min: 0.2, max: 5, step: 0.1, unit: 'm/s' },
  { key: 'runFrom', name: 'Run from', min: 1, max: 12, step: 0.1, unit: 'm/s' },
  { key: 'runTo', name: 'Full run at', min: 1, max: 15, step: 0.1, unit: 'm/s' },
  { key: 'walkStride', name: 'Walk stride', min: 0.4, max: 4, step: 0.05, unit: 'm' },
  { key: 'runStride', name: 'Run stride', min: 0.4, max: 6, step: 0.05, unit: 'm' },
  { key: 'digSeconds', name: 'Dig swing', min: 0.1, max: 2, step: 0.01, unit: 's' },
  { key: 'flyLean', name: 'Fly lean', min: 0, max: 0.3, step: 0.005, unit: 'rad per m/s' },
  { key: 'flyLeanMax', name: 'Fly lean max', min: 0, max: 1.5, step: 0.05, unit: 'rad' },
];
const ITEMS: (number | null)[] = [null, Material.Stone, Item.WoodenPickaxe, Item.StoneSword, Item.Bow, Item.CookedPork];

// --- The view ---
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
view.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1f26);
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
camera.position.set(2.2, 1.6, -3.2); // (in front: the figure faces -z)
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 0.95, 0);
orbit.update();
const grid = new THREE.GridHelper(6, 24, 0x3a414b, 0x262c34);
scene.add(grid);
const figure = new PlayerFigure(0xc9b3b3);
scene.add(figure.root);
const heldMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
let held: THREE.Group | null = null;
let heldKey = '';
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSpace('local');
gizmo.setSize(0.7);
scene.add(gizmo.getHelper());
gizmo.addEventListener('dragging-changed', (e) => (orbit.enabled = !(e as unknown as { value: boolean }).value));

function resize(): void {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(view);

// --- Picking a joint: a click (not a drag) on the figure ---
let downAt: { x: number; y: number } | null = null;
renderer.domElement.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4 || gizmo.dragging) return;
  const r = renderer.domElement.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObject(figure.root, true).find((h) => h.object.name.endsWith(' part'));
  if (hit) pickJoint(hit.object.name.replace(' part', '') as FigureJoint);
});

function pickJoint(j: FigureJoint): void {
  editor.joint = j;
  setGizmo('joint');
  refresh();
}

function setGizmo(to: 'joint' | 'grip'): void {
  // (What's held: moved at first; T turns it.)
  if (to === 'grip' && gizmoFor !== 'grip') gizmo.setMode('translate');
  gizmoFor = to;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#gizmo button')) b.classList.toggle('on', b.dataset.gizmo === to);
  attachGizmo();
}

function attachGizmo(): void {
  gizmo.detach();
  if (!canEdit) return;
  if (gizmoFor === 'grip' && held) {
    gizmo.attach(held);
  } else if (gizmoFor === 'joint' && mode === 'edit' && editor.joint) {
    gizmo.setMode('rotate');
    gizmo.attach(figure.joints.get(editor.joint)!);
  }
}

gizmo.addEventListener('objectChange', () => {
  const o = gizmo.object;
  if (!o) return;
  if (gizmoFor === 'joint' && editor.joint) {
    const r = new THREE.Euler().setFromQuaternion(o.quaternion, 'YXZ');
    // (As near as can be to how it was, so it doesn't flip round past 90°.)
    editor.setTurn(editor.joint, nearestTurn([r.x, r.y, r.z], editor.turnAt(editor.joint)?.turn ?? [0, 0, 0]));
  } else if (gizmoFor === 'grip') {
    const kind = gripOf(currentItem());
    if (!kind) return;
    const g = editor.draft.grips[kind];
    const r = new THREE.Euler().setFromQuaternion(o.quaternion, 'XYZ');
    editor.setGrip(kind, { ...g, at: [o.position.x, o.position.y, o.position.z], turn: [r.x, r.y, r.z] });
  }
  refresh(false);
});

// --- What's held (a preview) ---
const itemSelect = $('g-item') as HTMLSelectElement;
for (const item of ITEMS) itemSelect.append(new Option(item === null ? 'nothing' : itemName(item), item === null ? '' : String(item)));
const currentItem = () => (itemSelect.value === '' ? null : Number(itemSelect.value));
const gripOf = (item: number | null): GripKind | null => (item === null ? null : gripKind(item === Item.Bow, isCubeModel(item)));

/** Puts what's chosen in the hand its grip says (again when the grip changes). */
function placeHeld(): void {
  const item = currentItem(), kind = gripOf(item);
  const key = JSON.stringify([item, kind && editor.draft.grips[kind]]);
  if (key === heldKey) return;
  heldKey = key;
  const wasGrip = gizmo.object === held;
  held?.removeFromParent();
  held = null;
  if (item === null || !kind) {
    if (wasGrip) gizmo.detach();
    return;
  }
  const grip: Grip = editor.draft.grips[kind];
  held = heldModel(item, heldMaterial, grip);
  figure.hand(grip.hand).add(held);
  if (wasGrip || gizmoFor === 'grip') attachGizmo();
}

// --- The panels ---
function renderClips(): void {
  const ul = $('clips');
  ul.replaceChildren();
  for (const id of CLIP_IDS) {
    const li = document.createElement('li');
    li.className = id === editor.clip ? 'current' : '';
    const c = editor.draft.clips[id];
    li.innerHTML = `<span>${id}</span><span class="sub">${c.driver}</span>`;
    li.onclick = () => {
      editor.clip = id;
      editor.t = 0;
      refresh();
    };
    ul.append(li);
  }
}

const settingInputs = new Map<keyof AnimSettings, { range: HTMLInputElement; box: HTMLInputElement }>();
for (const s of SETTINGS) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label title="${s.unit}">${s.name}</label><input type="range" min="${s.min}" max="${s.max}" step="${s.step}"><input type="number" min="${s.min}" max="${s.max}" step="${s.step}"><span class="note">${s.unit}</span>`;
  const [range, box] = row.querySelectorAll('input') as unknown as [HTMLInputElement, HTMLInputElement];
  const set = (v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    editor.setSetting(s.key, n);
    refresh(false);
  };
  range.oninput = () => set(range.value);
  box.onchange = () => set(box.value);
  settingInputs.set(s.key, { range, box });
  $('settings').append(row);
}

const jointButtons = new Map<FigureJoint, HTMLButtonElement>();
for (const j of FIGURE_JOINTS) {
  const b = document.createElement('button');
  b.textContent = j;
  b.onclick = () => pickJoint(j);
  jointButtons.set(j, b);
  $('joints').append(b);
}

/** A slider and its box, in step: `get` shows, `set` takes (when either's changed by hand). */
function pair(id: string, set: (v: number) => void): (v: number) => void {
  const range = input(`${id}-range`), box = input(id);
  range.oninput = () => {
    box.value = range.value;
    set(Number(range.value));
  };
  box.onchange = () => {
    if (box.value === '' || !Number.isFinite(Number(box.value))) return;
    range.value = box.value;
    set(Number(box.value));
  };
  return (v: number) => {
    if (document.activeElement !== box) box.value = String(Math.round(v * 100) / 100);
    if (document.activeElement !== range) range.value = String(v);
  };
}

const showTurn = ([0, 1, 2] as const).map((k) =>
  pair(['rx', 'ry', 'rz'][k]!, (deg) => {
    if (!editor.joint) return;
    const now = editor.turnAt(editor.joint)?.turn ?? [0, 0, 0];
    now[k] = deg / DEG;
    editor.setTurn(editor.joint, now);
    refresh(false);
  }),
);
input('aim').onchange = () => {
  if (!editor.joint) return;
  const now = editor.turnAt(editor.joint)?.turn ?? [0, 0, 0];
  editor.setTurn(editor.joint, now, Number(input('aim').value) || 0);
  refresh(false);
};
const showLean = pair('lean', (deg) => {
  editor.setBody(deg / DEG, editor.bodyAt().lift);
  refresh(false);
});
const showLift = pair('lift', (cm) => {
  editor.setBody(editor.bodyAt().lean, cm / 100);
  refresh(false);
});
const game = { speed: 1.4, pitch: 0, draw: 1 };
const showSpeed = pair('g-speed', (v) => (game.speed = v));
const showPitch = pair('g-pitch', (v) => (game.pitch = v / DEG));
const showDraw = pair('g-draw', (v) => (game.draw = v));

// Clip settings.
input('length').onchange = () => {
  const v = Number(input('length').value);
  if (v > 0) editor.setClip({ length: v });
  refresh(false);
};
input('smooth').onchange = () => {
  editor.setClip({ smooth: input('smooth').checked });
  refresh(false);
};
for (const id of ['look-head', 'look-chest', 'look-level']) {
  input(id).onchange = () => {
    editor.setClip({ look: { head: Number(input('look-head').value) || 0, chest: Number(input('look-chest').value) || 0, level: input('look-level').checked } });
    refresh(false);
  };
}
$('reset-clip').onclick = () => {
  editor.resetClip();
  refresh();
};

// Grips.
const gripKindSelect = $('grip-kind') as HTMLSelectElement;
gripKindSelect.onchange = () => {
  // (Shows something of that kind in the hand, to see it.)
  const kind = gripKindSelect.value as GripKind;
  if (gripOf(currentItem()) !== kind) itemSelect.value = String(kind === 'bow' ? Item.Bow : kind === 'block' ? Material.Stone : Item.WoodenPickaxe);
  refresh(false);
};
for (const id of ['grip-hand', 'grip-x', 'grip-y', 'grip-z', 'grip-rx', 'grip-ry', 'grip-rz', 'grip-scale']) {
  ($(id) as HTMLInputElement).onchange = () => {
    const kind = gripKindSelect.value as GripKind, n = (i: string) => Number(input(i).value) || 0;
    editor.setGrip(kind, {
      hand: ($('grip-hand') as HTMLSelectElement).value as 'left' | 'right',
      at: [n('grip-x') / 100, n('grip-y') / 100, n('grip-z') / 100],
      turn: [n('grip-rx') / DEG, n('grip-ry') / DEG, n('grip-rz') / DEG],
      scale: Math.max(0.01, n('grip-scale')),
    });
    refresh(false);
  };
}

/** Shows the draft: panels, timeline, buttons. `all`: the clip or joint changed (lists too). */
function refresh(all = true): void {
  const c = editor.current, j = editor.joint;
  if (all) renderClips();
  $('clip-about').textContent = CLIP_ABOUT[editor.clip];
  ($('length-row') as HTMLElement).hidden = c.driver !== 'time';
  if (document.activeElement !== input('length')) input('length').value = String(Math.round((c.length ?? 1) * 100) / 100);
  input('smooth').checked = c.smooth;
  ($('look-rows') as HTMLElement).hidden = !c.look;
  if (c.look) {
    input('look-head').value = String(c.look.head);
    input('look-chest').value = String(c.look.chest);
    input('look-level').checked = c.look.level;
  }
  for (const s of SETTINGS) {
    const v = editor.draft.settings[s.key], el = settingInputs.get(s.key)!;
    if (document.activeElement !== el.box) el.box.value = String(v);
    if (document.activeElement !== el.range) el.range.value = String(v);
  }
  // The joint.
  for (const [name, b] of jointButtons) {
    b.classList.toggle('on', name === j);
    b.classList.toggle('moved', !!c.joints[name]?.length);
  }
  const t = j ? editor.turnAt(j) : null;
  $('joint-about').textContent = !j ? 'Pick a joint.' : t ? `${j}: ${editor.keyHere(j) || c.driver === 'still' ? 'on its key' : 'between keys (a change makes a key here)'}` : `${j}: this clip doesn't move it (a change gives it a key here)`;
  const turn = t?.turn ?? [0, 0, 0];
  showTurn.forEach((show, k) => show(turn[k]! * DEG));
  if (document.activeElement !== input('aim')) input('aim').value = String(Math.round((t?.aim ?? 0) * 100) / 100);
  const body = editor.bodyAt();
  showLean(body.lean * DEG);
  showLift(body.lift * 100);
  // Grips.
  const kind = gripKindSelect.value as GripKind, g = editor.draft.grips[kind];
  ($('grip-hand') as HTMLSelectElement).value = g.hand;
  const show = (id: string, v: number) => document.activeElement !== input(id) && (input(id).value = String(Math.round(v * 100) / 100));
  show('grip-x', g.at[0] * 100);
  show('grip-y', g.at[1] * 100);
  show('grip-z', g.at[2] * 100);
  show('grip-rx', g.turn[0] * DEG);
  show('grip-ry', g.turn[1] * DEG);
  show('grip-rz', g.turn[2] * DEG);
  show('grip-scale', g.scale);
  showSpeed(game.speed);
  showPitch(game.pitch * DEG);
  showDraw(game.draw);
  ($('g-draw-row') as HTMLElement).hidden = ($('g-action') as HTMLSelectElement).value !== 'bow';
  renderTimeline();
  // Editing: only for admins, and only what can be.
  const problem = editor.problem();
  ($('save') as HTMLButtonElement).disabled = !canEdit || !editor.dirty || !!problem;
  ($('revert') as HTMLButtonElement).disabled = !editor.dirty;
  for (const id of ['add-key', 'delete-key']) ($(id) as HTMLButtonElement).disabled = !canEdit || !j || mode !== 'edit';
  ($('delete-key') as HTMLButtonElement).disabled ||= !(j && editor.keyHere(j));
  status(problem ? `won't save: ${problem}` : editor.dirty ? 'changed (not saved)' : canEdit ? 'saved' : 'looking only', problem ? 'bad' : editor.dirty ? '' : 'good');
  placeHeld();
  if (all) attachGizmo();
}

// --- The timeline ---
const timeline = $('timeline');
function renderTimeline(): void {
  const c = editor.current;
  for (const el of [...timeline.querySelectorAll('.tick, .key')]) el.remove();
  for (let i = 1; i < 10; i++) {
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.left = `${i * 10}%`;
    timeline.append(tick);
  }
  const mine = new Set(editor.joint ? editor.keysOf(editor.joint) : []);
  for (const at of editor.allKeys()) {
    if (mine.has(at)) continue;
    const k = document.createElement('div');
    k.className = 'key';
    k.style.left = `${at * 100}%`;
    timeline.append(k);
  }
  for (const at of mine) {
    const k = document.createElement('div');
    k.className = 'key mine';
    k.style.left = `${at * 100}%`;
    k.title = `${editor.joint}'s key at ${Math.round(at * 100)}% (drag to move it)`;
    k.dataset.at = String(at);
    timeline.append(k);
  }
  $('head').style.left = `${editor.t * 100}%`;
  const [start, end] = DRIVER_LABEL[c.driver] ?? ['', ''];
  $('tl-start').textContent = start;
  $('tl-end').textContent = c.driver === 'time' ? `${Math.round((c.length ?? 1) * 100) / 100} s` : end;
  $('tl-at').textContent = c.driver === 'still' ? 'a pose: one key' : c.driver === 'time' ? `${(editor.t * (c.length ?? 1)).toFixed(2)} s` : `${Math.round(editor.t * 100)}%`;
}

/** Where along the timeline a pointer is (0..1). */
const along = (e: PointerEvent) => {
  const r = timeline.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
};
let dragKey: number | null = null;
timeline.addEventListener('pointerdown', (e) => {
  timeline.setPointerCapture(e.pointerId);
  const target = e.target as HTMLElement;
  // A joint's key: dragged to move it (admins); anywhere else: the playhead.
  dragKey = canEdit && target.classList.contains('mine') ? Number(target.dataset.at) : null;
  if (dragKey === null) {
    editor.t = snap(along(e));
    playing = false;
    refreshPlay();
    refresh(false);
  }
});
timeline.addEventListener('pointermove', (e) => {
  if (!timeline.hasPointerCapture(e.pointerId)) return;
  if (dragKey !== null && editor.joint) {
    const to = snap(along(e));
    if (editor.moveKey(editor.joint, dragKey, to)) {
      dragKey = to;
      editor.t = to;
    }
  } else editor.t = snap(along(e));
  refresh(false);
});
timeline.addEventListener('pointerup', () => (dragKey = null));
/** To the nearest 1% (a still pose: always 0). */
const snap = (t: number) => (editor.current.driver === 'still' ? 0 : Math.round(t * 100) / 100);

// --- Keys and buttons ---
function stepKey(dir: 1 | -1): void {
  const keys = editor.joint ? editor.keysOf(editor.joint) : editor.allKeys();
  const next = dir > 0 ? keys.find((k) => k > editor.t + 1e-6) : [...keys].reverse().find((k) => k < editor.t - 1e-6);
  if (next !== undefined) editor.t = next;
  refresh(false);
}
$('prev-key').onclick = () => stepKey(-1);
$('next-key').onclick = () => stepKey(1);
$('add-key').onclick = () => {
  if (!editor.joint) return;
  editor.setTurn(editor.joint, editor.turnAt(editor.joint)?.turn ?? [0, 0, 0]);
  refresh(false);
};
$('delete-key').onclick = () => {
  if (editor.joint && editor.deleteKey(editor.joint)) refresh(false);
};

function refreshPlay(): void {
  $('play').textContent = playing ? '❚❚ Pause' : '▶ Play';
}
$('play').onclick = () => {
  playing = !playing;
  refreshPlay();
};
for (const b of document.querySelectorAll<HTMLButtonElement>('#modes button')) {
  b.onclick = () => {
    mode = b.dataset.mode as 'edit' | 'game';
    for (const x of document.querySelectorAll<HTMLButtonElement>('#modes button')) x.classList.toggle('on', x === b);
    if (mode === 'game') playing = true;
    refreshPlay();
    refresh();
  };
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#gizmo button')) b.onclick = () => setGizmo(b.dataset.gizmo as 'joint' | 'grip');
($('g-action') as HTMLSelectElement).onchange = () => refresh(false);
itemSelect.onchange = () => {
  const kind = gripOf(currentItem());
  if (kind) gripKindSelect.value = kind;
  refresh(false);
};

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || e.metaKey || e.ctrlKey) return;
  if (e.code === 'Space') {
    e.preventDefault();
    playing = !playing;
    refreshPlay();
  } else if (e.code === 'ArrowLeft') stepKey(-1);
  else if (e.code === 'ArrowRight') stepKey(1);
  else if (e.code === 'KeyK') $('add-key').click();
  else if (e.code === 'Delete' || e.code === 'Backspace') $('delete-key').click();
  else if (e.code === 'KeyE') ($('modes').querySelector('[data-mode="edit"]') as HTMLButtonElement).click();
  else if (e.code === 'KeyV') ($('modes').querySelector('[data-mode="game"]') as HTMLButtonElement).click();
  else if (e.code === 'KeyR') setGizmo('joint');
  else if (e.code === 'KeyG') setGizmo('grip'); else if (e.code === 'KeyT' && gizmoFor === 'grip') gizmo.setMode(gizmo.mode === 'rotate' ? 'translate' : 'rotate');
});

// --- Saving ---
function status(text: string, kind: '' | 'bad' | 'good' = ''): void {
  const el = $('status');
  el.textContent = text;
  el.className = kind;
}
$('save').onclick = async () => {
  const res = await fetch('/api/animations', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(editor.draft) });
  const body = (await res.json()) as { library?: AnimationLibrary; error?: string };
  if (!res.ok || !body.library) return status(`not saved: ${body.error ?? res.status}`, 'bad');
  editor.load(body.library);
  refresh();
  status('saved: every player moves so now', 'good');
};
$('revert').onclick = () => {
  editor.revert();
  refresh();
};
$('defaults').onclick = async () => {
  if (!canEdit || !confirm('Every clip, speed and grip back to how it was at first, for everyone?')) return;
  const res = await fetch('/api/animations', { method: 'DELETE' });
  const body = (await res.json()) as { library?: AnimationLibrary; error?: string };
  if (!res.ok || !body.library) return status(`not reset: ${body.error ?? res.status}`, 'bad');
  editor.load(body.library);
  refresh();
  status('back to the defaults', 'good');
};
$('export').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(editor.draft, null, 1)], { type: 'application/json' }));
  a.download = 'animations.json';
  a.click();
  URL.revokeObjectURL(a.href);
};
$('import').onclick = () => input('import-file').click();
input('import-file').onchange = async () => {
  const f = input('import-file').files?.[0];
  if (!f) return;
  try {
    const why = editor.importDraft(JSON.parse(await f.text()));
    if (why) return status(`can't import: ${why}`, 'bad');
    refresh();
    status('imported: look it over, then save', '');
  } catch {
    status("can't import: not a JSON file", 'bad');
  } finally {
    input('import-file').value = '';
  }
};
window.addEventListener('beforeunload', (e) => {
  if (editor.dirty) e.preventDefault();
});

// --- Each frame ---
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000) * Number(($('rate') as HTMLSelectElement).value);
  last = now;
  if (mode === 'edit') {
    if (playing && editor.current.driver !== 'still') {
      editor.t = (editor.t + dt / clipSeconds(editor.draft, editor.clip, ARROW.drawMs / 1000)) % 1;
      renderTimeline();
    }
    if (!gizmo.dragging) figure.pose(editor.pose());
  } else {
    // As players will see it: moving as chosen, looking, doing, the time going on.
    if (playing) gameTime += dt;
    const set = editor.draft.settings, moveKind = ($('g-move') as HTMLSelectElement).value, action = ($('g-action') as HTMLSelectElement).value;
    if (playing) gameStride += (game.speed * dt * 2 * Math.PI) / (game.speed > set.runFrom ? set.runStride : set.walkStride);
    const s: FigureState = {
      time: gameTime,
      stride: gameStride,
      speed: game.speed,
      airborne: moveKind === 'air',
      swimming: moveKind === 'swim',
      flying: moveKind === 'fly',
      mining: action === 'dig',
      swing: null,
      draw: action === 'bow' ? game.draw : null,
      pitch: game.pitch,
    };
    figure.pose(poseFigure(editor.draft, s));
  }
  heldMaterial.color.setScalar(1);
  renderer.render(scene, camera);
});

// --- Opening ---
(async () => {
  try {
    const res = await fetch('/api/animations');
    const body = (await res.json()) as { library: AnimationLibrary; canEdit: boolean };
    editor.load(body.library);
    canEdit = body.canEdit;
    ($('readonly') as HTMLElement).hidden = canEdit;
    for (const id of ['defaults', 'import']) ($(id) as HTMLButtonElement).disabled = !canEdit;
  } catch {
    status("couldn't load the animations (the defaults are shown)", 'bad');
  }
  resize();
  refresh();
})();
