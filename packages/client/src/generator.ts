import './fullscreen.js';
import { BIOME_NAMES, Biome, DEFAULT_WORLD_SHAPE, PLATE_LIMITS, SURFACE_SETTINGS, WORLD_SHAPES, defaultPlateCounts, defaultPlateTerrain, isValidWorldName, isWorldShape, validatePlateTerrain, type BiomeId, type PlateTerrainConfig, type WorldShape } from '@super-vox/shared';
import type { PreviewRequest, PreviewResponse } from './generator.worker.js';
import type { CloseUpRequest, CloseUpResponse } from './generatorArea.worker.js';
import { Diorama } from './diorama.js';
import type { Preview } from './generatorPreview.js';
import { materialName } from './materials.js';
import { renderMap } from './worldMap.js';

/** Preview map width in samples (16 km / 512 = 31.25 m per pixel). */
/** Preview samples across: more for worlds wider than 16 km. */
const previewSize = (s: WorldShape) => (WORLD_SHAPES[s].widthUnits > 16 * 16000 ? 1024 : 512);
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
  /** An on/off setting (1/0): a checkbox. */
  toggle?: boolean;
}

const L = PLATE_LIMITS;
const FIELDS: FieldSpec[] = [
  { key: 'seed', label: 'Layout seed', section: 'Plates', min: 0, max: MAX_SEED, step: 1, seed: true, hint: 'Where plates go and which are continents' },
  { key: 'majorPlates', label: 'Major plates', section: 'Plates', min: L.majorPlates[0], max: L.majorPlates[1], step: 1 },
  { key: 'minorPlates', label: 'Minor plates', section: 'Plates', min: L.minorPlates[0], max: L.minorPlates[1], step: 1, hint: 'Placed along the seams between major plates' },
  { key: 'plateSizeRatio', label: 'Major : minor size', section: 'Plates', min: L.plateSizeRatio[0], max: L.plateSizeRatio[1], step: 0.5, unit: ': 1', hint: 'Area of a major plate relative to a minor one' },
  { key: 'landPercent', label: 'Land', section: 'Land and sea', min: L.landPercent[0], max: L.landPercent[1], step: 1, unit: '%' },
  { key: 'seaLevel', label: 'Sea level', section: 'Land and sea', min: L.height[0], max: L.height[1], step: 1, unit: 'm' },
  { key: 'maxHeight', label: 'Highest hills', section: 'Land and sea', min: L.height[0], max: L.height[1], step: 1, unit: 'm', hint: 'Top of the land outside mountain ranges' },
  { key: 'minHeight', label: 'Deepest sea floor', section: 'Land and sea', min: L.height[0], max: L.height[1], step: 1, unit: 'm' },
  { key: 'shoreFractal', label: 'Shoreline fractal', section: 'Land and sea', min: L.shoreFractal[0], max: L.shoreFractal[1], step: 1, hint: '0 smooth coasts … 100 broken coasts, many islands' },
  { key: 'terrainSeed', label: 'Terrain seed', section: 'Relief', min: 0, max: MAX_SEED, step: 1, seed: true, hint: "Each plate's noise; reroll the relief, keep the plates" },
  { key: 'noiseScale', label: 'Feature size', section: 'Relief', min: L.noiseScale[0], max: L.noiseScale[1], step: 50, unit: 'm', log: true, hint: 'Size of the largest hills and basins' },
  { key: 'noiseRoughness', label: 'Roughness', section: 'Relief', min: L.noiseRoughness[0], max: L.noiseRoughness[1], step: 1, hint: '0 smooth swells … 100 rugged' },
  { key: 'plains', label: 'Plains', section: 'Relief', min: L.plains[0], max: L.plains[1], step: 1, unit: '%', hint: 'Share of the land that is broad, nearly flat lowland (good for building)' },
  { key: 'lowlandFlatness', label: 'Lowland flatness', section: 'Relief', min: L.lowlandFlatness[0], max: L.lowlandFlatness[1], step: 1, hint: 'Flatter low ground, steeper climb near the peaks (flat coasts get wider beaches)' },
  { key: 'surfaceRoughness', label: 'Surface roughness', section: 'Relief', min: L.surfaceRoughness[0], max: L.surfaceRoughness[1], step: 1, hint: 'Small bumps in the ground: 0 smooth … 100 lumpy (50 = original)' },
  { key: 'mountains', label: 'Mountains', section: 'Mountains', min: L.mountains[0], max: L.mountains[1], step: 1, unit: '%', hint: 'Share of converging plate seams that raise ranges (0 = none)' },
  { key: 'mountainHeight', label: 'Mountain height', section: 'Mountains', min: L.height[0], max: L.height[1], step: 5, unit: 'm', hint: 'The highest peak (at least the highest hills)' },
  { key: 'mountainWidth', label: 'Range width', section: 'Mountains', min: L.mountainWidth[0], max: L.mountainWidth[1], step: 50, unit: 'm', log: true },
  { key: 'mountainRuggedness', label: 'Ruggedness', section: 'Mountains', min: L.mountainRuggedness[0], max: L.mountainRuggedness[1], step: 1, hint: '0 rounded massifs … 100 sharp ridges' },
  { key: 'mountainDetail', label: 'Mountain detail', section: 'Mountains', min: L.mountainDetail[0], max: L.mountainDetail[1], step: 1, hint: 'Gullies, spurs and crags on mountain sides (16-256 m); fine detail, so it shows in the game more than in this preview' },
  { key: 'beaches', label: 'Beaches', section: 'Surface', min: L.beaches[0], max: L.beaches[1], step: 1, hint: 'Sand on gentle coasts: 0 none … 100 wide; steep coasts stay rocky' },
  { key: 'rockAltitude', label: 'Rock altitude', section: 'Surface', min: L.altitude[0], max: L.altitude[1], step: 5, unit: 'm', hint: 'Bare rock from this height above the sea, however warm (with biomes, cold high ground has rock too)' },
  { key: 'altitudeRock', label: 'Rock altitude with biomes', section: 'Surface', min: 0, max: 1, step: 1, toggle: true, hint: 'With biomes: bare rock above the rock altitude too (off: temperature alone, as worlds made before this setting)' },
  { key: 'snowAltitude', label: 'Snow altitude', section: 'Surface', min: L.altitude[0], max: L.altitude[1], step: 5, unit: 'm', hint: 'Snow from this height above the sea, however warm (with biomes, cold ground lower down has snow too)' },
  { key: 'altitudeSnow', label: 'Snow altitude with biomes', section: 'Surface', min: 0, max: 1, step: 1, toggle: true, hint: 'With biomes: snow above the snow altitude too (off: temperature alone, as worlds made before this setting)' },
  { key: 'snowFractal', label: 'Snow line fractal', section: 'Surface', min: L.snowFractal[0], max: L.snowFractal[1], step: 1, hint: 'How ragged the snow line is: 0 a contour … 100 wandering ±60 m' },
  { key: 'rockRoughness', label: 'Rock roughness', section: 'Surface', min: L.rockRoughness[0], max: L.rockRoughness[1], step: 1, hint: 'Outcrops, knolls and gullies (16-256 m) on bare rock ground (cold high ground, above the rock altitude): 0 smooth … 100 up to ±24 m; fine detail, so it shows in the game more than in this preview' },
  { key: 'rockVariety', label: 'Rock variety', section: 'Surface', min: L.rockVariety[0], max: L.rockVariety[1], step: 1, hint: 'Bare rock in patches of gravel, pale and (where wet) mossy stone, with dark bands on steep faces: 0 all one stone … 100 many' },
  { key: 'rockSlope', label: 'Rock slope', section: 'Surface', min: L.rockSlope[0], max: L.rockSlope[1], step: 1, unit: '°', hint: 'Ground steeper than this is bare rock, even above the snow; 90 = never' },
  { key: 'biomes', label: 'Biomes', section: 'Climate', min: 0, max: 1, step: 1, toggle: true, hint: 'Jungle, forests, grassland, savanna, desert, tundra and ice from temperature and moisture' },
  { key: 'northTemperature', label: 'North temperature', section: 'Climate', min: L.temperature[0], max: L.temperature[1], step: 1, unit: '°C', hint: 'At sea level on the north edge' },
  { key: 'southTemperature', label: 'South temperature', section: 'Climate', min: L.temperature[0], max: L.temperature[1], step: 1, unit: '°C', hint: 'At sea level on the south edge' },
  { key: 'equator', label: 'Equator', section: 'Climate', min: 0, max: 1, step: 1, toggle: true, hint: 'Hottest across the middle, colder toward both edges (off: from the north edge to the south edge)' },
  { key: 'equatorTemperature', label: 'Equator temperature', section: 'Climate', min: L.temperature[0], max: L.temperature[1], step: 1, unit: '°C', hint: 'At sea level across the middle (with an equator)' },
  { key: 'altitudeCooling', label: 'Altitude cooling', section: 'Climate', min: L.altitudeCooling[0], max: L.altitudeCooling[1], step: 0.1, unit: '°C/100 m', hint: 'Colder with height (real air: ~0.65)' },
  { key: 'rainfall', label: 'Rainfall', section: 'Climate', min: L.rainfall[0], max: L.rainfall[1], step: 1, hint: '0 dry … 100 soaked; wet near the sea, drier inland' },
  { key: 'snowTemperature', label: 'Snow temperature', section: 'Climate', min: L.temperature[0], max: L.temperature[1], step: 0.5, unit: '°C', hint: 'Ground colder than this is snow; a band of bare rock lies just below it on high ground' },
  { key: 'biomeBlend', label: 'Biome blending', section: 'Climate', min: L.biomeBlend[0], max: L.biomeBlend[1], step: 1, hint: '0 sharp borders … 100 wide, ragged transitions where trees mix and ground colours blend' },
  { key: 'rivers', label: 'Rivers', section: 'Climate', min: L.rivers[0], max: L.rivers[1], step: 1, hint: '0 none … 100 many small streams; rivers cut valleys to the sea, more in wet country' },
  { key: 'lakes', label: 'Lakes', section: 'Climate', min: L.lakes[0], max: L.lakes[1], step: 1, unit: '%', hint: 'Share of the water land basins could hold that stands in lakes, the biggest first: 0 basins filled in … 100 even small basins hold lakes' },
  { key: 'lakesByArea', label: 'Lakes by area', section: 'Climate', min: 0, max: 1, step: 1, toggle: true, hint: 'On: lakes is a share of the water basins could hold, growing evenly. Off: the smallest basin with a lake, halving every 10 (as worlds made before this setting)' },
  { key: 'trees', label: 'Trees', section: 'Climate', min: L.trees[0], max: L.trees[1], step: 1, hint: 'Forest density: 0 none, 50 natural for each biome, 100 double' },
  { key: 'treeClumping', label: 'Tree clumping', section: 'Climate', min: L.treeClumping[0], max: L.treeClumping[1], step: 1, hint: '0 trees spread evenly … 100 dense groves and open glades (~100-400 m across)' },
  { key: 'windFrom', label: 'Wind from', section: 'Climate', min: L.windFrom[0], max: L.windFrom[1], step: 5, unit: '°', hint: 'Compass direction rain comes from (270 = west); land behind mountains is drier' },
  { key: 'islandArcs', label: 'Island arcs', section: 'Islands', min: L.islandArcs[0], max: L.islandArcs[1], step: 1, hint: 'Chains along seams where an ocean plate meets another plate' },
  { key: 'hotspots', label: 'Hotspots', section: 'Islands', min: L.hotspots[0], max: L.hotspots[1], step: 1, hint: 'Groups in ocean plates: a main island trailing smaller ones' },
  { key: 'islandMinSize', label: 'Smallest island', section: 'Islands', min: L.islandSize[0], max: L.islandSize[1], step: 10, unit: 'm', log: true, hint: 'Across; islands count toward the land share' },
  { key: 'islandMaxSize', label: 'Largest island', section: 'Islands', min: L.islandSize[0], max: L.islandSize[1], step: 10, unit: 'm', log: true },
];

