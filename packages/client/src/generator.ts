import { PLATE_LIMITS, defaultPlateTerrain, isValidWorldName, validatePlateTerrain, type PlateTerrainConfig } from '@super-vox/shared';
import type { PreviewRequest, PreviewResponse } from './generator.worker.js';
import type { Preview } from './generatorPreview.js';
import { materialName } from './materials.js';
import { renderMap } from './worldMap.js';

/** Preview map width in samples (16 km / 512 = 31.25 m per pixel). */
const PREVIEW_SIZE = 512;
const MAX_SEED = 2 ** 31 - 1;

interface FieldSpec {
  key: keyof PlateTerrainConfig;
  label: string;
  section: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  hint?: string;
  /** Slider on a log scale (for settings spanning orders of magnitude). */
  log?: boolean;
  /** A seed: no slider, a button for a random one instead. */
  seed?: boolean;
}

const L = PLATE_LIMITS;
const FIELDS: FieldSpec[] = [
  { key: 'seed', label: 'Layout seed', section: 'Plates', min: 0, max: MAX_SEED, step: 1, seed: true, hint: 'Where plates go and which are continents' },
  { key: 'majorPlates', label: 'Major plates', section: 'Plates', min: L.majorPlates[0], max: L.majorPlates[1], step: 1 },
  { key: 'minorPlates', label: 'Minor plates', section: 'Plates', min: L.minorPlates[0], max: L.minorPlates[1], step: 1, hint: 'Placed along the seams between major plates' },
  { key: 'plateSizeRatio', label: 'Major : minor size', section: 'Plates', min: L.plateSizeRatio[0], max: L.plateSizeRatio[1], step: 0.5, unit: ': 1', hint: 'Area of a major plate relative to a minor one' },
  { key: 'landPercent', label: 'Land', section: 'Land and sea', min: L.landPercent[0], max: L.landPercent[1], step: 1, unit: '%' },
  { key: 'seaLevel', label: 'Sea level', section: 'Land and sea', min: L.height[0], max: L.height[1], step: 1, unit: 'm' },
  { key: 'maxHeight', label: 'Highest land', section: 'Land and sea', min: L.height[0], max: L.height[1], step: 1, unit: 'm' },
  { key: 'minHeight', label: 'Deepest sea floor', section: 'Land and sea', min: L.height[0], max: L.height[1], step: 1, unit: 'm' },
  { key: 'shoreFractal', label: 'Shoreline fractal', section: 'Land and sea', min: L.shoreFractal[0], max: L.shoreFractal[1], step: 1, hint: '0 smooth coasts … 100 broken coasts, many islands' },
  { key: 'terrainSeed', label: 'Terrain seed', section: 'Relief', min: 0, max: MAX_SEED, step: 1, seed: true, hint: "Each plate's noise; reroll the relief, keep the plates" },
  { key: 'noiseScale', label: 'Feature size', section: 'Relief', min: L.noiseScale[0], max: L.noiseScale[1], step: 50, unit: 'm', log: true, hint: 'Size of the largest hills and basins' },
  { key: 'noiseRoughness', label: 'Roughness', section: 'Relief', min: L.noiseRoughness[0], max: L.noiseRoughness[1], step: 1, hint: '0 smooth swells … 100 rugged' },
];

// ---- Settings, kept in the URL hash so a reload (or a shared link) keeps them.

function fromHash(): PlateTerrainConfig {
  const config = defaultPlateTerrain(1);
  const params = new URLSearchParams(location.hash.slice(1));
  for (const f of FIELDS) {
    const raw = params.get(f.key);
    const v = raw === null ? NaN : Number(raw);
    if (Number.isFinite(v)) config[f.key] = v;
  }
  try {
    validatePlateTerrain(config);
    return config;
  } catch {
    return defaultPlateTerrain(1);
  }
}

