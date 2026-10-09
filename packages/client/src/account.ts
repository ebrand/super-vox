import './header.js';
import './fullscreen.js';
import './envBadge.js';
import * as THREE from 'three';
import { AVATAR_PARTS, defaultAvatar, type Avatar, type AvatarPart, type FigureKind } from '@super-vox/shared';
import { PlayerFigure, poseFor, type FigureState } from './playerFigure.js';
import { pickSpawn } from './spawnPicker.js';

/**
 * Your account (signed in): the name you go by, how you look (a colour for each part, seen on a
 * turning figure), and where you start in each world (unless an admin has locked it). See the
 * server's /api/account.
 */

interface AccountView {
  email: string;
  googleName: string;
  displayName: string | null;
  name: string;
  avatar: Avatar;
  chosenAvatar: boolean;
  spawns: { world: string; x: number; z: number; locked: boolean }[];
}

const PART_NAMES: Record<AvatarPart, string> = { skin: 'Skin', hair: 'Hair', shirt: 'Shirt', trousers: 'Trousers', shoes: 'Shoes' };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const status = (text: string, kind: '' | 'good' | 'bad' = '') => {
  statusEl.textContent = text;
  statusEl.className = kind;
};
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') => {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : null });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data as T;
}

let account: AccountView | null = null;
let worlds: string[] = [];
/** The look being chosen (shown on the figure; saved with Save look). */
let look: Avatar = defaultAvatar('');

// --- The figure, turning slowly, standing.
const canvas = $<HTMLCanvasElement>('preview');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setClearColor(0x0b0d10);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 220 / 300, 0.1, 50);
camera.position.set(0, 1.05, 4.6);
camera.lookAt(0, 0.92, 0);
const figure = new PlayerFigure(look);
scene.add(figure.root);
const standing: FigureState = { time: 0, stride: 0, speed: 0, airborne: false, swimming: false, flying: false, mining: false, swing: null, draw: null, pitch: 0 };
const frame = (t: number) => {
  // (Sized as it's shown: nothing, till its section is.)
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w && h && (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio()))) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  figure.root.rotation.y = Math.PI + t / 2600;
  figure.pose(poseFor({ ...standing, time: t / 1000 }));
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
const showLook = (l: Avatar) => {
  look = l;
  figure.setLook(l);
  figure.tint(1);
  for (const p of AVATAR_PARTS) {
    const input = $<HTMLInputElement>(`part-${p}`);
    if (input.value !== l[p]) input.value = l[p];
  }
  $<HTMLSelectElement>('figure').value = l.figure;
};
{
  // The figure: a man or a woman.
  const label = el('label'), select = el('select');
  select.id = 'figure';
  for (const [k, name] of [['man', 'Man'], ['woman', 'Woman']] as const) select.append(new Option(name, k));
  select.onchange = () => showLook({ ...look, figure: select.value as FigureKind });
  label.append(el('span', 'Figure'), select);
  $('parts').append(label);
}
for (const p of AVATAR_PARTS) {
  const label = el('label');
  const input = el('input');
  input.type = 'color';
  input.id = `part-${p}`;
  input.oninput = () => showLook({ ...look, [p]: input.value });
  label.append(el('span', PART_NAMES[p]), input);
  $('parts').append(label);
}

/** Shows the account as the server has it. */
function show(a: AccountView): void {
  account = a;
  for (const s of document.querySelectorAll<HTMLElement>('.mine')) s.hidden = false;
  $('email').textContent = a.email;
  const name = $<HTMLInputElement>('name');
  name.value = a.displayName ?? '';
  name.placeholder = a.googleName;
  const google = $<HTMLButtonElement>('name-google');
  google.textContent = `Use my Google name (${a.googleName})`;
  google.disabled = a.displayName === null;
  showLook(a.avatar);
  $<HTMLButtonElement>('look-default').disabled = !a.chosenAvatar;
  // Spawn points: each world, theirs there or the world's own.
  const table = $('spawns');
  table.replaceChildren();
  const head = el('tr');
  for (const h of ['World', 'You start', '', '']) head.append(el('th', h));
  table.append(head);
  for (const world of worlds) {
    const mine = a.spawns.find((s) => s.world === world);
    const tr = el('tr');
    const where = el('td', mine ? `at ${Math.round(mine.x)}, ${Math.round(mine.z)}` : "at the world's own spawn point", mine ? '' : 'dim');
    if (mine?.locked) where.append(el('span', 'set by an admin', 'badge'));
    const set = el('button', mine ? 'Move…' : 'Set…');
    set.disabled = !!mine?.locked;
    set.onclick = async () => {
      const picked = await pickSpawn('you', [world], mine ? [{ world, x: mine.x, z: mine.z }] : []);
      if (picked) void act(() => api<AccountView>('PUT', '/api/account/spawns', picked), `you start in ${picked.world} at ${picked.x}, ${picked.z}`);
    };
    const clear = el('button', 'Clear');
    clear.disabled = !mine || mine.locked;
    clear.title = "back to the world's own spawn point";
    clear.onclick = () => void act(() => api<AccountView>('DELETE', `/api/account/spawns/${encodeURIComponent(world)}`), `you start at the world's own spawn point in ${world}`);
    const tdSet = el('td'), tdClear = el('td');
    tdSet.append(set);
    tdClear.append(clear);
    tr.append(el('td', world), where, tdSet, tdClear);
    table.append(tr);
  }
}

async function act(f: () => Promise<AccountView>, done: string): Promise<void> {
  try {
    show(await f());
    status(done, 'good');
  } catch (err) {
    status((err as Error).message, 'bad');
  }
}

$<HTMLFormElement>('name-form').onsubmit = (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>('name').value;
  void act(() => api<AccountView>('PATCH', '/api/account', { displayName: name.trim() === '' ? null : name }), 'name saved: shown to anyone playing now');
};
$('name-google').onclick = () => void act(() => api<AccountView>('PATCH', '/api/account', { displayName: null }), 'you go by your Google name again');
$('look-save').onclick = () => void act(() => api<AccountView>('PATCH', '/api/account', { avatar: look }), 'look saved: shown to anyone playing now');
$('look-default').onclick = () => void act(() => api<AccountView>('PATCH', '/api/account', { avatar: null }), "back to your name's colours");

void (async () => {
  try {
    worlds = (await api<{ worlds: { name: string }[] }>('GET', '/api/worlds')).worlds.map((w) => w.name);
  } catch {
    // (No worlds listed: no spawn points to set.)
  }
  try {
    const a = await api<AccountView>('GET', '/api/account');
    show(a);
    status(`signed in as ${a.name}`);
  } catch (err) {
    $('denied').hidden = false;
    $('denied').textContent = (err as Error).message;
    status('');
  }
})();