// ---- Settings, kept in the URL hash so a reload (or a shared link) keeps them.

function fromHash(): PlateTerrainConfig {
  const config = defaultPlateTerrain(1, WORLD_SHAPES[shape]);
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
    return defaultPlateTerrain(1, WORLD_SHAPES[shape]);
  }
}

function toHash(config: PlateTerrainConfig): void {
  const params = new URLSearchParams([['shape', shape], ...FIELDS.map((f) => [f.key, String(config[f.key])])]);
  history.replaceState(null, '', `#${params}`);
}

/** The world's shape: round (16 km around, 8 km north-south) or flat (16 x 16 km). */
const hashShape = new URLSearchParams(location.hash.slice(1)).get('shape');
let shape: WorldShape = isWorldShape(hashShape) ? hashShape : DEFAULT_WORLD_SHAPE;
const shapeEl = document.getElementById('shape') as HTMLSelectElement;
shapeEl.value = shape;
shapeEl.addEventListener('change', () => {
  // (Another world: the close-up's area is gone with it.)
  if (closeUp) closeCloseUp();
  // Plate counts follow the world's size, keeping their proportion to the default.
  const before = defaultPlateCounts(WORLD_SHAPES[shape]);
  shape = shapeEl.value as WorldShape;
  const after = defaultPlateCounts(WORLD_SHAPES[shape]);
  const L = PLATE_LIMITS;
  config = {
    ...config,
    majorPlates: Math.max(L.majorPlates[0], Math.min(L.majorPlates[1], Math.round((config.majorPlates * after.majorPlates) / before.majorPlates))),
    minorPlates: Math.max(L.minorPlates[0], Math.min(L.minorPlates[1], Math.round((config.minorPlates * after.minorPlates) / Math.max(1, before.minorPlates)))),
  };
  showForm();
  toHash(config);
  requestPreview();
});

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
    // (A section with none of the surface settings goes in the close-up too.)
    if (!FIELDS.some((g) => g.section === f.section && SURFACE_SETTINGS.includes(g.key))) h.classList.add('world-only');
    form.appendChild(h);
  }
  const div = document.createElement('div');
  div.className = 'field' + (SURFACE_SETTINGS.includes(f.key) ? '' : ' world-only');
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
  if (f.toggle) {
    number.type = 'checkbox';
    number.addEventListener('change', () => set(f.key, number.checked ? 1 : 0));
  }
  if (f.seed) {
    const dice = document.createElement('button');
    dice.type = 'button';
    dice.textContent = 'random';
    dice.title = `New random ${f.label.toLowerCase()}`;
    dice.addEventListener('click', () => set(f.key, Math.floor(Math.random() * MAX_SEED)));
    value.appendChild(dice);
  }
  div.append(label, value);
  if (!f.seed && !f.toggle) {
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
  if (!f.toggle) number.addEventListener('change', () => {
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
    if (f.toggle) number.checked = v === 1;
    else if (document.activeElement !== number) number.value = String(v);
    if (range && document.activeElement !== range) range.value = String(toSlider(f, v));
    if (f.key === 'landPercent' && hint) hint.textContent = `${v}% land · ${100 - v}% sea`;
  }
}

function set(key: keyof PlateTerrainConfig, value: number): void {
  config = { ...config, [key]: value };
  // Dragging one island size past the other pushes the other along.
  if (key === 'islandMinSize' && value > config.islandMaxSize) config.islandMaxSize = value;
  if (key === 'islandMaxSize' && value < config.islandMinSize) config.islandMinSize = value;
  // Hills can't top the mountains: raising one past the other pushes the other along.
  if (key === 'maxHeight' && value > config.mountainHeight) config.mountainHeight = value;
  if (key === 'mountainHeight' && value < config.maxHeight) config.maxHeight = value;
  showForm();
  toHash(config);
  // (In the close-up, only it is redrawn: the map waits till it's back.)
  if (closeUp) requestCloseUp();
  else requestPreview();
}

document.getElementById('reset')!.addEventListener('click', () => {
  config = defaultPlateTerrain(1, WORLD_SHAPES[shape]);
  showForm();
  toHash(config);
  if (closeUp) requestCloseUp();
  else requestPreview();
});

// ---- Preview: built in a worker, which drops a build once newer settings arrive.

const canvas = document.getElementById('map') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const statsEl = document.getElementById('stats')!;
const hoverEl = document.getElementById('hover')!;
const viewEl = document.getElementById('view') as HTMLSelectElement;
const legendEl = document.getElementById('legend')!;

/** Map colours for the biomes view (sRGB). */
const BIOME_COLORS: Record<BiomeId, readonly [number, number, number]> = {
  [Biome.Ice]: [236, 241, 246],
  [Biome.Tundra]: [150, 140, 110],
  [Biome.Boreal]: [40, 96, 82],
  [Biome.Temperate]: [72, 150, 60],
  [Biome.Grassland]: [160, 196, 92],
  [Biome.Jungle]: [18, 88, 34],
  [Biome.Savanna]: [204, 178, 84],
  [Biome.Desert]: [228, 152, 82],
};
for (const b of Object.values(Biome)) {
  const item = document.createElement('span');
  const sw = document.createElement('i');
  sw.style.background = `rgb(${BIOME_COLORS[b].join(',')})`;
  item.append(sw, BIOME_NAMES[b]);
  legendEl.appendChild(item);
}
const worker = new Worker(new URL('./generator.worker.ts', import.meta.url), { type: 'module' });
/** The newest request sent, and its settings: the worker answers only the newest. */
let sentId = 0;
let sent: PlateTerrainConfig = config;
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
  sent = config;
  canvas.classList.add('busy');
  const req: PreviewRequest = { id: ++sentId, config, size: previewSize(shape), shape };
  worker.postMessage(req);
}

