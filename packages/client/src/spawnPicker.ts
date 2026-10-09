import { UNITS_PER_METER } from '@super-vox/shared';
import { decodeWorldMap, renderMap, type MapData } from './worldMap.js';

/**
 * Picking a player's spawn point (Players page): a world, and a spot on its map (clicked, or x and
 * z typed in metres, as the game's Info panel shows them). Says so if it's in the sea.
 */

/** The spot (metres, to the nearest metre) at (fx, fy) of the way across and down a map, and whether it's in the sea. */
export function pickOnMap(map: MapData, fx: number, fy: number): { x: number; z: number; sea: boolean } {
  const fxc = Math.max(0, Math.min(1, fx)), fyc = Math.max(0, Math.min(1, fy));
  const x = Math.round((fxc * map.cols * map.step) / UNITS_PER_METER), z = Math.round((fyc * map.rows * map.step) / UNITS_PER_METER);
  return { x, z, sea: inSea(map, x, z) };
}

/** Whether (x, z) (metres) is in the sea on the map. */
export function inSea(map: MapData, x: number, z: number): boolean {
  if (map.seaLevel === null) return false;
  const i = Math.max(0, Math.min(map.cols - 1, Math.floor((x * UNITS_PER_METER) / map.step)));
  const j = Math.max(0, Math.min(map.rows - 1, Math.floor((z * UNITS_PER_METER) / map.step)));
  return map.heights[i + map.cols * j]! < map.seaLevel;
}

/** Where (x, z) (metres) is on the map, as fractions across and down. */
export function onMap(map: MapData, x: number, z: number): { fx: number; fy: number } {
  return { fx: (x * UNITS_PER_METER) / (map.cols * map.step), fy: (z * UNITS_PER_METER) / (map.rows * map.step) };
}

export interface Picked {
  world: string;
  x: number;
  z: number;
}

/** The dialog's look (once, on whatever page shows it). */
const STYLE = `
      dialog.spawn-picker { background: var(--panel, #14181d); color: var(--text, #e6e6e6); border: 1px solid var(--line, #262c34); border-radius: 8px; padding: 14px 16px; width: min(760px, 94vw); }
      dialog.spawn-picker::backdrop { background: rgba(0, 0, 0, 0.55); }
      dialog.spawn-picker h3 { margin: 0 0 6px; font-size: 14px; }
      dialog.spawn-picker form { display: block; margin: 0; }
      dialog.spawn-picker .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
      dialog.spawn-picker .row.end { justify-content: flex-end; }
      dialog.spawn-picker input[type='number'] { width: 90px; }
      dialog.spawn-picker .note { color: var(--warn, #e3b341); font-size: 12px; }
      dialog.spawn-picker .map { position: relative; background: var(--bg, #0b0d10); border: 1px solid var(--line, #262c34); border-radius: 5px; min-height: 120px; }
      dialog.spawn-picker canvas { display: block; width: 100%; cursor: crosshair; image-rendering: pixelated; }
      dialog.spawn-picker .mark { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; background: #ff5c5c; border: 2px solid #000; pointer-events: none; }
      dialog.spawn-picker .loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--dim, #8b949e); }
`;
function addStyle(): void {
  if (document.getElementById('spawn-picker-style')) return;
  const el = document.createElement('style');
  el.id = 'spawn-picker-style';
  el.textContent = STYLE;
  document.head.append(el);
}

const maps = new Map<string, Promise<MapData | null>>();
function loadMap(world: string): Promise<MapData | null> {
  let p = maps.get(world);
  if (!p) {
    p = fetch(`/api/world/map?width=512&world=${encodeURIComponent(world)}`)
      .then(async (r) => (r.ok ? decodeWorldMap(await r.arrayBuffer()) : null))
      .catch(() => null);
    maps.set(world, p);
  }
  return p;
}

/**
 * Asks for a spawn point for `who` (a dialog: the world, its map, x and z): what was picked, or null
 * if they cancelled. `worlds`: the worlds there are; `known`: theirs already (the first shown first;
 * picking another world shows theirs there, if they've one).
 */
