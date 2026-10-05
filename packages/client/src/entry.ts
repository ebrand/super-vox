import './header.js';
import './fullscreen.js';
import './envBadge.js';
import { decodeWorldMap, renderMap } from './worldMap.js';
import { loadSettings, saveSettings, workersFor } from './settings.js';
import { describeWorld, type WorldList, type WorldSummary } from './worldInfo.js';

/**
 * The landing page: who's signed in, the world chosen (its picture: its own if it has one, else
 * its map; and what it is), choosing another, and the way to world management, the object
 * designer, settings, and playing it.
 */

const worldEl = document.getElementById('world') as HTMLSelectElement;
const nameEl = document.getElementById('world-name')!;
const aboutEl = document.getElementById('about')!;
const playEl = document.getElementById('play') as HTMLButtonElement;
const summaryEl = document.getElementById('summary')!;
const statusEl = document.getElementById('status')!;
const pictureEl = document.getElementById('picture')!;
const pictureTools = document.getElementById('picture-tools')!;
const uploadEl = document.getElementById('picture-upload') as HTMLButtonElement;
const clearEl = document.getElementById('picture-clear') as HTMLButtonElement;
const fileEl = document.getElementById('picture-file') as HTMLInputElement;

let settings = loadSettings();
let worlds: WorldSummary[] = [];
let defaultWorld = '';
/** Whether this visitor may change worlds' pictures (an operator). */
let canPicture = false;

function status(text: string, kind: 'good' | 'bad' | '' = ''): void {
  statusEl.textContent = text;
  statusEl.className = kind;
}

const toleranceText = (t: number | null) => (t === null ? "world's own" : `${t}/16 m`);

function showSummary(): void {
  summaryEl.textContent = `Settings: detail ${settings.detail} chunks (${settings.detail * 16} m) · view ${settings.view} m · performance ${settings.performance} (${workersFor(settings.performance, navigator.hardwareConcurrency || 0)} mesh workers) · tolerance ${toleranceText(settings.tolerance)}`;
}

const chosen = () => worlds.find((x) => x.name === worldEl.value);

function showWorld(): void {
  const w = chosen();
  nameEl.textContent = w ? w.name + (w.name === defaultWorld ? ' (default)' : '') : '';
  aboutEl.textContent = w ? describeWorld(w) : '';
  void showPicture();
}

// ---- The world's picture

/** What's shown now ("world@pictureAt", or "world@map"), so a picture's drawn once, and the last to be asked for wins. */
let shown = '';
const maps = new Map<string, Promise<HTMLCanvasElement | null>>();

/** A world's map, drawn to a canvas (made once a visit). */
function mapCanvas(world: string): Promise<HTMLCanvasElement | null> {
  let p = maps.get(world);
  if (!p) {
    p = fetch(`/api/world/map?width=1024&world=${encodeURIComponent(world)}`)
      .then(async (r) => {
        if (!r.ok) return null;
        const map = decodeWorldMap(await r.arrayBuffer());
        const canvas = document.createElement('canvas');
        canvas.width = map.cols;
        canvas.height = map.rows;
        canvas.getContext('2d')!.putImageData(new ImageData(renderMap(map), map.cols, map.rows), 0, 0);
        canvas.setAttribute('aria-label', `map of ${world}`);
        return canvas;
      })
      .catch(() => null);
    maps.set(world, p);
  }
  return p;
}

function setPicture(...nodes: Node[]): void {
  for (const n of [...pictureEl.childNodes]) if (n !== pictureTools) n.remove();
  pictureEl.prepend(...nodes);
}

function emptyNote(text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'empty';
  span.textContent = text;
  return span;
}

async function showPicture(): Promise<void> {
  const w = chosen();
  pictureTools.hidden = !w || !canPicture;
  clearEl.hidden = !w?.pictureAt;
  if (!w) {
    shown = '';
    setPicture(emptyNote(worlds.length ? '' : 'no worlds yet'));
    return;
  }
  const key = `${w.name}@${w.pictureAt ?? 'map'}`;
  if (key === shown) return;
  shown = key;
  if (w.pictureAt) {
    const img = document.createElement('img');
    img.alt = `${w.name}`;
    img.src = `/api/worlds/${encodeURIComponent(w.name)}/picture?at=${w.pictureAt}`;
    // (Its map if the picture won't load.)
    img.addEventListener('error', () => {
      if (shown === key) void mapCanvas(w.name).then((c) => shown === key && setPicture(c ?? emptyNote('no picture')));
    });
    setPicture(img);
    return;
  }
  setPicture(emptyNote('drawing the map…'));
  const canvas = await mapCanvas(w.name);
  if (shown !== key) return;
  setPicture(canvas ?? emptyNote("couldn't draw its map"));
}