worker.onmessage = (ev: MessageEvent<PreviewResponse>) => {
  const res = ev.data;
  if (res.id !== sentId) return;
  canvas.classList.remove('busy');
  if (res.ok) {
    preview = res.preview;
    previewConfig = sent;
    draw();
    const s = res.preview.stats;
    statsEl.className = '';
    statsEl.textContent =
      `built in ${Math.round(s.ms)} ms · land ${(s.land * 100).toFixed(1)}% · ground ${Math.round(s.minHeight)}..${Math.round(s.maxHeight)} m · ` +
      `${s.majors} major + ${s.minors} minor plates` +
      (s.minors > 0 && s.majors > 0 ? ` · major:minor area ${s.sizeRatio.toFixed(1)}:1` : '') +
      (s.ranges > 0 ? ` · ${s.ranges} mountain range${s.ranges === 1 ? '' : 's'}` : '') +
      (s.biomes
        ? ' · ' +
          s.biomes
            .map((share, b) => ({ share, b }))
            .filter((x) => x.share >= 0.01)
            .sort((x, y) => y.share - x.share)
            .map((x) => `${BIOME_NAMES[x.b as BiomeId]} ${Math.round(x.share * 100)}%`)
            .join(', ')
        : '') +
      (s.islands.arc + s.islands.hotspot > 0
        ? ` · ${s.islands.arc + s.islands.hotspot} islands (${s.islands.arc} arc, ${s.islands.hotspot} hotspot), ${(s.islands.land * 100).toFixed(1)}% of the world`
        : '');
  } else {
    statsEl.className = 'bad';
    statsEl.textContent = res.error;
  }
};
worker.onerror = (e) => {
  canvas.classList.remove('busy');
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
  canvas.style.aspectRatio = `${cols} / ${rows}`;
  canvas.height = rows;
  const mode = viewEl.value;
  const px = renderMap(map);
  if (mode === 'biomes' && preview.biome) {
    // Flat biome colours over land; the sea as drawn.
    const biome = preview.biome;
    for (let k = 0; k < cols * rows; k++) {
      if (map.heights[k]! <= (map.seaLevel ?? -Infinity)) continue;
      const c = BIOME_COLORS[biome[k]! as BiomeId];
      px.set([c[0], c[1], c[2], 255], k * 4);
    }
  }
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
  legendEl.hidden = mode !== 'biomes';
  if (mode === 'borders' || mode === 'plates') {
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = i + cols * j;
        const edge = (i + 1 < cols && plateOf[k + 1] !== plateOf[k]) || (j + 1 < rows && plateOf[k + cols] !== plateOf[k]);
        if (edge) px.set([15, 15, 15, 255], k * 4);
      }
    }
  }
  ctx.putImageData(new ImageData(px, cols, rows), 0, 0);
  // Rivers, drawn as lines (most are narrower than a sample).
  if (mode !== 'plates' && mode !== 'biomes') {
    const r = preview.rivers;
    ctx.strokeStyle = 'rgb(70, 120, 160)';
    ctx.lineCap = 'round';
    for (let k = 0; k < r.length; k += 5) {
      ctx.lineWidth = Math.max(0.8, r[k + 4]! / map.step);
      ctx.beginPath();
      ctx.moveTo(r[k]! / map.step, r[k + 1]! / map.step);
      ctx.lineTo(r[k + 2]! / map.step, r[k + 3]! / map.step);
      ctx.stroke();
    }
  }
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
    `plate ${p}: ${plate.major ? 'major' : 'minor'}, ${plate.continental ? 'continental' : 'oceanic'}` +
    (preview.biome && h > previewConfig.seaLevel ? ` · ${BIOME_NAMES[preview.biome[k]! as BiomeId]}` : '');
});
canvas.addEventListener('mouseleave', () => (hoverEl.textContent = ''));

