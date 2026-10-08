import './header.js';
import './fullscreen.js';
import './envBadge.js';
import { GRASS_LIMITS, SETTINGS_LIMITS, returnTo, workersFor, defaultSettings, loadSettings, saveSettings, type Performance, type Settings } from './settings.js';

/**
 * The settings page: how much of the world the game shows and how hard it works at it. Saved in
 * this browser (see settings.ts). Cancel or save goes back to the page that opened it (its
 * ?return=, a path on this site), or stays here.
 */

const form = document.getElementById('settings-form') as HTMLFormElement;
const detailEl = document.getElementById('s-detail') as HTMLInputElement;
const detailRange = document.getElementById('s-detail-range') as HTMLInputElement;
const detailHint = document.getElementById('s-detail-hint')!;
const viewEl = document.getElementById('s-view') as HTMLInputElement;
const viewRange = document.getElementById('s-view-range') as HTMLInputElement;
const toleranceEl = document.getElementById('s-tolerance') as HTMLSelectElement;
const performanceEl = document.getElementById('s-performance') as HTMLSelectElement;
const fullscreenEl = document.getElementById('s-fullscreen') as HTMLInputElement;
const performanceHint = document.getElementById('s-performance-hint')!;
const errorEl = document.getElementById('s-error')!;
/** The grass's number settings: each a slider and its box. */
const GRASS_FIELDS = [
  { key: 'blades', id: 's-blades', name: 'Blades' },
  { key: 'height', id: 's-grass-height', name: 'Blade height' },
  { key: 'cover', id: 's-grass-cover', name: 'Grass patches' },
  { key: 'sway', id: 's-grass-sway', name: 'Wind' },
] as const;
const grassEls = GRASS_FIELDS.map((f) => ({ ...f, box: document.getElementById(f.id) as HTMLInputElement, range: document.getElementById(`${f.id}-range`) as HTMLInputElement }));
const grassTextureEl = document.getElementById('s-grass-texture') as HTMLInputElement;
const statusEl = document.getElementById('s-status')!;

const back = returnTo(location.search);

let settings = loadSettings();

toleranceEl.appendChild(new Option("World's own", ''));
for (let t = 0; t <= 16; t++) toleranceEl.appendChild(new Option(`${t}/16 m${t === 0 ? ' (exact)' : t === 16 ? ' (1 m)' : ''}`, String(t)));

/** Keeps a slider and its number box in step. */
function pair(range: HTMLInputElement, box: HTMLInputElement, onChange: () => void): void {
  range.addEventListener('input', () => {
    box.value = range.value;
    onChange();
  });
  box.addEventListener('input', () => {
    if (box.value !== '') range.value = box.value;
    onChange();
  });
}
const detailText = () => {
  const n = Number(detailEl.value);
  detailHint.textContent = `Radius of full-detail voxel terrain around you: ${Number.isFinite(n) ? n * 16 : '?'} m (16 m per chunk). Higher costs memory and loading time.`;
};
pair(detailRange, detailEl, detailText);
pair(viewRange, viewEl, () => {});
for (const g of grassEls) pair(g.range, g.box, () => {});
const cores = navigator.hardwareConcurrency || 0;
if (cores) performanceHint.textContent += ` This computer has ${cores} cores.`;
for (const o of performanceEl.options) o.textContent += ` (${workersFor(o.value as Performance, cores)} mesh worker${workersFor(o.value as Performance, cores) === 1 ? '' : 's'})`;

function fillForm(s: Settings): void {
  detailEl.value = detailRange.value = String(s.detail);
  viewEl.value = viewRange.value = String(s.view);
  toleranceEl.value = s.tolerance === null ? '' : String(s.tolerance);
  performanceEl.value = s.performance;
  fullscreenEl.checked = s.fullscreen;
  for (const g of grassEls) g.box.value = g.range.value = String(s.grass[g.key]);
  grassTextureEl.checked = s.grass.texture;
  detailText();
}

function readForm(): Settings | string {
  const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Math.round(v)));
  const detail = Number(detailEl.value), view = Number(viewEl.value);
  if (detailEl.value === '' || !Number.isFinite(detail)) return 'Detail distance must be a number.';
  if (viewEl.value === '' || !Number.isFinite(view)) return 'View distance must be a number.';
  const grass = { ...settings.grass, texture: grassTextureEl.checked };
  for (const g of grassEls) {
    const v = Number(g.box.value);
    if (g.box.value === '' || !Number.isFinite(v)) return `${g.name} must be a number.`;
    grass[g.key] = clamp(v, GRASS_LIMITS[g.key]);
  }
  return {
    ...settings,
    detail: clamp(detail, SETTINGS_LIMITS.detail),
    view: clamp(view, SETTINGS_LIMITS.view),
    tolerance: toleranceEl.value === '' ? null : Number(toleranceEl.value),
    performance: performanceEl.value as Performance,
    fullscreen: fullscreenEl.checked,
    grass,
  };
}

function status(text: string, bad = false): void {
  statusEl.textContent = text;
  statusEl.className = bad ? 'bad' : '';
}

document.getElementById('s-cancel')!.addEventListener('click', () => {
  if (back) location.href = back;
  else {
    fillForm(settings);
    errorEl.textContent = '';
    status('Changes undone.');
  }
});
document.getElementById('s-reset')!.addEventListener('click', () => {
  fillForm({ ...defaultSettings(), world: settings.world });
  status('Defaults filled in: save to keep them.');
});
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const next = readForm();
  if (typeof next === 'string') {
    errorEl.textContent = next;
    return;
  }
  errorEl.textContent = '';
  settings = next;
  if (!saveSettings(settings)) {
    status("This browser won't store settings (site storage is blocked), so the game will use the defaults.", true);
    return;
  }
  if (back) location.href = back;
  else status('Settings saved.');
});

fillForm(settings);