function toHash(config: PlateTerrainConfig): void {
  const params = new URLSearchParams(FIELDS.map((f) => [f.key, String(config[f.key])]));
  history.replaceState(null, '', `#${params}`);
}

let config = fromHash();

// ---- Form

const form = document.getElementById('form') as HTMLFormElement;
const inputs = new Map<keyof PlateTerrainConfig, { number: HTMLInputElement; range: HTMLInputElement | null; hint: HTMLElement | null }>();
const toSlider = (f: FieldSpec, v: number) => (f.log ? (Math.log(v / f.min) / Math.log(f.max / f.min)) * 1000 : v);
const fromSlider = (f: FieldSpec, s: number) => (f.log ? Math.round((f.min * (f.max / f.min) ** (s / 1000)) / f.step) * f.step : s);

let section = '';
for (const f of FIELDS) {
  if (f.section !== section) {
    section = f.section;
    const h = document.createElement('h2');
    h.textContent = section;
    form.appendChild(h);
  }
  const div = document.createElement('div');
  div.className = 'field';
  const label = document.createElement('label');
  label.textContent = f.label;
  label.htmlFor = `f-${f.key}`;
  const value = document.createElement('div');
  value.className = 'value';
  const number = document.createElement('input');
  Object.assign(number, { type: 'number', id: `f-${f.key}`, min: String(f.min), max: String(f.max), step: String(f.step) });
  value.appendChild(number);
  if (f.unit) {
    const u = document.createElement('span');
    u.className = 'unit';
    u.textContent = f.unit;
    value.appendChild(u);
  }
  let range: HTMLInputElement | null = null;
  if (f.seed) {
    const dice = document.createElement('button');
    dice.type = 'button';
    dice.textContent = 'random';
    dice.title = `New random ${f.label.toLowerCase()}`;
    dice.addEventListener('click', () => set(f.key, Math.floor(Math.random() * MAX_SEED)));
    value.appendChild(dice);
  }
  div.append(label, value);
  if (!f.seed) {
    range = document.createElement('input');
    Object.assign(range, { type: 'range', min: String(f.log ? 0 : f.min), max: String(f.log ? 1000 : f.max), step: String(f.log ? 1 : f.step) });
    range.setAttribute('aria-label', f.label);
    range.addEventListener('input', () => set(f.key, fromSlider(f, Number(range!.value))));
    div.appendChild(range);
  }
  let hint: HTMLElement | null = null;
  if (f.hint || f.key === 'landPercent') {
    hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = f.hint ?? '';
    div.appendChild(hint);
  }
  number.addEventListener('change', () => {
    const v = Number(number.value);
    if (number.value.trim() !== '' && Number.isFinite(v)) set(f.key, Math.min(f.max, Math.max(f.min, v)));
    else showForm();
  });
  inputs.set(f.key, { number, range, hint });
  form.appendChild(div);
}

function showForm(): void {
  for (const f of FIELDS) {
    const { number, range, hint } = inputs.get(f.key)!;
    const v = config[f.key];
    if (document.activeElement !== number) number.value = String(v);
    if (range && document.activeElement !== range) range.value = String(toSlider(f, v));
    if (f.key === 'landPercent' && hint) hint.textContent = `${v}% land · ${100 - v}% sea`;
  }
}

function set(key: keyof PlateTerrainConfig, value: number): void {
  config = { ...config, [key]: value };
  showForm();
  toHash(config);
  requestPreview();
}

document.getElementById('reset')!.addEventListener('click', () => {
  config = defaultPlateTerrain(1);
  showForm();
  toHash(config);
  requestPreview();
});

// ---- Preview: built in a worker; while one builds, only the newest settings wait.

const canvas = document.getElementById('map') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const statsEl = document.getElementById('stats')!;
const hoverEl = document.getElementById('hover')!;
const viewEl = document.getElementById('view') as HTMLSelectElement;
const worker = new Worker(new URL('./generator.worker.ts', import.meta.url), { type: 'module' });
let busy = false;
/** Settings changed while a preview was building: build again with the latest when it's done. */
let queued = false;
/** The settings of the preview being built. */
let sent: PlateTerrainConfig = config;
let nextId = 1;
let preview: Preview | null = null;
let previewConfig: PlateTerrainConfig | null = null;