// ---- Worlds on the server: create one from these settings, or load one, change it and save
//      it back (which discards its edits), or delete one.

const nameEl = document.getElementById('name') as HTMLInputElement;
const createEl = document.getElementById('create') as HTMLButtonElement;
const messageEl = document.getElementById('message')!;
const worldsEl = document.getElementById('worlds')!;
const editingEl = document.getElementById('editing')!;
const editingNameEl = document.getElementById('editing-name')!;
const updateEl = document.getElementById('update') as HTMLButtonElement;
const confirmUpdateEl = document.getElementById('confirm-update')!;
const confirmUpdateText = document.getElementById('confirm-update-text')!;
const updateYesEl = document.getElementById('update-yes') as HTMLButtonElement;

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

/** Whether this server lets us create, change and delete worlds (development only). */
let canChange = true;
/** The world whose settings were loaded into the form, to save back to. */
let editing: { name: string; editedChunks: number } | null = null;
const playHref = (name: string) => `/play.html?world=${encodeURIComponent(name)}`;

interface WorldInfo {
  name: string;
  createdAt: string;
  updatedAt?: string;
  editedChunks: number;
  mode?: 'survival' | 'creative';
  spec: { generator: string; plates?: PlateTerrainConfig; shape?: WorldShape };
}

interface WorldsReply {
  default: string;
  canCreate: boolean;
  worlds: WorldInfo[];
}