export function pickSpawn(who: string, worlds: string[], known: Picked[]): Promise<Picked | null> {
  const start = known[0] ?? null;
  addStyle();
  const dialog = document.createElement('dialog');
  dialog.className = 'spawn-picker';
  dialog.innerHTML = `
    <form method="dialog">
      <h3>Spawn point for ${who.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</h3>
      <p class="about">Where they first come into this world, and come back to after dying without a bed. Click the map, or type x and z (metres, as the game's Info panel shows them).</p>
      <div class="row"><label>World <select name="world"></select></label>
        <label>x <input name="x" type="number" step="1" required /></label>
        <label>z <input name="z" type="number" step="1" required /></label>
        <span class="note"></span></div>
      <div class="map"><canvas></canvas><div class="mark" hidden></div><div class="loading">loading the map…</div></div>
      <div class="row end"><button value="cancel" formnovalidate>Cancel</button><button value="save" class="primary">Save</button></div>
    </form>`;
  document.body.append(dialog);
  const q = <T extends Element>(s: string) => dialog.querySelector(s) as T;
  const worldSel = q<HTMLSelectElement>('select'), xIn = q<HTMLInputElement>('input[name=x]'), zIn = q<HTMLInputElement>('input[name=z]');
  const canvas = q<HTMLCanvasElement>('canvas'), mark = q<HTMLDivElement>('.mark'), note = q<HTMLSpanElement>('.note'), loading = q<HTMLDivElement>('.loading');
  for (const w of worlds) worldSel.append(new Option(w, w, false, w === start?.world));
  if (start) {
    xIn.value = String(start.x);
    zIn.value = String(start.z);
  }
  let map: MapData | null = null;
  const showMark = () => {
    const x = Number(xIn.value), z = Number(zIn.value);
    const ok = map && xIn.value !== '' && zIn.value !== '' && Number.isFinite(x) && Number.isFinite(z);
    mark.hidden = !ok;
    note.textContent = '';
    if (!ok || !map) return;
    const { fx, fy } = onMap(map, x, z);
    mark.style.left = `${fx * 100}%`;
    mark.style.top = `${fy * 100}%`;
    const W = (map.cols * map.step) / UNITS_PER_METER, D = (map.rows * map.step) / UNITS_PER_METER;
    if (z < 0 || z > D || x < 0 || x > W) note.textContent = `outside the world (0..${Math.round(W)}, 0..${Math.round(D)})`;
    else if (inSea(map, x, z)) note.textContent = "in the sea: they'd start swimming";
  };
  const showWorld = async () => {
    const world = worldSel.value;
    map = null;
    loading.hidden = false;
    loading.textContent = 'loading the map…';
    showMark();
    const m = await loadMap(world);
    if (worldSel.value !== world) return;
    if (!m) {
      loading.textContent = "couldn't load the map: type x and z";
      return;
    }
    map = m;
    canvas.width = m.cols;
    canvas.height = m.rows;
    canvas.style.aspectRatio = `${m.cols} / ${m.rows}`;
    canvas.getContext('2d')!.putImageData(new ImageData(renderMap(m), m.cols, m.rows), 0, 0);
    loading.hidden = true;
    showMark();
  };
  worldSel.onchange = () => {
    const there = known.find((k) => k.world === worldSel.value);
    xIn.value = there ? String(there.x) : '';
    zIn.value = there ? String(there.z) : '';
    void showWorld();
  };
  xIn.oninput = zIn.oninput = showMark;
  canvas.onclick = (e) => {
    if (!map) return;
    const r = canvas.getBoundingClientRect(), p = pickOnMap(map, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    xIn.value = String(p.x);
    zIn.value = String(p.z);
    showMark();
  };
  void showWorld();
  dialog.showModal();
  // (Saved: told at once, as Save's clicked, not when the dialog's close event comes round after:
  // an Invite clicked straight after must see it.)
  return new Promise((resolve) => {
    q<HTMLFormElement>('form').onsubmit = (e) => {
      const save = (e.submitter as HTMLButtonElement | null)?.value === 'save';
      const x = Number(xIn.value), z = Number(zIn.value);
      resolve(save && xIn.value !== '' && zIn.value !== '' && Number.isFinite(x) && Number.isFinite(z) ? { world: worldSel.value, x, z } : null);
    };
    dialog.onclose = () => {
      resolve(null); // (Escape, or Cancel: nothing; a second resolve does nothing)
      dialog.remove();
    };
  });
}