function requestPreview(): void {
  try {
    validatePlateTerrain(config);
  } catch (err) {
    statsEl.textContent = (err as Error).message;
    statsEl.className = 'bad';
    return;
  }
  if (busy) {
    queued = true;
    return;
  }
  busy = true;
  sent = config;
  canvas.classList.add('busy');
  const req: PreviewRequest = { id: nextId++, config, size: PREVIEW_SIZE };
  worker.postMessage(req);
}

worker.onmessage = (ev: MessageEvent<PreviewResponse>) => {
  busy = false;
  const res = ev.data;
  if (res.ok) {
    preview = res.preview;
    previewConfig = sent;
    draw();
    const s = res.preview.stats;
    statsEl.className = '';
    statsEl.textContent =
      `built in ${Math.round(s.ms)} ms · land ${(s.land * 100).toFixed(1)}% · ground ${Math.round(s.minHeight)}..${Math.round(s.maxHeight)} m · ` +
      `${s.majors} major + ${s.minors} minor plates` +
      (s.minors > 0 && s.majors > 0 ? ` · major:minor area ${s.sizeRatio.toFixed(1)}:1` : '');
  } else {
    statsEl.className = 'bad';
    statsEl.textContent = res.error;
  }
  if (queued) {
    queued = false;
    requestPreview();
  } else {
    canvas.classList.remove('busy');
  }
};
worker.onerror = (e) => {
  busy = false;
  statsEl.className = 'bad';
  statsEl.textContent = `preview failed: ${e.message}`;
};

/** RGB (0..255) for a hue (degrees), saturation and lightness (0..1). */
function hsl(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

function draw(): void {
  if (!preview) return;
  const { map, plateOf, plates } = preview;
  const { cols, rows } = map;
  canvas.width = cols;
  canvas.height = rows;
  const mode = viewEl.value;
  const px = renderMap(map);
  if (mode === 'plates') {
    // One hue per plate (spread by the golden angle); continents light, ocean floor dark; minors hatched.
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = plateOf[i + cols * j]!;
        const p = plates[k]!;
        let c = hsl((k * 137.508) % 360, p.major ? 0.45 : 0.75, p.continental ? 0.62 : 0.4);
        if (!p.major && (i + j) % 8 < 3) c = c.map((v) => v * 0.7) as [number, number, number];
        px.set([c[0], c[1], c[2], 255], (i + cols * j) * 4);
      }
    }
  }
  if (mode !== 'terrain') {
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = i + cols * j;
        const edge = (i + 1 < cols && plateOf[k + 1] !== plateOf[k]) || (j + 1 < rows && plateOf[k + cols] !== plateOf[k]);
        if (edge) px.set([15, 15, 15, 255], k * 4);
      }
    }
  }
  ctx.putImageData(new ImageData(px, cols, rows), 0, 0);
}
viewEl.addEventListener('change', draw);

canvas.addEventListener('mousemove', (e) => {
  if (!preview || !previewConfig) return;
  const r = canvas.getBoundingClientRect();
  const i = Math.floor(((e.clientX - r.left) / r.width) * preview.map.cols);
  const j = Math.floor(((e.clientY - r.top) / r.height) * preview.map.rows);
  if (i < 0 || j < 0 || i >= preview.map.cols || j >= preview.map.rows) return;
  const k = i + preview.map.cols * j;
  const step = preview.map.step / 16 / 1000; // km per sample
  const h = preview.map.heights[k]! / 16;
  const p = preview.plateOf[k]!;
  const plate = preview.plates[p]!;
  hoverEl.textContent =
    `${((i + 0.5) * step).toFixed(2)}, ${((j + 0.5) * step).toFixed(2)} km · ${h.toFixed(1)} m (${(h - previewConfig.seaLevel).toFixed(1)} m ${h >= previewConfig.seaLevel ? 'above' : 'below'} sea) · ${materialName(preview.map.materials[k]!)}\n` +
    `plate ${p}: ${plate.major ? 'major' : 'minor'}, ${plate.continental ? 'continental' : 'oceanic'}`;
});
canvas.addEventListener('mouseleave', () => (hoverEl.textContent = ''));