function showEditing(): void {
  editingEl.hidden = editing === null || !canChange;
  confirmUpdateEl.hidden = true;
  if (editing) editingNameEl.textContent = editing.name;
  for (const li of worldsEl.querySelectorAll('li')) li.classList.toggle('editing', li.dataset.name === editing?.name);
}

/** Reads a JSON error body, or describes the status. */
async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Server said ${res.status}.`;
}

/** A button that needs a second click (within 4 s) to act. */
function twoStep(button: HTMLButtonElement, armedText: string, act: () => Promise<void>): void {
  const idle = button.textContent;
  let timer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener('click', async () => {
    if (!button.classList.contains('danger')) {
      button.classList.add('danger');
      button.textContent = armedText;
      timer = setTimeout(() => {
        button.classList.remove('danger');
        button.textContent = idle;
      }, 4000);
      return;
    }
    clearTimeout(timer);
    button.disabled = true;
    await act();
    button.disabled = false;
    button.classList.remove('danger');
    button.textContent = idle;
  });
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
  canChange = data.canCreate;
  createEl.disabled = !canChange;
  if (!canChange) message('Creating, changing and deleting worlds is for admins: sign in on the menu page (/).', 'bad');
  // A world loaded for editing that has since gone (e.g. deleted elsewhere) can't be saved to.
  const current = editing && data.worlds.find((w) => w.name === editing!.name);
  editing = current ? { name: current.name, editedChunks: current.editedChunks } : null;
  worldsEl.innerHTML = '';
  for (const w of data.worlds) {
    const li = document.createElement('li');
    li.dataset.name = w.name;
    const name = document.createElement('span');
    name.textContent = w.name;
    name.title = `created ${w.createdAt}` + (w.updatedAt ? `, regenerated ${w.updatedAt}` : '') + `, ${w.editedChunks} edited chunks`;
    const kind = document.createElement('em');
    kind.textContent = w.spec.generator + (w.spec.generator === 'plates' ? (w.spec.shape?.startsWith('round') ? ', round' : ', flat') : '') + (w.mode ? `, ${w.mode}` : '') + (w.name === data.default ? ', default' : '');
    li.append(name, kind);
    if (w.spec.plates) {
      const load = document.createElement('button');
      load.type = 'button';
      load.textContent = 'Load';
      load.title = "Load this world's settings into the form, to change and save back";
      const plates = w.spec.plates;
      load.addEventListener('click', () => {
        config = { ...defaultPlateTerrain(plates.seed), ...plates };
        shape = w.spec.shape ?? 'flat-16x16';
        shapeEl.value = shape;
        editing = { name: w.name, editedChunks: w.editedChunks };
        showForm();
        toHash(config);
        requestPreview();
        showEditing();
        message(`Loaded "${w.name}". Change it and Save to it, or Create new from it.`);
      });
      li.appendChild(load);
    }
    if (canChange && w.name !== data.default) {
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'Delete';
      del.title = 'Delete this world and its edits';
      twoStep(del, 'Sure?', async () => {
        const res = await fetch(`/api/worlds/${encodeURIComponent(w.name)}`, { method: 'DELETE' }).catch((err: Error) => err);
        if (res instanceof Error) return message(`Couldn't reach the server: ${res.message}`, 'bad');
        if (res.status !== 204) return message(await errorOf(res), 'bad');
        if (editing?.name === w.name) editing = null;
        message(`Deleted "${w.name}".`, 'good');
        await loadWorlds();
      });
      li.appendChild(del);
    }
    const play = document.createElement('a');
    play.href = playHref(w.name);
    play.textContent = 'Play';
    li.appendChild(play);
    worldsEl.appendChild(li);
  }
  if (data.worlds.length === 0) worldsEl.innerHTML = '<li><em>none yet</em></li>';
  showEditing();
}