uploadEl.addEventListener('click', () => fileEl.click());
fileEl.addEventListener('change', async () => {
  const file = fileEl.files?.[0], w = chosen();
  fileEl.value = '';
  if (!file || !w) return;
  status(`Uploading ${file.name}…`);
  const res = await fetch(`/api/worlds/${encodeURIComponent(w.name)}/picture`, { method: 'PUT', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file }).catch(() => null);
  if (!res?.ok) {
    const why = res ? (((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`) : "couldn't reach the server";
    status(`Couldn't use that picture: ${why}.`, 'bad');
    return;
  }
  status(`${w.name} has its own picture now.`, 'good');
  await loadWorlds();
});
clearEl.addEventListener('click', async () => {
  const w = chosen();
  if (!w) return;
  const res = await fetch(`/api/worlds/${encodeURIComponent(w.name)}/picture`, { method: 'DELETE' }).catch(() => null);
  if (!res?.ok) {
    status(`Couldn't take its picture away (${res ? `HTTP ${res.status}` : 'no server'}).`, 'bad');
    return;
  }
  status(`${w.name} shows its map again.`, 'good');
  await loadWorlds();
});

// ---- Worlds

async function loadWorlds(): Promise<void> {
  try {
    const res = await fetch('/api/worlds');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as WorldList;
    worlds = data.worlds;
    defaultWorld = data.default;
    canPicture = !!data.canPicture;
  } catch (err) {
    worldEl.innerHTML = '<option>unavailable</option>';
    setPicture(emptyNote('no server'));
    status(`Couldn't reach the server (${(err as Error).message}). Is it running?`, 'bad');
    return;
  }
  const keep = worldEl.value;
  worldEl.innerHTML = '';
  for (const w of worlds) worldEl.appendChild(new Option(w.name + (w.mode ? ` · ${w.mode}` : '') + (w.name === defaultWorld ? ' (default)' : ''), w.name));
  if (worlds.length === 0) {
    worldEl.innerHTML = '<option>no worlds yet</option>';
    status('No worlds yet: make one in World management.');
    showWorld();
    return;
  }
  // The one shown before (reloading), the one picked last time if it still exists, else the server's default.
  const pick = [keep, settings.world, defaultWorld].find((n) => n && worlds.some((w) => w.name === n));
  if (pick) worldEl.value = pick;
  worldEl.disabled = false;
  playEl.disabled = false;
  showWorld();
}

worldEl.addEventListener('change', () => {
  settings = { ...settings, world: worldEl.value };
  saveSettings(settings);
  showWorld();
});

playEl.addEventListener('click', () => {
  settings = { ...settings, world: worldEl.value };
  saveSettings(settings);
  location.href = `/play.html?world=${encodeURIComponent(worldEl.value)}`;
});

showSummary();
void loadWorlds();

/** Who is signed in (the server says, from its session cookie); hidden on servers without sign-in. */
async function showAccount(): Promise<void> {
  const el = document.getElementById('account')!;
  let me: { signedIn: boolean; name?: string; email?: string; admin?: boolean };
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return; // no sign-in here
    me = (await res.json()) as typeof me;
  } catch {
    return;
  }
  el.hidden = false;
  el.replaceChildren();
  const who = document.createElement('span');
  who.className = 'who';
  if (me.signedIn) {
    who.append('Signed in as ');
    const b = document.createElement('b');
    b.textContent = me.name ?? '';
    who.append(b);
    if (me.admin) who.append(' (admin)');
    who.title = me.email ?? '';
    const out = document.createElement('button');
    out.type = 'button';
    out.textContent = 'Sign out';
    out.addEventListener('click', () => {
      void fetch('/api/auth/logout', { method: 'POST' }).then(() => (void showAccount(), loadWorlds()));
    });
    el.append(who, out);
  } else {
    who.textContent = 'Sign in to build; anyone can look around.';
    const signIn = document.createElement('a');
    signIn.className = 'button';
    signIn.href = '/api/auth/google?return=/';
    signIn.textContent = 'Sign in with Google';
    el.append(who, signIn);
  }
  const params = new URLSearchParams(location.search);
  if (params.get('signin') === 'cancelled') status('Sign-in cancelled.', 'bad');
}

void showAccount();