// ---- Worlds on the server, and creating one from these settings.

const nameEl = document.getElementById('name') as HTMLInputElement;
const createEl = document.getElementById('create') as HTMLButtonElement;
const messageEl = document.getElementById('message')!;
const worldsEl = document.getElementById('worlds')!;

function message(text: string, kind: 'good' | 'bad' | '' = '', link?: { href: string; text: string }): void {
  messageEl.className = kind;
  messageEl.textContent = text;
  if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.text;
    messageEl.append(' ', a);
  }
}

let canCreate = true;
const playHref = (name: string) => `/?world=${encodeURIComponent(name)}`;

interface WorldsReply {
  default: string;
  canCreate: boolean;
  worlds: { name: string; createdAt: string; spec: { generator: string; plates?: PlateTerrainConfig } }[];
}

async function loadWorlds(): Promise<void> {
  let data: WorldsReply;
  try {
    const res = await fetch('/api/worlds');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = (await res.json()) as WorldsReply;
  } catch (err) {
    worldsEl.innerHTML = '';
    const li = document.createElement('li');
    li.innerHTML = '<em></em>';
    li.querySelector('em')!.textContent = `couldn't list worlds (${(err as Error).message}); is the server running?`;
    worldsEl.appendChild(li);
    return;
  }
  canCreate = data.canCreate;
  createEl.disabled = !canCreate;
  if (!data.canCreate) message('Creating worlds is disabled on this server.', 'bad');
  worldsEl.innerHTML = '';
  for (const w of data.worlds) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = w.name;
    name.title = `created ${w.createdAt}`;
    const kind = document.createElement('em');
    kind.textContent = w.spec.generator + (w.name === data.default ? ', default' : '');
    li.append(name, kind);
    if (w.spec.plates) {
      const load = document.createElement('button');
      load.type = 'button';
      load.textContent = 'Load';
      load.title = "Load this world's settings into the form";
      const plates = w.spec.plates;
      load.addEventListener('click', () => {
        config = { ...defaultPlateTerrain(plates.seed), ...plates };
        showForm();
        toHash(config);
        requestPreview();
        message(`Loaded the settings of "${w.name}".`);
      });
      li.appendChild(load);
    }
    const play = document.createElement('a');
    play.href = playHref(w.name);
    play.textContent = 'Play';
    li.appendChild(play);
    worldsEl.appendChild(li);
  }
  if (data.worlds.length === 0) worldsEl.innerHTML = '<li><em>none yet</em></li>';
}

createEl.addEventListener('click', async () => {
  const name = nameEl.value.trim();
  if (!isValidWorldName(name)) {
    message('Names are 1-64 lower-case letters, digits, "-" or "_", starting with a letter or digit.', 'bad');
    return;
  }
  createEl.disabled = true;
  try {
    const res = await fetch('/api/worlds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, plates: config }) });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 201) {
      message(`Created "${name}".`, 'good', { href: playHref(name), text: `Play ${name}` });
      nameEl.value = '';
      await loadWorlds();
    } else {
      message(body.error ?? `Server said ${res.status}.`, 'bad');
    }
  } catch (err) {
    message(`Couldn't reach the server: ${(err as Error).message}`, 'bad');
  } finally {
    createEl.disabled = !canCreate;
  }
});
nameEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createEl.click();
});

showForm();
toHash(config);
requestPreview();
void loadWorlds();