updateEl.addEventListener('click', () => {
  if (!editing) return;
  const edits = editing.editedChunks;
  confirmUpdateText.textContent =
    `Replace the terrain of "${editing.name}" with these settings?` +
    (edits > 0 ? ` Its ${edits} edited chunk${edits === 1 ? '' : 's'} will be discarded (they belong to the old terrain).` : ' It has no edits.') +
    ' Anyone playing it is disconnected.';
  confirmUpdateEl.hidden = false;
});
document.getElementById('update-no')!.addEventListener('click', () => (confirmUpdateEl.hidden = true));
document.getElementById('stop-editing')!.addEventListener('click', () => {
  editing = null;
  showEditing();
  message('');
});
updateYesEl.addEventListener('click', async () => {
  if (!editing) return;
  const name = editing.name;
  updateYesEl.disabled = true;
  try {
    const res = await fetch(`/api/worlds/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plates: config, shape }) });
    if (res.status === 200) {
      message(`Saved "${name}".`, 'good', { href: playHref(name), text: `Play ${name}` });
      await loadWorlds();
    } else {
      message(await errorOf(res), 'bad');
    }
  } catch (err) {
    message(`Couldn't reach the server: ${(err as Error).message}`, 'bad');
  } finally {
    updateYesEl.disabled = false;
    confirmUpdateEl.hidden = true;
  }
});

createEl.addEventListener('click', async () => {
  const name = nameEl.value.trim();
  if (!isValidWorldName(name)) {
    message('Names are 1-64 lower-case letters, digits, "-" or "_", starting with a letter or digit.', 'bad');
    return;
  }
  createEl.disabled = true;
  try {
    const mode = (document.getElementById('new-mode') as HTMLSelectElement).value;
    const res = await fetch('/api/worlds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, plates: config, shape, mode }) });
    if (res.status === 201) {
      message(`Created "${name}" (${mode}).`, 'good', { href: playHref(name), text: `Play ${name}` });
      nameEl.value = '';
      editing = { name, editedChunks: 0 };
      await loadWorlds();
    } else {
      message(await errorOf(res), 'bad');
    }
  } catch (err) {
    message(`Couldn't reach the server: ${(err as Error).message}`, 'bad');
  } finally {
    createEl.disabled = !canChange;
  }
});
nameEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createEl.click();
});

showForm();
toHash(config);
requestPreview();
void loadWorlds();

// ---- The close-up: an area of the world in 3D (see generatorArea.worker.ts), made again as the
//      settings that shape the surface change (the others shape the whole world: the map's).

const cuSizeEl = document.getElementById('cu-size') as HTMLSelectElement;
const cuStepEl = document.getElementById('cu-step') as HTMLSelectElement;
const cuPickEl = document.getElementById('cu-pick') as HTMLButtonElement;
const cuBackEl = document.getElementById('cu-back') as HTMLButtonElement;
const cuFrameEl = document.getElementById('cu-frame')!;
const closeUpNote = document.getElementById('closeup-note')!;
const stage = document.getElementById('stage')!;
const closeUpWorker = new Worker(new URL('./generatorArea.worker.ts', import.meta.url), { type: 'module' });
/** The area shown (its middle, units), while the close-up is; and the diorama, once made. */
let closeUp: { cx: number; cz: number } | null = null;
let diorama: Diorama | null = null;
let picking = false;
let cuSentId = 0;
let mapStale = false;
/** The map's line of stats, to put back when the close-up closes. */
let lastStats = '';
/** Whether the close-up's frame loop is running (see frame). */
let framing = false;
/** The last area shown ("x0,z0,size,step"): the same again keeps the view where it is. */
let shownArea = '';

/** The close-up's size and step between samples (m), as chosen; and roughly how long it takes. */
function cuChoice(): { sizeM: number; stepM: number } {
  return { sizeM: Number(cuSizeEl.value), stepM: Number(cuStepEl.value) };
}

function setPicking(on: boolean): void {
  if (on && !picking) lastStats = statsEl.textContent ?? '';
  if (!on && picking && !closeUp) statsEl.textContent = lastStats;
  picking = on && !closeUp;
  cuPickEl.classList.toggle('on', picking);
  canvas.classList.toggle('picking', picking);
  cuFrameEl.hidden = true;
  if (picking) statsEl.textContent = 'click the map where to look closer (Esc: never mind)';
}
cuPickEl.addEventListener('click', () => setPicking(!picking));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && picking) setPicking(false);
});

/** The world position (units) under the pointer on the map. */
function mapPoint(e: MouseEvent): { x: number; z: number } | null {
  const r = canvas.getBoundingClientRect(), w = WORLD_SHAPES[shape];
  const fx = (e.clientX - r.left) / r.width, fz = (e.clientY - r.top) / r.height;
  if (fx < 0 || fz < 0 || fx > 1 || fz > 1) return null;
  return { x: fx * w.widthUnits, z: fz * w.depthUnits };
}

canvas.addEventListener('mousemove', (e) => {
  if (!picking) return;
  const r = canvas.getBoundingClientRect(), s = stage.getBoundingClientRect(), w = WORLD_SHAPES[shape];
  const side = (cuChoice().sizeM * 16 * r.width) / w.widthUnits;
  Object.assign(cuFrameEl.style, { left: `${e.clientX - s.left - side / 2}px`, top: `${e.clientY - s.top - side / 2}px`, width: `${side}px`, height: `${side}px` });
  cuFrameEl.hidden = false;
});
canvas.addEventListener('mouseleave', () => (cuFrameEl.hidden = true));
canvas.addEventListener('click', (e) => {
  if (!picking) return;
  const p = mapPoint(e);
  if (!p) return;
  setPicking(false);
  openCloseUp(p.x, p.z);
});

function openCloseUp(cx: number, cz: number): void {
  if (!closeUp) lastStats = statsEl.textContent ?? '';
  closeUp = { cx, cz };
  document.body.classList.add('closeup');
  closeUpNote.hidden = false;
  cuPickEl.hidden = true;
  cuBackEl.hidden = false;
  canvas.hidden = true;
  hoverEl.hidden = true;
  if (diorama) diorama.canvas.hidden = false;
  requestCloseUp();
}

function closeCloseUp(): void {
  closeUp = null;
  document.body.classList.remove('closeup');
  closeUpNote.hidden = true;
  cuPickEl.hidden = false;
  cuBackEl.hidden = true;
  canvas.hidden = false;
  hoverEl.hidden = false;
  // (Let go of it: a 4 km close-up at 2 m is millions of faces. Opened again, it's made again.)
  if (diorama) {
    diorama.canvas.remove();
    diorama.dispose();
    diorama = null;
    shownArea = '';
  }
  cuSentId++; // (an answer on its way is dropped)
  if (mapStale) {
    mapStale = false;
    requestPreview();
  } else statsEl.textContent = lastStats;
}
cuBackEl.addEventListener('click', closeCloseUp);

/** Asks for the close-up as the settings are now (the worker answers only the newest). */
function requestCloseUp(): void {
  if (!closeUp) return;
  mapStale = true;
  const w = WORLD_SHAPES[shape], { sizeM, stepM } = cuChoice();
  const size = sizeM * 16, step = stepM * 16;
  // On a whole number of metres, inside the world (round worlds wrap east-west).
  let x0 = Math.round((closeUp.cx - size / 2) / 16) * 16;
  let z0 = Math.round((closeUp.cz - size / 2) / 16) * 16;
  if (!w.wrapX) x0 = Math.max(0, Math.min(w.widthUnits - size, x0));
  else x0 = ((x0 % w.widthUnits) + w.widthUnits) % w.widthUnits;
  z0 = Math.max(0, Math.min(w.depthUnits - size, z0));
  statsEl.className = '';
  // (4 km at 2 m is four times the samples of anything else: about 15 s.)
  const slow = (sizeM / stepM) ** 2 > 2_000_000;
  statsEl.textContent = `making the close-up (${sizeM / 1024} km, a sample every ${stepM} m)…${slow ? ' the finest and biggest: this takes a while' : ''}`;
  const req: CloseUpRequest = { id: ++cuSentId, shape, config, x0, z0, size, step };
  closeUpWorker.postMessage(req);
}
for (const el of [cuSizeEl, cuStepEl]) el.addEventListener('change', () => requestCloseUp());

closeUpWorker.onmessage = (ev: MessageEvent<CloseUpResponse>) => {
  const res = ev.data;
  if (res.id !== cuSentId || !closeUp) return;
  if (!res.ok) {
    statsEl.className = 'bad';
    statsEl.textContent = `close-up failed: ${res.error}`;
    return;
  }
  const t0 = performance.now();
  if (!diorama) {
    diorama = new Diorama(res.climate, res.wrapX, res.seaLevel);
    stage.prepend(diorama.canvas);
    if (!framing) requestAnimationFrame(frame);
    framing = true;
  } else diorama.setClimate(res.climate, res.wrapX);
  diorama.canvas.hidden = false;
  const area = `${res.x0},${res.z0},${res.size},${res.step}`;
  diorama.show(res.parts, res, area === shownArea);
  diorama.setField(res.heights, res.n, res.step, res.x0, res.z0);
  shownArea = area;
  statsEl.textContent = `close-up: ${res.size / 16 / 1024} km at x ${Math.round((res.x0 + res.size / 2) / 16)}, z ${Math.round((res.z0 + res.size / 2) / 16)} m, a sample every ${res.step / 16} m · made in ${(res.ms / 1000).toFixed(1)} s (${Math.round(res.quads / 1000)}k faces), shown in ${Math.round(performance.now() - t0)} ms`;
};
closeUpWorker.onerror = (e) => {
  statsEl.className = 'bad';
  statsEl.textContent = `close-up failed: ${e.message}`;
};

function frame(): void {
  if (diorama && closeUp) diorama.render();
  requestAnimationFrame(frame);
}
