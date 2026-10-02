import { BIOME_GROUND, classifyBiome, sameBiome, type BiomeId, type Ecotone } from './biomes.js';
import type { ClimateGrid } from './climate.js';
import { Material } from './materials.js';
import { canopyOver, treesIn, type Canopy, type Climate, type Clumping, type Tree } from './trees.js';
import { RiverIndex, buildHydrology, carveRivers, type Hydrology } from './rivers.js';
import { NO_WATER } from './water.js';
import { StrokeIndex, applyStrokes, strokesIn, smoothAverage, smoothReach, type SmoothTarget, type TerrainStroke } from './strokes.js';
import { fractalGrid, ridgedGrid, type Octave } from './noise.js';
import type { HeightSource } from './terrain.js';
import type { WorldConfig } from './world.js';

/**
 * Settings chosen when a world is created. The world is divided into
 * tectonic plates: continental plates become land and oceanic plates sea
 * floor. Each plate's relief comes from its own seeded noise field, and
 * neighbouring plates blend smoothly where they meet. Heights are in metres.
 */
export interface PlateTerrainConfig {
  /** Plate layout: positions, sizes, and which plates are continents. */
  seed: number;
  /** Each plate's noise field; change it to reroll the relief and keep the layout. */
  terrainSeed: number;
  /** Large plates that set the continents' overall shapes (1..40). */
  majorPlates: number;
  /** Small plates crowding the seams between the major ones (0..100). */
  minorPlates: number;
  /** Area of a major plate relative to a minor one, e.g. 6 = six times larger (1..50). */
  plateSizeRatio: number;
  /** Deepest sea floor, in metres (-1000..1000, below seaLevel). */
  minHeight: number;
  /** Highest land, in metres (-1000..1000, above seaLevel). */
  maxHeight: number;
  /** The sea's surface, in metres. */
  seaLevel: number;
  /** Share of the world above the sea, 0..100 (exact); the rest is sea. */
  landPercent: number;
  /** How ragged coastlines are, 0 (smooth) .. 100 (heavily broken, many islands). */
  shoreFractal: number;
  /** Sand on gentle coasts: 0 (none above the water) .. 100 (wide beaches). Steep coasts stay rocky. */
  beaches: number;
  /** Bare rock from this height above the sea, in metres (0..2000). */
  rockAltitude: number;
  /** Snow from this height above the sea, in metres (0..2000); a world whose land stays below it has none. */
  snowAltitude: number;
  /** How ragged the snow line is: 0 (a contour line) .. 100 (wanders up to 60 m up and down). */
  snowFractal: number;
  /** Ground steeper than this many degrees is bare rock, snow line or not (5..90; 90 = never). */
  rockSlope: number;
  /** Size of the largest features in each plate's noise, in metres (100..16000). */
  noiseScale: number;
  /** How much fine detail each plate's noise has, 0 (smooth swells) .. 100 (rugged). */
  noiseRoughness: number;
  /** Share of plate seams where plates collide, raising mountain ranges (0..100; 0 = no mountains). */
  mountains: number;
  /** Highest mountain peak, in metres (at least maxHeight, which tops the rest of the land). */
  mountainHeight: number;
  /** Width of a mountain range, in metres (500..8000). */
  mountainWidth: number;
  /** How sharp and ridged mountains are, 0 (rounded massifs) .. 100 (knife-edge ridges). */
  mountainRuggedness: number;
  /** Gullies, spurs and crags on mountain sides (16-256 m across), 0 (smooth flanks) .. 100. */
  mountainDetail: number;
  /** Share of the land that is plains: broad, nearly flat lowlands (0..100, roughly exact). */
  plains: number;
  /** Flattens low ground and concentrates the climb near the peaks, 0 (off) .. 100. */
  lowlandFlatness: number;
  /** Small-scale bumpiness of the ground, 0 (smooth) .. 100; 50 is the original amount. */
  surfaceRoughness: number;
  /** Biomes from climate: 1 on, 0 off (grass everywhere, as before biomes). */
  biomes: number;
  /** Sea-level temperature (degrees C) at the north and south edges of the world. */
  northTemperature: number;
  southTemperature: number;
  /**
   * 1: an equator across the middle of the world at equatorTemperature, cooling toward both
   * edges; 0: temperature runs straight from the north edge to the south edge.
   */
  equator: number;
  equatorTemperature: number;
  /** How much colder it gets with height, degrees C per 100 m (0..5). */
  altitudeCooling: number;
  /** How wet the land is, 0 (dry) .. 100 (soaked); 50 is moderate. */
  rainfall: number;
  /** With biomes: ground colder than this (degrees C) is snow, with a band of bare rock just below on high ground. */
  snowTemperature: number;
  /**
   * With biomes, 1: ground above snowAltitude is snow too, however warm (as without biomes);
   * 0: temperature alone decides (worlds made before this setting).
   */
  altitudeSnow: number;
  /**
   * With biomes, 1: ground above rockAltitude is bare rock too (below any snow), however warm;
   * 0: temperature alone decides (worlds made before this setting).
   */
  altitudeRock: number;
  /**
   * How gradually biomes give way to each other, 0 (sharp borders) .. 100: borders become ragged,
   * trees of neighbouring biomes mix across a band (and forests thin out across it), and ground
   * colours blend.
   */
  biomeBlend: number;
  /** Compass direction rain comes from, degrees (0 north, 90 east, 180 south, 270 west); lands behind mountains from it are drier. */
  windFrom: number;
  /** How many trees, 0 (none) .. 100 (twice the natural density for each biome); 50 is natural. */
  trees: number;
  /** How much trees grow in clumps (groves and glades a few hundred metres across), 0 (evenly) .. 100. */
  treeClumping: number;
  /** Rivers: 0 (none) .. 100 (many small streams); 50 is a network of streams joining into rivers. */
  rivers: number;
  /** Lakes in land basins: 0 (basins are filled in) .. 100 (even small basins hold lakes). */
  lakes: number;
  /** Density of island chains along seams where an oceanic plate meets another plate, 0 (none) .. 100. */
  islandArcs: number;
  /** Groups of islands inside oceanic plates, each a main island trailing smaller ones (0..40). */
  hotspots: number;
  /** Smallest and largest island (diameter, metres, 50..4000), for arcs and hotspots. */
  islandMinSize: number;
  islandMaxSize: number;
}

/**
 * Plate counts for a world: 7 major and 15 minor on 16 x 16 km, more on bigger worlds (growing a
 * little slower than the area, so continents grow too).
 */
export function defaultPlateCounts(world?: WorldConfig): { majorPlates: number; minorPlates: number } {
  const km2 = world ? (world.widthUnits / (1000 * M)) * (world.depthUnits / (1000 * M)) : 256;
  const scale = Math.max(1, (km2 / 256) ** 0.6);
  return { majorPlates: Math.round(7 * scale), minorPlates: Math.round(15 * scale) };
}

/** Default settings (plate counts scaled to `world`'s size, if given). */
export function defaultPlateTerrain(seed = 1, world?: WorldConfig): PlateTerrainConfig {
  return {
    seed,
    terrainSeed: seed,
    ...defaultPlateCounts(world),
    plateSizeRatio: 6,
    minHeight: -300,
    maxHeight: 300,
    seaLevel: 0,
    landPercent: 30,
    shoreFractal: 50,
    beaches: 50,
    rockAltitude: 180,
    snowAltitude: 240,
    snowFractal: 50,
    rockSlope: 25,
    noiseScale: 2000,
    noiseRoughness: 50,
    mountains: 50,
    mountainHeight: 600,
    mountainWidth: 2500,
    mountainRuggedness: 60,
    mountainDetail: 50,
    plains: 0,
    lowlandFlatness: 0,
    surfaceRoughness: 50,
    biomes: 1,
    northTemperature: -8,
    southTemperature: -8,
    equator: 1,
    equatorTemperature: 28,
    altitudeCooling: 1.5,
    rainfall: 50,
    windFrom: 270,
    snowTemperature: -4,
    altitudeSnow: 1,
    altitudeRock: 1,
    biomeBlend: 50,
    trees: 50,
    treeClumping: 60,
    rivers: 50,
    lakes: 50,
    islandArcs: 0,
    hotspots: 0,
    islandMinSize: 200,
    islandMaxSize: 1500,
  };
}

export const PLATE_LIMITS = {
  majorPlates: [1, 80],
  minorPlates: [0, 200],
  plateSizeRatio: [1, 50],
  height: [-1000, 1000],
  landPercent: [0, 100],
  shoreFractal: [0, 100],
  beaches: [0, 100],
  altitude: [0, 2000],
  rockSlope: [5, 90],
  snowFractal: [0, 100],
  noiseScale: [100, 16000],
  noiseRoughness: [0, 100],
  mountains: [0, 100],
  mountainWidth: [500, 8000],
  mountainRuggedness: [0, 100],
  mountainDetail: [0, 100],
  plains: [0, 100],
  lowlandFlatness: [0, 100],
  surfaceRoughness: [0, 100],
  temperature: [-30, 40],
  altitudeCooling: [0, 5],
  rainfall: [0, 100],
  windFrom: [0, 360],
  biomeBlend: [0, 100],
  trees: [0, 100],
  treeClumping: [0, 100],
  rivers: [0, 100],
  lakes: [0, 100],
  islandArcs: [0, 100],
  hotspots: [0, 40],
  islandSize: [50, 4000],
} as const;

/**
 * Plate settings from untrusted input (e.g. a JSON request): known settings are taken from
 * `raw`, missing ones get their defaults, anything else is dropped. Throws RangeError if a
 * setting is invalid.
 */
export function parsePlateTerrain(raw: unknown): PlateTerrainConfig {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const seed = typeof r.seed === 'number' ? r.seed : 1;
  const out: Record<string, unknown> = { ...defaultPlateTerrain(seed) };
  for (const key of Object.keys(out)) if (r[key] !== undefined) out[key] = r[key];
  const config = out as unknown as PlateTerrainConfig;
  validatePlateTerrain(config);
  return config;
}

/**
 * Plate settings saved by an older version, brought up to date so the world looks as it did:
 * `waterPercent` becomes `landPercent`; rock and snow, which started at 60% and 80% of the land's
 * height range (or `rockLine` percent), get those heights in metres; steep ground turned to rock
 * above slope 0.9 (42 degrees), along a plain contour; there were no mountains, biomes or trees
 * (and trees, once there were, were spread evenly), biome borders were sharp, there were no rivers
 * or lakes, and with biomes the snow and rock altitudes didn't count. Other missing settings get their defaults.
 */
export function migratePlateTerrain(raw: unknown): PlateTerrainConfig {
  const r = { ...((typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>) };
  if (r.landPercent === undefined && typeof r.waterPercent === 'number') r.landPercent = 100 - r.waterPercent;
  const d = defaultPlateTerrain();
  const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback);
  const range = num(r.maxHeight, d.maxHeight) - num(r.seaLevel, d.seaLevel);
  if (r.rockAltitude === undefined) r.rockAltitude = (num(r.rockLine, 60) / 100) * range;
  if (r.snowAltitude === undefined) r.snowAltitude = 0.8 * range;
  if (r.rockSlope === undefined) r.rockSlope = 42;
  if (r.snowFractal === undefined) r.snowFractal = 0;
  if (r.biomes === undefined) r.biomes = 0;
  if (r.trees === undefined) r.trees = 0;
  // Trees were spread evenly.
  if (r.treeClumping === undefined) r.treeClumping = 0;
  if (r.biomeBlend === undefined) r.biomeBlend = 0;
  if (r.rivers === undefined) r.rivers = 0;
  // Before equators, temperature ran from the north edge to the south edge (then -6 and 26 C).
  if (r.equator === undefined) {
    r.equator = 0;
    if (r.northTemperature === undefined) r.northTemperature = -6;
    if (r.southTemperature === undefined) r.southTemperature = 26;
  }
  if (r.lakes === undefined) r.lakes = 0;
  // With biomes, the snow and rock altitudes didn't count (temperature alone decided).
  if (r.altitudeSnow === undefined) r.altitudeSnow = 0;
  if (r.altitudeRock === undefined) r.altitudeRock = 0;
  // Worlds from before the current mountains have none. (The first plate worlds saved a
  // `mountainHeight` that meant something else, possibly below maxHeight: replace it.)
  if (r.mountains === undefined) {
    r.mountains = 0;
    r.mountainHeight = Math.max(num(r.maxHeight, d.maxHeight), d.mountainHeight);
  }
  return parsePlateTerrain(r);
}

export function validatePlateTerrain(c: PlateTerrainConfig): void {
  const int = (v: number, lo: number, hi: number, name: string) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${name} must be an integer ${lo}..${hi}; got ${v}`);
  };
  const num = (v: number, [lo, hi]: readonly [number, number], name: string, unit = '') => {
    if (typeof v !== 'number' || !(v >= lo && v <= hi)) throw new RangeError(`${name} must be ${lo}..${hi}${unit}; got ${v}`);
  };
  const L = PLATE_LIMITS;
  int(c.seed, -(2 ** 31), 2 ** 31 - 1, 'seed');
  int(c.terrainSeed, -(2 ** 31), 2 ** 31 - 1, 'terrainSeed');
  int(c.majorPlates, ...L.majorPlates, 'majorPlates');
  int(c.minorPlates, ...L.minorPlates, 'minorPlates');
  num(c.plateSizeRatio, L.plateSizeRatio, 'plateSizeRatio');
  num(c.minHeight, L.height, 'minHeight', ' m');
  num(c.maxHeight, L.height, 'maxHeight', ' m');
  num(c.seaLevel, L.height, 'seaLevel', ' m');
  if (!(c.minHeight + 1 <= c.seaLevel)) throw new RangeError(`minHeight must be at least 1 m below seaLevel; got ${c.minHeight} and ${c.seaLevel}`);
  if (!(c.seaLevel + 1 <= c.maxHeight)) throw new RangeError(`maxHeight must be at least 1 m above seaLevel; got ${c.maxHeight} and ${c.seaLevel}`);
  num(c.landPercent, L.landPercent, 'landPercent');
  num(c.shoreFractal, L.shoreFractal, 'shoreFractal');
  num(c.beaches, L.beaches, 'beaches');
  num(c.rockAltitude, L.altitude, 'rockAltitude', ' m');
  num(c.snowAltitude, L.altitude, 'snowAltitude', ' m');
  num(c.rockSlope, L.rockSlope, 'rockSlope', ' degrees');
  num(c.snowFractal, L.snowFractal, 'snowFractal');
  num(c.noiseScale, L.noiseScale, 'noiseScale', ' m');
  num(c.noiseRoughness, L.noiseRoughness, 'noiseRoughness');
  num(c.mountains, L.mountains, 'mountains', '%');
  num(c.mountainHeight, L.height, 'mountainHeight', ' m');
  if (!(c.mountainHeight >= c.maxHeight)) throw new RangeError(`mountainHeight must be at least maxHeight; got ${c.mountainHeight} and ${c.maxHeight}`);
  num(c.mountainWidth, L.mountainWidth, 'mountainWidth', ' m');
  num(c.mountainRuggedness, L.mountainRuggedness, 'mountainRuggedness');
  num(c.mountainDetail, L.mountainDetail, 'mountainDetail');
  num(c.plains, L.plains, 'plains', '%');
  num(c.lowlandFlatness, L.lowlandFlatness, 'lowlandFlatness');
  num(c.surfaceRoughness, L.surfaceRoughness, 'surfaceRoughness');
  if (c.biomes !== 0 && c.biomes !== 1) throw new RangeError(`biomes must be 0 or 1; got ${c.biomes}`);
  num(c.northTemperature, L.temperature, 'northTemperature', ' degrees C');
  num(c.southTemperature, L.temperature, 'southTemperature', ' degrees C');
  if (c.equator !== 0 && c.equator !== 1) throw new RangeError(`equator must be 0 or 1; got ${c.equator}`);
  num(c.equatorTemperature, L.temperature, 'equatorTemperature', ' degrees C');
  num(c.altitudeCooling, L.altitudeCooling, 'altitudeCooling', ' degrees C per 100 m');
  num(c.rainfall, L.rainfall, 'rainfall');
  num(c.windFrom, L.windFrom, 'windFrom', ' degrees');
  num(c.snowTemperature, L.temperature, 'snowTemperature', ' degrees C');
  if (c.altitudeSnow !== 0 && c.altitudeSnow !== 1) throw new RangeError(`altitudeSnow must be 0 or 1; got ${c.altitudeSnow}`);
  if (c.altitudeRock !== 0 && c.altitudeRock !== 1) throw new RangeError(`altitudeRock must be 0 or 1; got ${c.altitudeRock}`);
  num(c.biomeBlend, L.biomeBlend, 'biomeBlend');
  num(c.trees, L.trees, 'trees');
  num(c.treeClumping, L.treeClumping, 'treeClumping');
  num(c.rivers, L.rivers, 'rivers');
  num(c.lakes, L.lakes, 'lakes');
  num(c.islandArcs, L.islandArcs, 'islandArcs');
  int(c.hotspots, ...L.hotspots, 'hotspots');
  num(c.islandMinSize, L.islandSize, 'islandMinSize', ' m');
  num(c.islandMaxSize, L.islandSize, 'islandMaxSize', ' m');
  if (!(c.islandMinSize <= c.islandMaxSize)) throw new RangeError(`islandMinSize must not exceed islandMaxSize; got ${c.islandMinSize} and ${c.islandMaxSize}`);
}

/** Coarse grid cell (units): 32 m. Heights between cells are interpolated. */
export const PLATE_CELL = 512;
const M = 16; // units per metre
/** Largest small-scale roughness (units), on the highest ground; the least, on low ground. */
const DETAIL_MAX = 6 * M;
const DETAIL_MIN = 0.4 * M;
/**
 * Beaches: sand reaches up to BEACH_MAX (at beaches = 100) above the sea where the coast is no
 * steeper than GENTLE (rise over run, over 64 m), tapering to none at STEEP; coasts steeper than
 * ROCKY are bare rock from ROCKY_BELOW under the water to ROCKY_ABOVE over it. Coastal slopes at
 * the default settings run ~0.04-0.15 (median 0.07), so at a median coast a 4 m beach is ~50 m
 * wide; slopes grow with the height range, giving more rock and less sand.
 */
const BEACH_MAX = 8 * M;
const GENTLE = 0.07;
const STEEP = 0.14;
const ROCKY = 0.13;
const ROCKY_ABOVE = 4 * M;
const ROCKY_BELOW = 4 * M;
/** Land rises to its full relief over this distance from the sea; the sea floor deepens over this distance from land. */
const INLAND = 1500 * M;
const OFFSHORE = 1500 * M;
/** Neighbouring plates' relief blends over this distance either side of their seam. */
const SEAM_BLEND = 400 * M;
/** Centre and stretch for mountain-side ridged noise (its mean, and ~1 / its spread). */
const CRAG_MEAN = 0.59;
const CRAG_STRETCH = 3.5;
/** Moisture falls from the coast inland over about this distance. */
const MOISTURE_INLAND = 2000 * M;
/** Rain shadow: how far upwind to look for mountains, and the barrier height that dries out the lee fully. */
const SHADOW_REACH = 3000 * M;
const SHADOW_FULL = 250 * M;
/** How far the snow line wanders up and down (units) at snowFractal = 100. */
const SNOW_FRACTAL_MAX = 60 * M;
/**
 * Polar ice on round worlds: within ICE_BAND of the north and south edges (wobbling by +-30%),
 * ice rising from a low shelf (ICE_SHELF above the sea) to a wall ICE_WALL high at the edge.
 */
const ICE_BAND = 700 * M;
const ICE_SHELF = 3 * M;
const ICE_WALL = 70 * M;

/** With biomes: how far the snow temperature wanders (degrees C) at snowFractal = 100. */
const SNOW_FRACTAL_DEGREES = 2;
/**
 * At biomeBlend = 100: how far (+-) local noise shifts the climate biomes are classified from,
 * making borders ragged (degrees C, moisture); and the ecotone, the band across which
 * neighbouring biomes' trees and colours mix.
 */
const RAGGED_DEGREES = 4;
const RAGGED_MOISTURE = 0.12;
const ECOTONE_DEGREES = 6;
const ECOTONE_MOISTURE = 0.2;
/** With biomes: bare rock below the snow, this many degrees warmer, on ground this high above the sea. */
const ROCK_BAND_DEGREES = 1.5;
const ROCK_BAND_MIN_HEIGHT = 100 * M;
/** Strongest mountain-side detail (amplitude, units) at mountainDetail = 100, on the most mountainous ground. */
const MOUNTAIN_DETAIL_MAX = 60 * M;
/** Plains sit at this fraction of the smoothed land around them (lowland basins). */
const PLAIN_LEVEL = 0.35;
/**
 * Water bodies smaller than this many grid cells (~1 km^2) that lie more than INLAND_LAKE from
 * open sea (bodies at least this big) are filled in as land.
 */
const MIN_LAKE = 1000;
const INLAND_LAKE = 700 * M;
/** Plate noise stops at this feature size; smaller detail is added per column. */
/** Samples look up the strokes reaching them in squares this wide (units): small, since a drag leaves many strokes close together. */
const STROKE_CELL = 32 * M;

/** A smooth stroke's targets on a grid `step` units apart over it, `n` by `n` (NaN: not worked out yet). */
interface SmoothGrid {
  stroke: TerrainStroke;
  /** The stroke's place in the strokes. */
  order: number;
  /** The grid's corner (units). */
  x0: number;
  z0: number;
  step: number;
  n: number;
  values: Float64Array;
}

const NOISE_FINEST = 64 * M;

export interface Plate {
  x: number;
  z: number;
  major: boolean;
  /** Power-diagram weight (units^2), tuned so plate areas match plateSizeRatio. */
  weight: number;
  continental: boolean;
}

export interface Island {
  x: number;
  z: number;
  radius: number;
  kind: 'arc' | 'hotspot';
}

/** Small deterministic PRNG. */
function rng(seed: number): () => number {
  let a = (Math.imul(seed | 0, 0x9e3779b1) ^ 0x6d2b79f5) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A build stopped after making a stage (see PlateStageCache.pauseAfterEach). */
export class PlateStagePause extends Error {
  constructor(readonly stage: string) {
    super(`paused after the ${stage} stage`);
  }
}

/**
 * The stages of the last PlateHeights build (plate layout, mountains, relief, coasts, heights,
 * terraforming strokes, climate, rivers), each with the settings it was made from: a build given the cache reuses every
 * stage whose settings haven't changed. For the generator's preview, rebuilt on every change;
 * results are shared between builds, so nothing may change them.
 */
export class PlateStageCache {
  private readonly stages = new Map<string, { key: string; value: unknown }>();
  /**
   * Stop a build (throwing PlateStagePause) after each stage it makes, so a caller can see
   * whether it's still wanted between stages; building again picks up where it stopped.
   */
  pauseAfterEach = false;

  get<T>(stage: string, key: string, make: () => T): T {
    const kept = this.stages.get(stage);
    if (kept && kept.key === key) {
      this.hits++;
      return kept.value as T;
    }
    const value = make();
    this.stages.set(stage, { key, value });
    if (this.pauseAfterEach) throw new PlateStagePause(stage);
    return value;
  }

  /** How many stages have been reused, all told (for tests). */
  hits = 0;
}

/**
 * Plate-tectonic heights. Everything is decided once, on a 32 m grid, at
 * construction (a few hundred milliseconds); `heights` then interpolates that
 * grid and adds small-scale roughness, so chunk generation stays fast.
 * On wrapping worlds everything is periodic in X.
 */
export class PlateHeights implements HeightSource {
  /** Sea level, lowest and highest ground (units). */
  readonly seaLevel: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  /** Tallest beach (units above the sea) on the gentlest coasts. */
  private readonly beachHeight: number;
  /** Noise varying beaches along a coast. */
  private readonly beachNoise: Octave[];
  /** Climate per grid cell: sea-level temperature (degrees C) and moisture (0..1); null without biomes. */
  readonly temperature: Float32Array | null;
  readonly moisture: Float32Array | null;
  private readonly cooling: number;
  private readonly snowTemp: number;
  private readonly treeDensity: number;
  private readonly treeSeed: number;
  /** Groves and glades (see Clumping). */
  private readonly clumps: Clumping;
  /** Fractal noise moving the snow line up and down, and how far (units). */
  private readonly snowNoise: Octave[];
  private readonly snowWander: number;
  /** Biome borders: how far noise shifts the climate (0: sharp), and the ecotone trees mix across. */
  private readonly ragged: Ecotone;
  private readonly raggedNoise: [Octave[], Octave[]];
  readonly ecotone: Ecotone;
  /** Heights (units) where bare rock and snow start, and the slope (rise over run) beyond which ground is rock. */
  private readonly rockLine: number;
  private readonly snowLine: number;
  /** With biomes: whether ground above the snow line is snow too (see altitudeSnow). */
  private readonly altitudeSnow: boolean;
  /** With biomes: whether ground above the rock line is bare rock too (see altitudeRock). */
  private readonly altitudeRock: boolean;
  private readonly rockSlope: number;
  readonly cols: number;
  readonly rows: number;
  /** Surface height per grid cell (units). */
  readonly elevation: Float32Array;
  /** Plate index per grid cell. */
  readonly plateOf: Uint16Array;
  /** 0..1 per grid cell: how high the ground is within its range (drives roughness). */
  private readonly rough: Float32Array;
  /** 0..1 per grid cell: how mountainous (drives mountain-side detail); 0 off the ranges. */
  private readonly mountainness: Float32Array;
  /** Ridged octaves for mountain-side detail, and its strength (units). */
  private readonly crags: Octave[];
  private readonly cragAmp: number;
  readonly plates: readonly Plate[];
  /** Islands placed by arcs and hotspots (centres and radii in units). */
  readonly islands: readonly Island[];
  /** Grid cells that are island land. */
  readonly islandCells: number;
  /** Pairs of plates whose seam raises a range: between continents, or coastal (ocean under continent). */
  readonly collisions: readonly { plates: readonly [number, number]; kind: 'continental' | 'coastal' }[];
  /** Per grid cell: 0 (hills) .. 1 (plain); 0 everywhere without plains. */
  readonly plainness: Float32Array;
  /** Noise for the polar ice's edge and surface (round worlds), or null without polar ice. */
  private readonly ice: { edge: Octave[]; surface: Octave[] } | null;
  /** Rivers and lakes (null without either). */
  readonly hydrology: Hydrology | null;
  private readonly rivers: RiverIndex | null;
  /** The last block of ground and water sampled (heights, materials and water ask for the same ones). */
  private lastSurface: { key: string; heights: Int32Array; water: Int32Array | null } | null = null;
  private readonly detail: Octave[];
  /** Terraforming strokes (see strokes.ts), and the grid samples start from: without the strokes, which samples apply exactly. */
  private strokes: readonly TerrainStroke[];
  private strokeIndex: StrokeIndex | null;
  /**
   * Each stroke's place in `strokes`; the raises, lowers and levels by where they reach (smooth
   * only looks at those); and each smooth stroke's targets (see smoothTarget).
   */
  private strokeOrder = new Map<TerrainStroke, number>();
  private shapeIndex: StrokeIndex | null = null;
  private smoothGrids = new Map<TerrainStroke, SmoothGrid>();

  /**
   * What smooth stroke `s` pulls (x, z) toward: the average of the land's shape around it (the
   * raises, lowers and levels before `s` on the broad land; see smoothAverage). Worked out on a
   * grid over the stroke, finer than the average's reach, as needed, and blended between (the
   * average changes little over that distance): working it out at every point is far too slow.
   */
  private readonly smoothTarget: SmoothTarget = (x, z, s) => {
    let g = this.smoothGrids.get(s);
    if (!g) {
      const R = s.radius * M, step = Math.max(2 * M, smoothReach(s) / 5), n = Math.ceil((2 * R) / step) + 2;
      g = { stroke: s, order: this.strokeOrder.get(s) ?? Infinity, x0: s.x * M - R, z0: s.z * M - R, step, n, values: new Float64Array(n * n).fill(NaN) };
      this.smoothGrids.set(s, g);
    }
    let dx = x - g.x0;
    if (this.wrap) {
      const W = this.world.widthUnits, R = s.radius * M;
      dx -= Math.round((dx - R) / W) * W;
    }
    const n = g.n;
    const fu = Math.max(0, Math.min(n - 1.001, dx / g.step)), fv = Math.max(0, Math.min(n - 1.001, (z - g.z0) / g.step));
    const i = Math.floor(fu), j = Math.floor(fv), tu = fu - i, tv = fv - j;
    const a = this.smoothAt(g, i, j), b = this.smoothAt(g, i + 1, j), c = this.smoothAt(g, i, j + 1), d = this.smoothAt(g, i + 1, j + 1);
    const top = a + (b - a) * tu;
    return top + (c + (d - c) * tu - top) * tv;
  };

  /** A smooth stroke's target at its grid point (i, j), worked out the first time it's wanted. */
  private smoothAt(g: SmoothGrid, i: number, j: number): number {
    const k = i + g.n * j;
    const v = g.values[k]!;
    if (!Number.isNaN(v)) return v;
    return (g.values[k] = smoothAverage(g.stroke, g.x0 + i * g.step, g.z0 + j * g.step, (px, pz) => this.shapeBefore(px, pz, g.order)));
  }

  /** The land's shape at (x, z) (units): the broad land with the raises, lowers and levels before stroke number `order`. */
  private shapeBefore(x: number, z: number, order: number): number {
    const base = this.gridAt(this.sampleBase, x, z);
    if (!this.shapeIndex) return base;
    // The strokes reaching here, in order: those before `order` come first.
    const all = this.shapeIndex.at(x, z);
    let m = 0;
    while (m < all.length && this.strokeOrder.get(all[m]!)! < order) m++;
    return m ? applyStrokes(m === all.length ? all : all.slice(0, m), x, z, base, base, this.seaLevel, this.wrap ? this.world.widthUnits : null).broad : base;
  }

  /** Indexes `strokes` for sampling (see strokeIndex, strokeOrder, shapeIndex). */
  private indexStrokes(strokes: readonly TerrainStroke[]): void {
    const W = this.wrap ? this.world.widthUnits : null;
    // Smooth targets stay right for strokes before which nothing changed.
    const old = this.strokes ?? [];
    let same = 0;
    while (same < strokes.length && same < old.length && strokes[same] === old[same]) same++;
    const kept = new Map<TerrainStroke, SmoothGrid>();
    for (let k = 0; k < same; k++) {
      const g = this.smoothGrids.get(strokes[k]!);
      if (g) kept.set(strokes[k]!, g);
    }
    this.smoothGrids = kept;
    this.strokes = strokes;
    this.strokeIndex = strokes.length ? new StrokeIndex(strokes, W, STROKE_CELL) : null;
    this.strokeOrder = new Map(strokes.map((t, i) => [t, i]));
    const shaping = strokes.filter((t) => t.kind !== 'smooth');
    this.shapeIndex = shaping.length ? new StrokeIndex(shaping, W, STROKE_CELL) : null;
    this.lastSurface = null;
  }
  private readonly sampleBase: Float32Array;
  /** How low and high strokes may take the ground (units): inside the world, with room for trees. */
  private readonly lowest: number;
  private readonly highest: number;
  /** Multiplier on small-scale roughness (surfaceRoughness / 50). */
  private readonly detailScale: number;
  private readonly wrap: boolean;

  constructor(
    readonly world: WorldConfig,
    readonly config: PlateTerrainConfig,
    /** Stages kept from earlier builds, to reuse (for previews, rebuilt on every change). */
    cache?: PlateStageCache,
    /** Terraforming: hand-made changes to the ground, applied in order (see strokes.ts). */
    strokes: readonly TerrainStroke[] = [],
  ) {
    validatePlateTerrain(config);
    const sea = (this.seaLevel = Math.round(config.seaLevel * M));
    const lo = (this.minHeight = Math.round(config.minHeight * M));
    const hi = Math.round(config.maxHeight * M);
    // With mountains, the peaks top out at mountainHeight; the rest of the land at maxHeight.
    const top = (this.maxHeight = config.mountains > 0 ? Math.round(config.mountainHeight * M) : hi);
    this.beachHeight = (config.beaches / 100) * BEACH_MAX;
    this.rockLine = sea + config.rockAltitude * M;
    this.snowLine = sea + config.snowAltitude * M;
    this.altitudeSnow = config.altitudeSnow === 1;
    this.altitudeRock = config.altitudeRock === 1;
    this.rockSlope = Math.tan((config.rockSlope * Math.PI) / 180);
    if (world.widthUnits % PLATE_CELL || world.depthUnits % PLATE_CELL) {
      throw new RangeError(`world size must be a multiple of ${PLATE_CELL} units`);
    }
    if (world.minYUnits >= lo || world.maxYUnits <= top) throw new RangeError("plate terrain doesn't fit the world's Y range");
    this.wrap = world.wrapX;
    this.lowest = world.minYUnits + 16 * M;
    this.highest = world.maxYUnits - 64 * M;
    const cols = (this.cols = world.widthUnits / PLATE_CELL);
    const rows = (this.rows = world.depthUnits / PLATE_CELL);
    const n = cols * rows;
    const W = world.widthUnits, D = world.depthUnits;
    // Each stage below depends on the settings in its key (and the stages before it). With a
    // cache, a stage whose key hasn't changed since the last build reuses that build's result.
    const memo = <T>(stage: string, key: readonly unknown[], make: () => T): T => (cache ? cache.get(stage, JSON.stringify(key), make) : make());
    const cf = config;
    const layoutKey = [W, D, this.wrap, cf.seed, cf.majorPlates, cf.minorPlates, cf.plateSizeRatio];
    const mountainKey = [...layoutKey, cf.landPercent, cf.mountains, cf.mountainWidth, cf.mountainRuggedness];
    const reliefKey = [...layoutKey, cf.terrainSeed, cf.noiseScale, cf.noiseRoughness];
    const coastKey = [...reliefKey, cf.landPercent, cf.shoreFractal, cf.islandArcs, cf.hotspots, cf.islandMinSize, cf.islandMaxSize];
    const heightKey = [...coastKey, ...mountainKey, cf.lowlandFlatness, cf.plains, cf.seaLevel, cf.minHeight, cf.maxHeight, cf.mountainHeight];
    // Strokes change the ground under the climate and the rivers.
    const strokesKey = JSON.stringify(strokes);
    const climateKey = [...heightKey, strokesKey, cf.biomes, cf.northTemperature, cf.southTemperature, cf.equator, cf.equatorTemperature, cf.windFrom, cf.rainfall];
    const hydrologyKey = [...(cf.biomes === 1 ? climateKey : heightKey), strokesKey, cf.biomes, cf.rivers, cf.lakes];
    // On a wrapping world each octave's lattice must tile the width exactly.
    const fit = (spacing: number) => (this.wrap ? W / Math.max(1, Math.round(W / spacing)) : spacing);
    const octaves = (seed: number, spacings: number[], persistence = 0.5): Octave[] =>
      spacings.map((s, k) => {
        const spacing = fit(s);
        return { spacing, weight: persistence ** k, periodX: this.wrap ? Math.round(W / spacing) : 0, seed: seed * 101 + k };
      });
    /** Noise over a block of grid cells, normalized to about -1..1. */
    const gridNoise = (os: Octave[], c0 = 0, r0 = 0, w = cols, d = rows) => {
      const raw = fractalGrid(os, c0 * PLATE_CELL + PLATE_CELL / 2, r0 * PLATE_CELL + PLATE_CELL / 2, w, d, PLATE_CELL);
      const norm = 2 / os.reduce((a, o) => a + o.weight, 0);
      return raw.map((v) => v * norm);
    };
    const layoutNoise = (k: number, spacings: number[], persistence = 0.5) => gridNoise(octaves(config.seed * 7919 + k, spacings, persistence));
    const dx = (a: number, b: number) => {
      let d = b - a;
      if (this.wrap) d -= Math.round(d / W) * W;
      return d;
    };
    const at = (c: number, r: number) => {
      if (this.wrap) c = ((c % cols) + cols) % cols;
      return c < 0 || c >= cols || r < 0 || r >= rows ? -1 : c + cols * r;
    };

    const distTo = (p: { x: number; z: number }, c: { x: number; z: number }) => Math.hypot(dx(p.x, c.x), p.z - c.z);
    const layout = memo('layout', layoutKey, () => {
      const rand = rng(config.seed);
      // 1. Major plates: centres spread out (each the best of several random candidates).
      const plates: Plate[] = [];
      const majorCount = config.majorPlates;
      for (let i = 0; i < majorCount; i++) {
        let best = { x: 0, z: 0 }, bestScore = -Infinity;
        for (let t = 0; t < 12; t++) {
          const c = { x: rand() * W, z: rand() * D };
          const sc = plates.reduce((m, p) => Math.min(m, distTo(p, c)), Infinity);
          if (sc > bestScore) [best, bestScore] = [c, sc];
        }
        plates.push({ ...best, major: true, weight: 0, continental: false });
      }

      // 2. Cells are assigned at warped positions, so borders wander (but never by more than about
      //    half a minor plate, or small plates fall apart).
      const minorArea = (W * D) / (majorCount * config.plateSizeRatio + config.minorPlates);
      const minorRadius = Math.sqrt(minorArea / Math.PI);
      const warpX = layoutNoise(1, [64000, 32000, 16000]);
      const warpZ = layoutNoise(2, [64000, 32000, 16000]);
      const WARP = Math.min(900 * M, 0.5 * minorRadius);
      const posX = new Float64Array(n), posZ = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const c = i % cols, r = (i - c) / cols;
        posX[i] = (c + 0.5) * PLATE_CELL + warpX[i]! * WARP;
        posZ[i] = (r + 0.5) * PLATE_CELL + warpZ[i]! * WARP;
      }
      // On worlds bigger than 16 x 16 km, major plates are big enough that their straight borders
      // (and the coasts that follow them) show: bend them at their own scale too.
      if (n > 250_000) {
        const majorRadius = Math.sqrt((minorArea * config.plateSizeRatio) / Math.PI);
        const spacings = [4 * majorRadius, 2 * majorRadius, majorRadius];
        const bigX = layoutNoise(3, spacings), bigZ = layoutNoise(4, spacings);
        for (let i = 0; i < n; i++) {
          posX[i]! += bigX[i]! * 0.45 * majorRadius;
          posZ[i]! += bigZ[i]! * 0.45 * majorRadius;
        }
      }
      const power = (p: Plate, x: number, z: number) => {
        const ddx = dx(p.x, x), ddz = p.z - z;
        return ddx * ddx + ddz * ddz - p.weight;
      };
      // Majors form a power diagram: nearest centre by d^2 - weight. Its borders are straight lines,
      // and the distance to the border with major b is exactly (power_b - power_a) / (2 |a - b|).
      const pd = new Float64Array(majorCount);
      const majorAt = (x: number, z: number) => {
        let a = 0;
        for (let k = 0; k < majorCount; k++) {
          pd[k] = power(plates[k]!, x, z);
          if (pd[k]! < pd[a]!) a = k;
        }
        let seam = Infinity;
        for (let b = 0; b < majorCount; b++) {
          if (b !== a) seam = Math.min(seam, (pd[b]! - pd[a]!) / (2 * Math.max(1, distTo(plates[a]!, plates[b]!))));
        }
        return { a, seam };
      };
      // Once placed, minors join the majors in one power diagram, so every border is a straight
      // line (before warping) and minors are polygons like the majors, only smaller.
      const owner = (x: number, z: number, withMinors: boolean) => {
        let best = 0, bestD = Infinity;
        const count = withMinors ? plates.length : majorCount;
        for (let k = 0; k < count; k++) {
          const d = power(plates[k]!, x, z);
          if (d < bestD) [best, bestD] = [k, d];
        }
        return best;
      };

      // Plate sizes are tuned on a coarse grid. Each round measures every plate's area and moves
      // its weight toward its target, with a per-plate step size (as in Rprop): halved when the
      // plate overshoots (its error changes sign), otherwise grown, so plates far off converge fast.
      // Coarse grid stride (cells): 4 up to 16 x 16 km, wider on bigger worlds so there are about as
      // many samples (the cost is samples x plates x rounds).
      const S = Math.max(4, Math.round(4 * Math.sqrt(n / 250_000)));
      const sample: number[] = [];
      for (let r = S >> 1; r < rows; r += S) for (let c = S >> 1; c < cols; c += S) sample.push(c + cols * r);
      const cellArea = (S * PLATE_CELL) ** 2;
      const balance = (target: number[], rounds: number, withMinors: boolean) => {
        const count = target.length;
        const area = new Float64Array(count);
        const gain = new Float64Array(count).fill(0.6);
        const lastErr = new Float64Array(count);
        for (let iter = 0; iter < rounds; iter++) {
          area.fill(0);
          for (const i of sample) area[owner(posX[i]!, posZ[i]!, withMinors)]!++;
          let mean = 0;
          for (let k = 0; k < count; k++) {
            const err = target[k]! - area[k]!;
            if (err * lastErr[k]! < 0) gain[k]! *= 0.5;
            else gain[k] = Math.min(20, gain[k]! * 1.2);
            lastErr[k] = err;
            // Raising a region's weight by w grows its area by roughly w * pi.
            plates[k]!.weight += ((err * cellArea) / Math.PI) * gain[k]!;
            mean += plates[k]!.weight;
          }
          // Only differences between weights matter.
          mean /= count;
          for (let k = 0; k < count; k++) plates[k]!.weight -= mean;
        }
      };

      // 3. Majors alone, balanced to equal sizes, give the seams the minors are placed on.
      balance(new Array<number>(majorCount).fill(sample.length / majorCount), 40, false);
      // Seam samples: within about half a coarse cell of a border between majors.
      const seamSamples = sample.filter((i) => majorAt(posX[i]!, posZ[i]!).seam < (S * PLATE_CELL) / 2);
      const parent: number[] = plates.map((_, k) => k);
      /** A cell's warped position as a plate centre: inside the world (wrapped east-west if it wraps). */
      const centreAt = (i: number) => ({
        x: this.wrap ? ((posX[i]! % W) + W) % W : Math.min(W, Math.max(0, posX[i]!)),
        z: Math.min(D, Math.max(0, posZ[i]!)),
      });
      for (let m = 0; m < config.minorPlates; m++) {
        // Each minor goes on a seam, spaced from the minors already placed (the best of several
        // random points), so they spread along all the seams instead of bunching. Once the seams are
        // crowded (no seam point is two minor radii clear), minors spill inland, nearest the seams.
        let best = centreAt(sample[0]!), bestScore = -Infinity;
        for (let t = 0; t < 24; t++) {
          const pool = t % 2 === 0 && seamSamples.length > 0 ? seamSamples : sample;
          const c = centreAt(pool[Math.floor(rand() * pool.length)]!);
          let clear = 2 * minorRadius;
          for (let k = majorCount; k < plates.length; k++) clear = Math.min(clear, distTo(plates[k]!, c));
          const seam = Math.min(majorAt(c.x, c.z).seam, 4 * minorRadius);
          const score = clear - 0.25 * seam;
          if (score > bestScore) [best, bestScore] = [c, score];
        }
        const { x, z } = best;
        const home = majorAt(x, z).a;
        // A new minor starts with the weight of the major it sits on, and grows to its target.
        plates.push({ x, z, major: false, weight: plates[home]!.weight, continental: false });
        parent.push(home);
      }

      // 4. Majors and minors together: minors carve their share out of the majors along the seams.
      const unit = sample.length / (majorCount * config.plateSizeRatio + config.minorPlates);
      balance(plates.map((p) => (p.major ? config.plateSizeRatio : 1) * unit), 80, true);
      const plateOf = new Uint16Array(n);
      for (let i = 0; i < n; i++) plateOf[i] = owner(posX[i]!, posZ[i]!, true);

      // For step 5 (below, which depends on the land share): each major's area with its minors,
      // and the random order they're tried in.
      const area = new Array<number>(plates.length).fill(0);
      for (const p of plateOf) area[p]!++;
      const familyArea = new Array<number>(majorCount).fill(0);
      plates.forEach((_, k) => (familyArea[parent[k]!]! += area[k]!));
      // Fisher-Yates with the seeded PRNG: identical on every JS engine.
      const order = Array.from({ length: majorCount }, (_, k) => k);
      for (let k = order.length - 1; k > 0; k--) {
        const j = Math.floor(rand() * (k + 1));
        [order[k], order[j]] = [order[j]!, order[k]!];
      }
      // 6. Distance from every cell to its plate's border (cells).
      const toSeam = new Float32Array(n).fill(Infinity);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = c + cols * r;
          for (const [a, b] of [[1, 0], [0, 1]] as const) {
            const j = at(c + a, r + b);
            if (j >= 0 && plateOf[j] !== plateOf[i]) toSeam[i] = toSeam[j] = 0.5;
          }
        }
      }
      chamfer(toSeam, cols, rows, this.wrap);
      return { plates, parent, plateOf, familyArea, order, toSeam };
    });
    // Copies: which plates are continental is decided here, per land share.
    const plates: Plate[] = layout.plates.map((p) => ({ ...p }));
    this.plates = plates;
    const { parent, plateOf, familyArea, order, toSeam } = layout;
    this.plateOf = plateOf;
    const majorCount = config.majorPlates;
    // 5. Continental major plates, in random order, until continents (majors plus the minors
    //    on their side of the seams) cover a bit more than the land share. Minor plates take the
    //    crust type of the major they sit on. (The exact coastline comes from the sea level below.)
    const continentalMajor = new Array<boolean>(majorCount).fill(false);
    let covered = 0;
    const landTarget = (config.landPercent / 100) * n * 1.02;
    for (const k of order) {
      if (covered >= landTarget) break;
      continentalMajor[k] = true;
      covered += familyArea[k]!;
    }
    plates.forEach((p, k) => (p.continental = continentalMajor[parent[k]!]!));

    // 6b. Mountains: each plate drifts; where two plates converge and at least one is continental
    //     they raise a range (a broad one centred on the seam between continents, a coastal one
    //     set back inland where ocean dives under a continent, with a trench offshore). `uplift`
    //     (0..1, land) and `trench` (0..1, sea) are applied with the heights below.
    const mountains = memo('mountains', mountainKey, () => {
      const uplift = new Float32Array(n);
      const trench = new Float32Array(n);
      const collisions = new Map<string, { plates: [number, number]; kind: 'continental' | 'coastal' }>();
      if (config.mountains > 0 && plates.length > 1) {
        const mrand = rng(config.seed ^ 0x51ed270b);
        const drift = plates.map(() => {
          const a = mrand() * Math.PI * 2, speed = 0.5 + 0.5 * mrand();
          return { vx: Math.cos(a) * speed, vz: Math.sin(a) * speed };
        });
        // Distance to the nearest seam and the plate across it.
        const dist = new Float32Array(n).fill(Infinity);
        const across = new Int32Array(n).fill(-1);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const i = c + cols * r;
            for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              const j = at(c + a, r + b);
              if (j >= 0 && plateOf[j] !== plateOf[i]) {
                dist[i] = 0.5;
                across[i] = plateOf[j]!;
              }
            }
          }
        }
        chamferLabel(dist, across, cols, rows, this.wrap);
        /** How fast plates k and q close on each other across their seam (> 0 converging). */
        const closing = (k: number, q: number) => {
          const p = plates[k]!, o = plates[q]!;
          const nx = dx(p.x, o.x), nz = o.z - p.z, len = Math.hypot(nx, nz) || 1;
          return ((drift[k]!.vx - drift[q]!.vx) * nx + (drift[k]!.vz - drift[q]!.vz) * nz) / len;
        };
        // The colliding seams: of the converging seams with a continental side, the fastest-closing
        // `mountains` percent (by length).
        const seamClosing: number[] = [];
        for (let i = 0; i < n; i++) {
          if (dist[i] !== 0.5) continue;
          const k = plateOf[i]!, q = across[i]!, cv = closing(k, q);
          if (cv > 0 && (plates[k]!.continental || plates[q]!.continental)) seamClosing.push(cv);
        }
        const cutoff = seamClosing.length > 0 ? quantile(Float32Array.from(seamClosing), 1 - config.mountains / 100) : Infinity;
        const W = (config.mountainWidth * M) / PLATE_CELL; // range width in cells
        // A range's cross-section: a smooth bump exactly W wide (t = distance from its crest over
        // half the width), so ranges stay bands along their seams rather than covering whole plates.
        const g = (t: number) => (Math.abs(t) >= 1 ? 0 : (1 - t * t) ** 2);
        for (let i = 0; i < n; i++) {
          const q = across[i]!;
          if (q < 0) continue;
          const k = plateOf[i]!;
          const cv = closing(k, q);
          if (!(cv > cutoff)) continue;
          const d = dist[i]!;
          const here = plates[k]!.continental, there = plates[q]!.continental;
          const pair = k < q ? `${k},${q}` : `${q},${k}`;
          if (!collisions.has(pair)) collisions.set(pair, { plates: k < q ? [k, q] : [q, k], kind: here && there ? 'continental' : 'coastal' });
          if (here && there) uplift[i] = g(d / (W / 2));
          else if (here) uplift[i] = g((d - W * 0.45) / (W / 2)); // coastal range, inland of the seam
          else if (there) trench[i] = g(d / (W / 3)); // trench on the ocean side
        }
        // Ranges vary in height along their length and fade out at their ends (blurred, so a range
        // doesn't stop dead where its seam meets a quieter one).
        const R = Math.max(1, Math.round(W / 6));
        const smoothed = blur(blur(uplift, cols, rows, R, this.wrap), cols, rows, R, this.wrap);
        const along = layoutNoise(23, [Math.max(4000, config.mountainWidth * M * 3), Math.max(2000, config.mountainWidth * M * 1.5)]);
        // Ridged noise: sharp crests and V-shaped valleys.
        const rugged = config.mountainRuggedness / 100;
        const ridgeSpacing = Math.max(64 * M, (config.mountainWidth * M) / 2);
        const ridgeOctaves = octaves(config.seed * 7919 + 29, [ridgeSpacing, ridgeSpacing / 2, ridgeSpacing / 4, ridgeSpacing / 8].filter((sp) => sp >= 48 * M), 0.4 + 0.3 * rugged);
        const ridged = ridgedGrid(ridgeOctaves, PLATE_CELL / 2, PLATE_CELL / 2, cols, rows, PLATE_CELL);
        const ridgeAmount = 0.25 + 0.65 * rugged;
        for (let i = 0; i < n; i++) {
          const u = smoothed[i]! * (0.65 + 0.35 * along[i]!);
          uplift[i] = Math.max(0, u * (1 - ridgeAmount + ridgeAmount * ridged[i]!));
        }
        const tr = blur(trench, cols, rows, Math.max(1, Math.round(W / 8)), this.wrap);
        trench.set(tr);
      }
      return { uplift, trench, collisions: [...collisions.values()] };
    });
    const { uplift, trench } = mountains;
    this.collisions = mountains.collisions;

    // 7. Each plate's relief: its own noise field (seeded from terrainSeed and the plate's index),
    //    with a per-plate bias (some plates sit higher than others) and strength.
    const relief = memo('relief', reliefKey, () => {
      const persistence = 0.3 + 0.5 * (config.noiseRoughness / 100);
      const spacings: number[] = [];
      for (let s = config.noiseScale * M; spacings.length === 0 || s >= NOISE_FINEST; s /= 2) spacings.push(s);
      const trand = rng(config.terrainSeed ^ 0x5bd1e995);
      const relief = new Float32Array(n);
      const box = plates.map(() => ({ c0: cols, c1: -1, r0: rows, r1: -1 }));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const b = box[plateOf[c + cols * r]!]!;
          b.c0 = Math.min(b.c0, c); b.c1 = Math.max(b.c1, c); b.r0 = Math.min(b.r0, r); b.r1 = Math.max(b.r1, r);
        }
      }
      plates.forEach((_, k) => {
        const bias = (trand() * 2 - 1) * 0.35;
        const strength = 0.6 + trand() * 0.4;
        const b = box[k]!;
        if (b.c1 < 0) return; // swallowed by its neighbours
        const w = b.c1 - b.c0 + 1, d = b.r1 - b.r0 + 1;
        const field = gridNoise(octaves(config.terrainSeed * 7919 + (k + 1) * 104729, spacings, persistence), b.c0, b.r0, w, d);
        // Standardize the field (a sum of many octaves is flatter than a few), so the noise
        // settings change the relief's character rather than just its amplitude.
        let sum = 0, sq = 0;
        for (const v of field) { sum += v; sq += v * v; }
        const mu = sum / field.length, sd = Math.sqrt(Math.max(1e-12, sq / field.length - mu * mu));
        for (let r = b.r0; r <= b.r1; r++) {
          for (let c = b.c0; c <= b.c1; c++) {
            const i = c + cols * r;
            if (plateOf[i] === k) relief[i] = bias + strength * ((field[c - b.c0 + w * (r - b.r0)]! - mu) / sd) * 0.33;
          }
        }
      });
      // Blend across seams: near a border, fade into the smoothed field, which mixes both sides.
      {
        const R = Math.max(1, Math.round(SEAM_BLEND / PLATE_CELL / 2));
        const smooth = blur(blur(relief, cols, rows, R, this.wrap), cols, rows, R, this.wrap);
        const band = SEAM_BLEND / PLATE_CELL;
        for (let i = 0; i < n; i++) {
          const t = 1 - smoothstep(0, band, toSeam[i]!);
          relief[i] = relief[i]! + (smooth[i]! - relief[i]!) * t;
        }
      }
      return relief;
    });

    // Steps 8 to 11: where the coasts are.
    const coast = memo('coast', coastKey, () => {
      // 8. Where land and sea fall: crust type (smoothed, so plate borders aren't straight coasts),
      //    a continent-scale swell, and the plates' relief.
      let base: Float32Array = new Float32Array(n);
      for (let i = 0; i < n; i++) base[i] = plates[plateOf[i]!]!.continental ? 1 : -1;
      base = blur(blur(base, cols, rows, 9, this.wrap), cols, rows, 9, this.wrap);
      const swell = layoutNoise(7, [64000, 32000, 16000]);
      const land = new Float32Array(n);
      for (let i = 0; i < n; i++) land[i] = base[i]! * 0.5 + swell[i]! * 0.3 + relief[i]! * 0.35;

      // 9. Shoreline fractalization: multi-scale noise (0 = none) in a band ~700 m either side of the
      //    waterline it would otherwise have, so interiors stay solid. Finer octaves weigh nearly as
      //    much as coarse ones, so coasts break up rather than just shift.
      const shore = layoutNoise(3, [16000, 8000, 4000, 2000, 1000, 512], 0.8);
      const shoreAmp = (config.shoreFractal / 100) * 2;
      const water = 1 - config.landPercent / 100;
      const tau0 = quantile(land, water);
      const toShore = new Float32Array(n).fill(Infinity);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = c + cols * r;
          const wet = land[i]! <= tau0;
          for (const [a, b] of [[1, 0], [0, 1]] as const) {
            const j = at(c + a, r + b);
            if (j >= 0 && (land[j]! <= tau0) !== wet) toShore[i] = toShore[j] = 0;
          }
        }
      }
      chamfer(toShore, cols, rows, this.wrap);
      const BAND = (700 * M) / PLATE_CELL;
      for (let i = 0; i < n; i++) land[i] = land[i]! + shore[i]! * shoreAmp * 0.5 * (1 - smoothstep(0, BAND, toShore[i]!));

      // 10. Islands in open water: arcs along seams where an oceanic plate meets another, and
      //     hotspot chains inside oceanic plates. Their own random stream, so turning them on or off
      //     leaves everything above unchanged.
      const islands: Island[] = [];
      const island = new Float32Array(n); // 1 - distance/radius inside an island, else 0
      const islandSize = new Float32Array(n); // island radius / 1 km (its peak's height scale)
      let islandCells = 0;
      if (config.islandArcs > 0 || config.hotspots > 0) {
        const irand = rng(config.seed ^ 0x2c1b3c6d);
        const tau1 = quantile(land, water);
        // Distance (cells) from each sea cell to the coast it would have without islands.
        const toCoast = new Float32Array(n).fill(Infinity);
        for (let i = 0; i < n; i++) if (land[i]! > tau1) toCoast[i] = 0;
        chamfer(toCoast, cols, rows, this.wrap);
        const budget = 0.9 * (config.landPercent / 100) * n;
        const minR = (config.islandMinSize / 2) * M, maxR = (config.islandMaxSize / 2) * M;
        // Log-uniform sizes, `bias` > 1 favouring small ones.
        const size = (bias: number) => minR * (maxR / minR) ** (irand() ** bias);
        // Island coasts: island-scale noise (250 m down to 32 m), more ragged with shoreFractal.
        const coastNoise = layoutNoise(11, [4000, 2000, 1000, 512], 0.7);
        const jag = 0.3 + 0.5 * (config.shoreFractal / 100);
        const COAST_GAP = 300 * M, ISLAND_GAP = 150 * M;
        const cellOf = (x: number, z: number) => {
          const c = Math.floor((((x % W) + W) % W) / PLATE_CELL), r = Math.floor(z / PLATE_CELL);
          return c >= 0 && c < cols && r >= 0 && r < rows ? c + cols * r : -1;
        };
        /** Whether an island of radius R fits at (x, z): in open water, clear of coasts and other islands. */
        const clearance = (x: number, z: number, R: number) => {
          const i = cellOf(x, z);
          if (i < 0 || (!this.wrap && (x < R || x > W - R)) || z < R || z > D - R) return -Infinity;
          if (land[i]! > tau1) return -Infinity;
          let room = toCoast[i]! * PLATE_CELL - R - COAST_GAP;
          for (const o of islands) room = Math.min(room, distTo(o, { x, z }) - o.radius - R - ISLAND_GAP);
          return room;
        };
        /**
         * Stamps an island of about radius R (an ellipse of the same area, stretched up to 2.2x
         * along `angle`, with up to two smaller lobes); false, and nothing stamped, if it would
         * overrun the land budget.
         */
        const stamp = (x: number, z: number, R: number, kind: Island['kind'], angle = irand() * Math.PI) => {
          const aspect = 1 + irand() * 1.2;
          const parts = [{ x, z, a: R * Math.sqrt(aspect), b: R / Math.sqrt(aspect), angle }];
          for (let k = Math.floor(irand() * 3); k > 0; k--) {
            const dir = irand() * Math.PI * 2, off = R * (0.5 + 0.4 * irand()), r2 = R * (0.35 + 0.25 * irand());
            parts.push({ x: x + Math.cos(dir) * off, z: z + Math.sin(dir) * off, a: r2, b: r2, angle: 0 });
          }
          const reach = Math.ceil((R * 2.2) / PLATE_CELL);
          const c0 = Math.floor(x / PLATE_CELL), r0 = Math.floor(z / PLATE_CELL);
          const cells: [number, number][] = [];
          for (let r = r0 - reach; r <= r0 + reach; r++) {
            for (let c = c0 - reach; c <= c0 + reach; c++) {
              const i = at(c, r);
              if (i < 0) continue;
              const px = (c + 0.5) * PLATE_CELL, pz = (r + 0.5) * PLATE_CELL;
              let t = Infinity;
              for (const q of parts) {
                const ddx = dx(q.x, px), ddz = pz - q.z;
                const u = ddx * Math.cos(q.angle) + ddz * Math.sin(q.angle), v = -ddx * Math.sin(q.angle) + ddz * Math.cos(q.angle);
                t = Math.min(t, Math.hypot(u / q.a, v / q.b));
              }
              t += coastNoise[i]! * jag;
              if (t < 1) cells.push([i, 1 - t]);
            }
          }
          const fresh = cells.filter(([i]) => island[i] === 0).length;
          if (fresh === 0 || islandCells + fresh > budget) return false;
          for (const [i, v] of cells) {
            island[i] = Math.max(island[i]!, v);
            islandSize[i] = Math.max(islandSize[i]!, R / (1000 * M));
          }
          islandCells += fresh;
          islands.push({ x, z, radius: R, kind });
          return true;
        };
        /** The best of several random candidates from `pick`, by room to spare; null if none fits. */
        const bestSpot = (pick: () => number, R: number, tries: number) => {
          let best: { x: number; z: number } | null = null, bestRoom = 0;
          for (let t = 0; t < tries; t++) {
            const i = pick();
            if (i < 0) continue;
            const c = i % cols, r = (i - c) / cols;
            const p = { x: (c + irand()) * PLATE_CELL, z: (r + irand()) * PLATE_CELL };
            const room = clearance(p.x, p.z, R);
            if (room >= 0 && (best === null || room > bestRoom)) [best, bestRoom] = [p, room];
          }
          return best;
        };

        // Hotspots: a main island in an oceanic plate, trailing 2-5 smaller ones in the direction
        // its plate has carried them (the same for every chain on a plate).
        const oceanic: number[] = [];
        for (let i = 0; i < n; i++) if (!plates[plateOf[i]!]!.continental && land[i]! <= tau1) oceanic.push(i);
        const drift = plates.map(() => irand() * Math.PI * 2);
        for (let h = 0; h < config.hotspots && oceanic.length > 0; h++) {
          let R = size(1);
          const at0 = bestSpot(() => oceanic[Math.floor(irand() * oceanic.length)]!, R, 20);
          if (!at0) continue;
          const a = drift[plateOf[cellOf(at0.x, at0.z)]!]!;
          if (!stamp(at0.x, at0.z, R, 'hotspot', a)) continue;
          let { x, z } = at0;
          const trail = 2 + Math.floor(irand() * 4);
          for (let k = 0; k < trail; k++) {
            const r2 = R * (0.5 + 0.2 * irand());
            if (r2 < minR) break;
            const turn = a + (irand() - 0.5) * 0.5, gap = R + r2 + ISLAND_GAP + irand() * R;
            const nx = x + Math.cos(turn) * gap, nz = z + Math.sin(turn) * gap;
            if (clearance(nx, nz, r2) < 0 || !stamp(nx, nz, r2, 'hotspot', turn)) break;
            [x, z, R] = [nx, nz, r2];
          }
        }

        // Island arcs: along seams where at least one side is oceanic, ~800 m apart at 100, each
        // stretched along its seam (perpendicular to the line between the two plates' centres).
        const seams: number[] = [];
        const seamAngle = new Map<number, number>();
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const i = c + cols * r;
            if (toSeam[i]! > 1 || land[i]! > tau1) continue;
            const j = at(c + 1, r), k = at(c, r + 1);
            const across = [j, k].find((q) => q >= 0 && plateOf[q] !== plateOf[i]);
            if (across === undefined) continue;
            const p = plates[plateOf[i]!]!, q = plates[plateOf[across]!]!;
            if (p.continental && q.continental) continue;
            seams.push(i);
            seamAngle.set(i, Math.atan2(q.z - p.z, dx(p.x, q.x)) + Math.PI / 2);
          }
        }
        // Seam cells come in pairs (one each side), each ~1 cell of seam length.
        const arcCount = Math.round((config.islandArcs / 100) * ((seams.length / 2) * PLATE_CELL) / (800 * M));
        for (let k = 0; k < arcCount && seams.length > 0; k++) {
          const R = size(1.6);
          const spot = bestSpot(() => seams[Math.floor(irand() * seams.length)]!, R, 8);
          if (spot) stamp(spot.x, spot.z, R, 'arc', seamAngle.get(cellOf(spot.x, spot.z)) ?? irand() * Math.PI);
        }
      }

      // 11. The waterline: continents get exactly the land left after the islands (the quantile of
      //     the other cells that leaves that many above the sea). Then small lakes away from the sea
      //     are filled in: all water sits at sea level and land rises with distance from any water,
      //     so an inland pond would be a hole to sea level in a crater ~1.5 km wide. (Lagoons and
      //     inlets near the coast stay.) To keep the land share exact, as many of
      //     the lowest coastal cells (next to real sea) go under water instead; water added next to
      //     other water can only join bodies, never make a new pond.
      let tau: number;
      if (islandCells === 0) {
        tau = quantile(land, water);
      } else {
        const rest = new Float32Array(n - islandCells);
        let m = 0;
        for (let i = 0; i < n; i++) if (island[i] === 0) rest[m++] = land[i]!;
        tau = quantile(rest, 1 - ((config.landPercent / 100) * n - islandCells) / rest.length);
      }
      const state = new Uint8Array(n); // 0 by the waterline, 1 forced land, 2 forced sea
      const byWaterline = (i: number) => island[i]! > 0 || land[i]! > tau;
      const ponds = inlandLakes((i) => !byWaterline(i), MIN_LAKE, INLAND_LAKE / PLATE_CELL, cols, rows, this.wrap);
      for (const i of ponds) state[i] = 1;
      const isLand = (i: number) => state[i] === 1 || (state[i] === 0 && byWaterline(i));
      for (let owed = ponds.length; owed > 0; ) {
        // Continental coast cells (not islands, not filled ponds) next to sea, lowest first.
        const coast: number[] = [];
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const i = c + cols * r;
            if (state[i] !== 0 || island[i]! > 0 || !isLand(i)) continue;
            if ([at(c + 1, r), at(c - 1, r), at(c, r + 1), at(c, r - 1)].some((j) => j >= 0 && !isLand(j))) coast.push(i);
          }
        }
        if (coast.length === 0) break;
        coast.sort((p, q) => land[p]! - land[q]! || p - q);
        for (const i of coast.slice(0, owed)) state[i] = 2;
        owed -= Math.min(owed, coast.length);
      }
      const toSea = new Float32Array(n).fill(Infinity);
      const toLand = new Float32Array(n).fill(Infinity);
      for (let i = 0; i < n; i++) (isLand(i) ? toLand : toSea)[i] = 0;
      chamfer(toSea, cols, rows, this.wrap);
      chamfer(toLand, cols, rows, this.wrap);
      const landMask = new Uint8Array(n);
      for (let i = 0; i < n; i++) landMask[i] = isLand(i) ? 1 : 0;
      return { island, islandSize, islands, islandCells, landMask, toSea, toLand };
    });
    const { island, islandSize, toSea, toLand, landMask } = coast;
    this.islands = coast.islands;
    this.islandCells = coast.islandCells;
    const isLand = (i: number) => landMask[i] === 1;

    // 12. Heights: land rises from the coast inland, following its plate's relief; the sea floor
    //    deepens away from land the same way. Both are stretched so the highest land is exactly
    //    maxHeight and the deepest sea floor exactly minHeight.
    // Relief as 0..1, ignoring the most extreme 0.5% at either end so a few outliers don't flatten the rest.
    const shaped = memo('heights', heightKey, () => {
      const rMin = quantile(relief, 0.005), rMax = quantile(relief, 0.995);
      const r01 = (v: number) => Math.min(1, Math.max(0, (v - rMin) / Math.max(1e-6, rMax - rMin)));
      const shape = new Float32Array(n);
      // Lowland flatness: a height curve that keeps low ground low and flat.
      const curve = 1 + 2 * (config.lowlandFlatness / 100);
      let landMax = 0, seaMax = 0;
      for (let i = 0; i < n; i++) {
        if (isLand(i)) {
          let s = smoothstep(0, INLAND / PLATE_CELL, toSea[i]!) ** 0.7 * (0.15 + 0.85 * r01(relief[i]!));
          // Islands also rise to a peak in the middle (volcanic), lower for small ones.
          if (island[i]! > 0) s = Math.max(s, 0.45 * island[i]! ** 1.3 * Math.min(1, islandSize[i]!));
          if (curve !== 1) s **= curve;
          shape[i] = s;
          landMax = Math.max(landMax, s);
        }
      }
      // Plains: regions a few km across (from large-scale noise, the lowest `plains` percent of it
      // over land) where the land is replaced by a heavily smoothed, lowered copy of itself, so
      // hills melt into broad lowlands and wide valley floors; their edges blend over ~1 km.
      const plainness = new Float32Array(n);
      if (config.plains > 0) {
        const mask = layoutNoise(17, [64000, 32000, 16000], 0.45);
        const landMask: number[] = [];
        for (let i = 0; i < n; i++) if (isLand(i)) landMask.push(mask[i]!);
        const t = quantile(Float32Array.from(landMask), config.plains / 100);
        const EDGE = 0.35; // in mask units: the blend from hills to plain
        const R = Math.round((400 * M) / PLATE_CELL);
        const smooth = blur(blur(shape, cols, rows, R, this.wrap), cols, rows, R, this.wrap); // sea counts as 0
        for (let i = 0; i < n; i++) {
          if (!isLand(i)) continue;
          const w = 1 - smoothstep(t - EDGE / 2, t + EDGE / 2, mask[i]!);
          plainness[i] = w;
          shape[i] = shape[i]! + (PLAIN_LEVEL * smooth[i]! - shape[i]!) * w;
        }
        landMax = 0;
        for (let i = 0; i < n; i++) if (isLand(i)) landMax = Math.max(landMax, shape[i]!);
      }
      for (let i = 0; i < n; i++) {
        if (!isLand(i)) {
          let s = smoothstep(0, OFFSHORE / PLATE_CELL, toLand[i]!) ** 0.8 * (0.3 + 0.7 * (1 - r01(relief[i]!)));
          // Trenches off coastal ranges deepen the sea floor (toward the deepest).
          if (trench[i]! > 0) s += (1.2 - s) * trench[i]! * smoothstep(0, (300 * M) / PLATE_CELL, toLand[i]!);
          shape[i] = s;
          seaMax = Math.max(seaMax, s);
        }
      }
      const elevation = new Float32Array(n);
      const rough = new Float32Array(n);
      const mountainness = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        if (isLand(i)) {
          const f = shape[i]! / Math.max(1e-6, landMax);
          elevation[i] = Math.max(sea + 1, sea + (hi - sea) * f);
          // Small-scale roughness grows with height, and fades on plains.
          rough[i] = f * (1 - 0.85 * plainness[i]!);
        }
      }
      // Mountains rise on top of the land, from ~700 m inland of any coast, scaled so the highest
      // peak is exactly the mountain height.
      if (top > hi) {
        const lift: number[] = [];
        for (let i = 0; i < n; i++) {
          if (!isLand(i) || uplift[i]! <= 0) continue;
          const u = uplift[i]! * smoothstep(0, (700 * M) / PLATE_CELL, toSea[i]!);
          if (u > 1e-4) lift.push(i, u);
        }
        if (lift.length > 0) {
          const peak = (k: number) => {
            let m = -Infinity;
            for (let j = 0; j < lift.length; j += 2) m = Math.max(m, elevation[lift[j]!]! + k * lift[j + 1]!);
            return m;
          };
          let kLo = 0, kHi = 1;
          while (peak(kHi) < top) kHi *= 2;
          for (let it = 0; it < 50; it++) {
            const mid = (kLo + kHi) / 2;
            if (peak(mid) < top) kLo = mid;
            else kHi = mid;
          }
          let uMax = 0;
          for (let j = 1; j < lift.length; j += 2) uMax = Math.max(uMax, lift[j]!);
          for (let j = 0; j < lift.length; j += 2) {
            const i = lift[j]!, u = lift[j + 1]!;
            elevation[i] = Math.min(top, elevation[i]! + kLo * u);
            rough[i] = Math.max(rough[i]!, u / uMax);
            mountainness[i] = u / uMax;
          }
          // Land the very top exactly on the mountain height.
          let best = -1;
          for (let j = 0; j < lift.length; j += 2) if (best < 0 || elevation[lift[j]!]! > elevation[best]!) best = lift[j]!;
          elevation[best] = top;
        }
      }
      for (let i = 0; i < n; i++) {
        if (isLand(i)) continue;
        const f = shape[i]! / Math.max(1e-6, seaMax);
        elevation[i] = Math.min(sea - 1, sea - (sea - lo) * f);
        rough[i] = 0;
      }
      return { elevation, rough, mountainness, plainness };
    });
    // Terraforming, on the grid: what the climate and rivers see (each stroke at each cell's
    // centre). Samples get the strokes exactly (see groundHeights), so they're also kept apart
    // (`delta`), to be taken back out of the grid there.
    this.strokes = strokes;
    this.strokeIndex = null;
    this.indexStrokes(strokes);
    const stroked = memo('strokes', [...heightKey, strokesKey], () => {
      if (strokes.length === 0) return { elevation: shaped.elevation, delta: null };
      const e = shaped.elevation.slice();
      const W0 = this.wrap ? W : null;
      for (const s of strokes) {
        const r = s.radius * M;
        const c0 = Math.floor((s.x * M - r) / PLATE_CELL), c1 = Math.ceil((s.x * M + r) / PLATE_CELL);
        const r0 = Math.max(0, Math.floor((s.z * M - r) / PLATE_CELL)), r1 = Math.min(rows - 1, Math.ceil((s.z * M + r) / PLATE_CELL));
        for (let rr = r0; rr <= r1; rr++) {
          for (let cc = this.wrap ? c0 : Math.max(0, c0); cc <= (this.wrap ? c1 : Math.min(cols - 1, c1)); cc++) {
            const i = at(cc, rr);
            if (i < 0) continue;
            // (Smooth averages the grid as shaped so far around the cell.)
            const v = applyStrokes([s], (cc + 0.5) * PLATE_CELL, (rr + 0.5) * PLATE_CELL, e[i]!, e[i]!, sea, W0, (x, z, t) => smoothAverage(t, x, z, (px, pz) => this.gridAt(e, px, pz))).ground;
            e[i] = Math.max(this.lowest, Math.min(this.highest, v));
          }
        }
      }
      const delta = new Float32Array(n);
      for (let i = 0; i < n; i++) delta[i] = e[i]! - shaped.elevation[i]!;
      return { elevation: e, delta };
    });
    const elevation = stroked.elevation;
    this.rough = shaped.rough;
    this.mountainness = shaped.mountainness;
    this.plainness = shaped.plainness;

    // 13. Climate, for biomes. Sea-level temperature runs from the north edge to the south edge,
    //     wandering a few degrees; moisture is high by the sea, drops inland, and drops more in the
    //     rain shadow behind mountains (seen from the wind's direction).
    this.cooling = (config.altitudeCooling / 100) / M; // degrees C per unit of height
    this.snowTemp = config.snowTemperature;
    this.treeDensity = config.trees;
    // Groves and glades from ~400 m down to ~100 m across.
    this.clumps = { octaves: octaves(config.terrainSeed * 7919 + 83, [6144, 3072, 1536], 0.6), amount: config.treeClumping };
    this.treeSeed = config.terrainSeed * 7919 + 47;
    const climate = memo('climate', climateKey, () => {
      if (config.biomes !== 1) return { temp: null, wet: null };
      const temp = new Float32Array(n);
      const wet = new Float32Array(n);
      const tNoise = layoutNoise(41, [96000, 48000, 24000]);
      const mNoise = layoutNoise(43, [64000, 32000, 16000, 8000], 0.55);
      for (let r = 0; r < rows; r++) {
        const lat = (r + 0.5) / rows; // 0 north .. 1 south
        // With an equator: from the nearer edge's temperature up to the equator's at the middle.
        const t0 = config.equator
          ? (lat < 0.5 ? config.northTemperature : config.southTemperature) + (config.equatorTemperature - (lat < 0.5 ? config.northTemperature : config.southTemperature)) * (1 - Math.abs(lat - 0.5) * 2)
          : config.northTemperature + (config.southTemperature - config.northTemperature) * lat;
        for (let c = 0; c < cols; c++) {
          const i = c + cols * r;
          temp[i] = t0 + 4 * tNoise[i]!;
        }
      }
      const a = (config.windFrom * Math.PI) / 180; // compass: 0 = from north (-z), 90 = from east (+x)
      const ux = Math.sin(a), uz = -Math.cos(a); // unit step toward where the wind comes from
      const steps = 12, stepLen = SHADOW_REACH / steps / PLATE_CELL;
      const rainScale = config.rainfall / 50;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = c + cols * r;
          const coast = 0.1 + 0.8 * Math.exp(-(toSea[i]! * PLATE_CELL) / MOISTURE_INLAND);
          // The highest ground upwind, above this cell, within reach.
          let barrier = 0;
          const here = Math.max(sea, elevation[i]!);
          for (let k = 1; k <= steps; k++) {
            const j = at(Math.round(c + ux * stepLen * k), Math.round(r + uz * stepLen * k));
            if (j < 0) break;
            barrier = Math.max(barrier, elevation[j]! - here);
          }
          const shadow = smoothstep(30 * M, SHADOW_FULL, barrier);
          wet[i] = Math.min(1, Math.max(0, (coast * (1 - 0.65 * shadow) + 0.3 * mNoise[i]!) * rainScale));
        }
      }
      return { temp, wet };
    });
    this.temperature = climate.temp;
    this.moisture = climate.wet;

    // Small-scale roughness down to 1 m (also hides the 32 m grid's facets).
    this.detail = octaves(config.terrainSeed * 7919 + 5, [512, 256, 128, 64, 32, 16]);
    this.detailScale = config.surfaceRoughness / 50;
    // Mountain sides: ridged noise from 256 m down to 16 m (gullies, spurs, crags).
    this.crags = octaves(config.seed * 7919 + 31, [4096, 2048, 1024, 512, 256], 0.55);
    this.cragAmp = (config.mountainDetail / 100) * MOUNTAIN_DETAIL_MAX;
    // Beaches come and go along a coast over a few hundred metres.
    this.beachNoise = octaves(config.terrainSeed * 7919 + 13, [8192, 4096, 2048]);
    // The snow line wanders at every scale from ~1 km down to 16 m.
    this.snowNoise = octaves(config.terrainSeed * 7919 + 37, [16384, 8192, 4096, 2048, 1024, 512, 256], 0.65);
    this.snowWander = (config.snowFractal / 100) * SNOW_FRACTAL_MAX;
    // Biome borders wander at every scale from ~1 km down to 16 m.
    const blend = config.biomes === 1 ? config.biomeBlend / 100 : 0;
    this.ragged = { degrees: blend * RAGGED_DEGREES, moisture: blend * RAGGED_MOISTURE };
    this.ecotone = { degrees: blend * ECOTONE_DEGREES, moisture: blend * ECOTONE_MOISTURE };
    const borders = [16384, 8192, 4096, 2048, 1024, 512, 256];
    this.raggedNoise = [octaves(config.terrainSeed * 7919 + 53, borders, 0.75), octaves(config.terrainSeed * 7919 + 59, borders, 0.75)];

    // Polar ice at the north and south edges of round worlds (the edges you can't go past).
    this.ice = this.wrap ? { edge: octaves(config.terrainSeed * 7919 + 67, [32768, 16384, 8192, 4096], 0.5), surface: octaves(config.terrainSeed * 7919 + 71, [2048, 1024, 512, 256], 0.5) } : null;

    // 14. Rivers and lakes: water drains toward the sea; basins become lakes or are filled in,
    //     and rivers run where enough water gathers (more in wetter country).
    //     Basins that don't become lakes are filled in: on a copy of the heights, which stay as
    //     they were for the stages above.
    const water = memo('hydrology', hydrologyKey, () => {
      if (config.rivers <= 0 && config.lakes <= 0) return { elevation, hydrology: null, rivers: null };
      const filled = elevation.slice();
      const hydrology = buildHydrology({
        elevation: filled, cols, rows, cell: PLATE_CELL, sea, wrap: this.wrap,
        wetness: this.moisture, rivers: config.rivers, lakes: config.lakes, seed: config.terrainSeed * 7919 + 61,
      });
      return { elevation: filled, hydrology, rivers: hydrology.segments.length ? new RiverIndex(hydrology.segments, W, this.wrap) : null };
    });
    this.elevation = water.elevation;
    if (stroked.delta) {
      const base = new Float32Array(n);
      for (let i = 0; i < n; i++) base[i] = water.elevation[i]! - stroked.delta[i]!;
      this.sampleBase = base;
    } else this.sampleBase = water.elevation;
    this.hydrology = water.hydrology;
    this.rivers = water.rivers;
  }

  /**
   * For previews while shaping: samples apply these strokes instead of the ones the world was
   * built with, exactly as built ones would be (any list: the ground comes out as a world built
   * with them would have it, away from rivers and lakes), but the grid under the climate, rivers
   * and lakes stays as built: those only follow the new strokes once the world is built with them.
   */
  setSampleStrokes(strokes: readonly TerrainStroke[]): void {
    this.indexStrokes(strokes);
  }

  /** Fraction of grid cells above sea level (for tests and tools). */
  landFraction(): number {
    let land = 0;
    for (const h of this.elevation) if (h > this.seaLevel) land++;
    return land / this.elevation.length;
  }

  /** The plate under a point (units). */
  plateAt(x: number, z: number): number {
    let c = Math.floor(x / PLATE_CELL);
    if (this.wrap) c = ((c % this.cols) + this.cols) % this.cols;
    c = Math.max(0, Math.min(this.cols - 1, c));
    const r = Math.max(0, Math.min(this.rows - 1, Math.floor(z / PLATE_CELL)));
    return this.plateOf[c + this.cols * r]!;
  }

  /**
   * Bilinear interpolation weights for a run of positions along one axis:
   * lower/upper cell indices and the blend factor, clamped (or wrapped) to the grid.
   */
  /** A grid field at one point (units), interpolated as `interpolate` does. */
  private gridAt(field: Float32Array, x: number, z: number): number {
    const at = (p: number, cells: number, wrap: boolean): [number, number, number] => {
      const f = (p + 0.5) / PLATE_CELL - 0.5, a = Math.floor(f);
      if (wrap) return [((a % cells) + cells) % cells, (((a + 1) % cells) + cells) % cells, f - a];
      return [Math.max(0, Math.min(cells - 1, a)), Math.max(0, Math.min(cells - 1, a + 1)), f - a];
    };
    const [c0, c1, tx] = at(x, this.cols, this.wrap), [r0, r1, tz] = at(z, this.rows, false);
    const a = field[c0 + this.cols * r0]! + (field[c1 + this.cols * r0]! - field[c0 + this.cols * r0]!) * tx;
    const b = field[c0 + this.cols * r1]! + (field[c1 + this.cols * r1]! - field[c0 + this.cols * r1]!) * tx;
    return a + (b - a) * tz;
  }

  private axisWeights(p0: number, count: number, step: number, cells: number, wrap: boolean) {
    const i0 = new Int32Array(count), i1 = new Int32Array(count), t = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      const f = (p0 + k * step + 0.5) / PLATE_CELL - 0.5;
      const a = Math.floor(f);
      t[k] = f - a;
      if (wrap) {
        i0[k] = ((a % cells) + cells) % cells;
        i1[k] = (((a + 1) % cells) + cells) % cells;
      } else {
        i0[k] = Math.max(0, Math.min(cells - 1, a));
        i1[k] = Math.max(0, Math.min(cells - 1, a + 1));
      }
    }
    return { i0, i1, t };
  }

  /** A per-cell field interpolated at the w x d samples, row-major. */
  private interpolate(field: Float32Array, x0: number, z0: number, w: number, d: number, step: number): Float64Array {
    const X = this.axisWeights(x0, w, step, this.cols, this.wrap);
    const Z = this.axisWeights(z0, d, step, this.rows, false);
    const out = new Float64Array(w * d);
    const cols = this.cols;
    for (let j = 0; j < d; j++) {
      const r0 = Z.i0[j]! * cols, r1 = Z.i1[j]! * cols, tz = Z.t[j]!;
      for (let i = 0; i < w; i++) {
        const c0 = X.i0[i]!, c1 = X.i1[i]!, tx = X.t[i]!;
        const a = field[r0 + c0]! + (field[r0 + c1]! - field[r0 + c0]!) * tx;
        const b = field[r1 + c0]! + (field[r1 + c1]! - field[r1 + c0]!) * tx;
        out[i + w * j] = a + (b - a) * tz;
      }
    }
    return out;
  }

  heights(x0: number, z0: number, w: number, d: number, step = 1): Int32Array {
    // A copy: the last block sampled is kept for water() and materials().
    return this.surface(x0, z0, w, d, step).heights.slice();
  }

  /**
   * Height of the water standing over each sample (rivers and lakes; the sea is seaLevel), or
   * null if there's none over any of them. NO_WATER where there's none.
   */
  water(x0: number, z0: number, w: number, d: number, step = 1): Int32Array | null {
    return this.surface(x0, z0, w, d, step).water;
  }

  /** Ground (with rivers' channels and valleys cut) and river and lake water over samples. */
  private surface(x0: number, z0: number, w: number, d: number, step: number): { heights: Int32Array; water: Int32Array | null } {
    const key = `${x0},${z0},${w},${d},${step}`;
    if (this.lastSurface?.key === key) return this.lastSurface;
    const heights = this.groundHeights(x0, z0, w, d, step);
    let water: Int32Array | null = null;
    const h = this.hydrology;
    if (h) {
      const rivers = this.rivers;
      const lakes = h.lakeCount > 0;
      for (let j = 0; j < d; j++) {
        for (let i = 0; i < w; i++) {
          const k = i + w * j, x = x0 + i * step, z = z0 + j * step;
          let top: number | null = null;
          const segs = rivers ? rivers.at(x, z) : null;
          if (segs && segs.length) {
            const r = carveRivers(segs, x, z, heights[k]!, this.world.widthUnits, this.wrap);
            heights[k] = Math.round(r.ground);
            top = r.water;
          }
          if (lakes) {
            // A lake fills its basin up to its level, around its cells and a cell beyond.
            const c = Math.floor(x / PLATE_CELL), r = Math.floor(z / PLATE_CELL);
            let level = NaN;
            for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
              let cc = c + a;
              if (this.wrap) cc = ((cc % this.cols) + this.cols) % this.cols;
              const rr = r + b;
              if (cc < 0 || cc >= this.cols || rr < 0 || rr >= this.rows) continue;
              const l = h.lakeLevel[cc + this.cols * rr]!;
              if (!Number.isNaN(l) && !(l <= level)) level = l;
            }
            if (!Number.isNaN(level) && heights[k]! < level) top = Math.max(top ?? -Infinity, level);
          }
          if (top !== null && top > heights[k]! && top > this.seaLevel) {
            water ??= new Int32Array(w * d).fill(NO_WATER);
            water[k] = Math.round(top);
          }
        }
      }
    }
    // Polar ice covers whatever is near the north and south edges.
    const ice = this.iceTops(x0, z0, w, d, step);
    if (ice) {
      for (let k = 0; k < heights.length; k++) {
        if (ice[k]! <= heights[k]!) continue;
        heights[k] = Math.round(ice[k]!);
        if (water) water[k] = NO_WATER;
      }
    }
    this.lastSurface = { key, heights, water };
    return this.lastSurface;
  }

  /** The polar ice's surface over samples (units; -Infinity where there's none), or null if none is near. */
  private iceTops(x0: number, z0: number, w: number, d: number, step: number): Float64Array | null {
    if (!this.ice) return null;
    const D = this.world.depthUnits, reach = ICE_BAND * 1.4;
    const zLo = z0, zHi = z0 + (d - 1) * step;
    if (zLo > reach && zHi < D - reach) return null;
    const norm = (os: Octave[]) => 2 / os.reduce((a, o) => a + o.weight, 0);
    // The band's width along each edge, by x.
    const north = fractalGrid(this.ice.edge, x0, 0, w, 1, step), south = fractalGrid(this.ice.edge, x0, D, w, 1, step);
    const ne = norm(this.ice.edge);
    const rough = fractalGrid(this.ice.surface, x0, z0, w, d, step), ns = norm(this.ice.surface);
    const out = new Float64Array(w * d).fill(-Infinity);
    for (let j = 0; j < d; j++) {
      const z = z0 + j * step;
      for (let i = 0; i < w; i++) {
        const nearNorth = z < D / 2;
        const band = ICE_BAND * (1 + 0.3 * (nearNorth ? north[i]! : south[i]!) * ne);
        const dist = nearNorth ? z : D - z;
        if (dist >= band) continue;
        const t = 1 - Math.max(0, dist) / band; // 0 at the band's inner edge .. 1 at the world's edge
        out[i + w * j] = this.seaLevel + ICE_SHELF + (ICE_WALL - ICE_SHELF) * t ** 2.5 + rough[i + w * j]! * ns * 0.6 * M;
      }
    }
    return out;
  }

  private groundHeights(x0: number, z0: number, w: number, d: number, step = 1): Int32Array {
    const detail = fractalGrid(this.detail, x0, z0, w, d, step);
    const norm = 2 / this.detail.reduce((a, o) => a + o.weight, 0);
    const elev = this.interpolate(this.sampleBase, x0, z0, w, d, step);
    const strokes = this.strokes.length ? strokesIn(this.strokes, x0, z0, x0 + (w - 1) * step, z0 + (d - 1) * step, this.wrap ? this.world.widthUnits : null) : [];
    const rough = this.interpolate(this.rough, x0, z0, w, d, step);
    const crag = this.cragsAt(x0, z0, w, d, step);
    const out = new Int32Array(w * d);
    for (let k = 0; k < out.length; k++) {
      const e = elev[k]!;
      // Never past the configured bounds: roughness fades out at the very top and bottom.
      const room = Math.min(this.maxHeight - e, e - this.minHeight);
      const amp = Math.min((DETAIL_MIN + (DETAIL_MAX - DETAIL_MIN) * rough[k]!) * this.detailScale, room);
      let h = e + detail[k]! * norm * Math.max(0, amp);
      if (crag) h += crag[k]! * Math.max(0, Math.min(crag.amp[k]!, room));
      h = Math.min(this.maxHeight, Math.max(this.minHeight, h));
      if (strokes.length) {
        // Terraforming, exactly here (within the world's own height range, which may pass the
        // generator's). With many strokes about, only those reaching this spot's square.
        const x = x0 + (k % w) * step, z = z0 + Math.floor(k / w) * step;
        const here = strokes.length > 8 ? this.strokeIndex!.at(x, z) : strokes;
        h = Math.max(this.lowest, Math.min(this.highest, applyStrokes(here, x, z, h, e, this.seaLevel, this.wrap ? this.world.widthUnits : null, this.smoothTarget).ground));
      }
      out[k] = Math.round(h);
    }
    return out;
  }

  /**
   * Mountain-side detail for a block of samples: ridged noise (about -1..1) and its amplitude
   * per sample (units), or null where there are no mountains (the common case: skipped).
   */
  private cragsAt(x0: number, z0: number, w: number, d: number, step: number): (Float64Array & { amp: Float64Array }) | null {
    if (this.cragAmp <= 0) return null;
    // Cheap check first: any mountain grid cell under (or next to) the block?
    const c0 = Math.floor(x0 / PLATE_CELL) - 1, c1 = Math.floor((x0 + (w - 1) * step) / PLATE_CELL) + 1;
    const r0 = Math.max(0, Math.floor(z0 / PLATE_CELL) - 1), r1 = Math.min(this.rows - 1, Math.floor((z0 + (d - 1) * step) / PLATE_CELL) + 1);
    let any = false;
    for (let r = r0; r <= r1 && !any; r++) {
      for (let c = c0; c <= c1; c++) {
        const cc = this.wrap ? ((c % this.cols) + this.cols) % this.cols : Math.max(0, Math.min(this.cols - 1, c));
        if (this.mountainness[cc + this.cols * r]! > 0) { any = true; break; }
      }
    }
    if (!any) return null;
    const m = this.interpolate(this.mountainness, x0, z0, w, d, step);
    // Ridged gradient noise (0..1, crests high), centred and stretched to about -1..1: a weighted
    // mean of octaves varies far less than one octave does.
    const ridged = ridgedGrid(this.crags, x0, z0, w, d, step);
    const out = ridged.map((v) => (v - CRAG_MEAN) * CRAG_STRETCH) as Float64Array & { amp: Float64Array };
    // Square root: flanks, not just the cores of ranges, get the detail.
    out.amp = m.map((v) => Math.sqrt(v) * this.cragAmp);
    return out;
  }

  /**
   * The land's broad shape (the 32 m grid, without small-scale bumps) at samples, for slopes:
   * where terraforming strokes reach, with them applied exactly (as samples apply them; so
   * strokes set while shaping, see setSampleStrokes, make steep ground rock straight away).
   */
  private broadGround(x0: number, z0: number, w: number, d: number, step: number): Float64Array {
    const strokes = this.strokes.length ? strokesIn(this.strokes, x0, z0, x0 + (w - 1) * step, z0 + (d - 1) * step, this.wrap ? this.world.widthUnits : null) : [];
    if (strokes.length === 0) return this.interpolate(this.elevation, x0, z0, w, d, step);
    const out = this.interpolate(this.sampleBase, x0, z0, w, d, step);
    const W = this.wrap ? this.world.widthUnits : null;
    for (let k = 0; k < out.length; k++) {
      const x = x0 + (k % w) * step, z = z0 + Math.floor(k / w) * step;
      const here = strokes.length > 8 ? this.strokeIndex!.at(x, z) : strokes;
      out[k] = applyStrokes(here, x, z, out[k]!, out[k]!, this.seaLevel, W, this.smoothTarget).broad;
    }
    return out;
  }

  /**
   * broadGround at the samples moved `e` units east, west, south and north. When `e` is a whole
   * number of steps and the block is big enough that one block around them all is smaller than
   * the four, from that (the same points; far less work with strokes).
   */
  private broadAround(x0: number, z0: number, w: number, d: number, step: number, e: number): [Float64Array, Float64Array, Float64Array, Float64Array] {
    if (e % step !== 0 || (w + (2 * e) / step) * (d + (2 * e) / step) >= 4 * w * d) {
      return [this.broadGround(x0 + e, z0, w, d, step), this.broadGround(x0 - e, z0, w, d, step), this.broadGround(x0, z0 + e, w, d, step), this.broadGround(x0, z0 - e, w, d, step)];
    }
    const k = e / step, bw = w + 2 * k, all = this.broadGround(x0 - e, z0 - e, bw, d + 2 * k, step);
    const shifted = (di: number, dj: number) => {
      const out = new Float64Array(w * d);
      for (let j = 0; j < d; j++) for (let i = 0; i < w; i++) out[i + w * j] = all[i + k + di + bw * (j + k + dj)]!;
      return out;
    };
    return [shifted(k, 0), shifted(-k, 0), shifted(0, k), shifted(0, -k)];
  }

  materials(x0: number, z0: number, w: number, d: number, step: number, heights: Int32Array): Uint16Array {
    return this.materialsWith(x0, z0, w, d, step, heights, this.climateSamples(x0, z0, w, d, step, heights, true));
  }

  private materialsWith(x0: number, z0: number, w: number, d: number, step: number, heights: Int32Array, climate: ReturnType<PlateHeights['climateSamples']>): Uint16Array {
    const out = new Uint16Array(w * d);
    // Coarse slope (rise over run) from the 32 m grid, via central differences one cell apart.
    const e = PLATE_CELL;
    const [east, west, south, north] = this.broadAround(x0, z0, w, d, step, e);
    const vary = fractalGrid(this.beachNoise, x0, z0, w, d, step);
    const norm = 2 / this.beachNoise.reduce((a, o) => a + o.weight, 0);
    const sea = this.seaLevel;
    // With biomes, snow and rock follow the ground's temperature (and with altitudeSnow and
    // altitudeRock, also lie above their altitudes); without, fixed heights. Either way the snow line
    // wanders (in degrees or metres), computed only where some ground is within its reach.
    const byHeight = !climate || this.altitudeSnow;
    const shiftNear = (wander: number, near: () => boolean) => {
      if (wander <= 0 || !near()) return null;
      const f = fractalGrid(this.snowNoise, x0, z0, w, d, step);
      // Scaled by the octaves' weight so it spans about -1..1.
      const s = (2 / this.snowNoise.reduce((a, o) => a + o.weight, 0)) * 1.8 * wander;
      return f.map((v) => Math.max(-wander, Math.min(wander, v * s)));
    };
    const degrees = (this.snowWander / SNOW_FRACTAL_MAX) * SNOW_FRACTAL_DEGREES;
    const tempShift = climate ? shiftNear(degrees, () => climate.temperature.some((t) => Math.abs(t - this.snowTemp) <= degrees + ROCK_BAND_DEGREES)) : null;
    const heightShift = byHeight ? shiftNear(this.snowWander, () => heights.some((h) => Math.abs(h - this.snowLine) <= this.snowWander)) : null;
    // River and lake beds (only looked up where this world has any), and polar ice.
    const standing = this.hydrology ? this.surface(x0, z0, w, d, step).water : null;
    const ice = this.iceTops(x0, z0, w, d, step);
    for (let k = 0; k < out.length; k++) {
      const h = heights[k]!;
      if (ice && ice[k]! >= h - M) {
        out[k] = Material.Ice;
        continue;
      }
      if (standing && standing[k]! > h) {
        out[k] = Material.Sand;
        continue;
      }
      const slope = Math.hypot(east[k]! - west[k]!, south[k]! - north[k]!) / (2 * e);
      const v = vary[k]! * norm; // about -1..1
      // Steep coasts: bare rock at the waterline (the threshold wanders so the edge isn't a line).
      const rocky = slope + 0.02 * v > ROCKY && h > sea - ROCKY_BELOW && h <= sea + ROCKY_ABOVE;
      // Gentle coasts: sand up to a height that shrinks as the coast steepens.
      const beachTop = sea + this.beachHeight * (1 - smoothstep(GENTLE, STEEP, slope)) * (0.6 + 0.4 * v);
      const high = byHeight && h >= this.snowLine + (heightShift ? heightShift[k]! : 0);
      let snow: boolean, bare: boolean;
      if (climate) {
        // Colder than the snow temperature: snow; a little warmer, on high ground: bare rock.
        // (And above the snow and rock altitudes, with altitudeSnow and altitudeRock.)
        const t = climate.temperature[k]! + (tempShift ? tempShift[k]! : 0);
        snow = t < this.snowTemp || high;
        bare = (t < this.snowTemp + ROCK_BAND_DEGREES && h - sea > ROCK_BAND_MIN_HEIGHT) || (this.altitudeRock && h >= this.rockLine);
      } else {
        snow = high;
        bare = h >= this.rockLine;
      }
      // Steep ground is bare rock even above the snow line: steep faces don't hold snow.
      out[k] =
        rocky ? Material.Stone
        : h <= sea || h <= beachTop ? Material.Sand
        : slope > this.rockSlope ? Material.Stone
        : snow ? Material.Snow
        : bare ? Material.Stone
        : climate ? BIOME_GROUND[climate.biome[k]! as BiomeId]
        : Material.Grass;
    }
    return out;
  }

  /** The forest canopy over samples, for distant views (see canopyOver). */
  canopy(x0: number, z0: number, w: number, d: number, step: number, heights: Int32Array, materials: Uint16Array): Canopy | null {
    if (this.treeDensity <= 0) return null;
    const climate = this.climateSamples(x0, z0, w, d, step, heights);
    return canopyOver(
      x0, z0, w, d, step, heights, materials,
      climate && { temperature: climate.biomeTemperature, moisture: climate.biomeMoisture }, this.treeDensity, this.treeSeed,
      () => this.trees(x0, z0, x0 + w * step, z0 + d * step),
      this.ecotone,
      this.clumps,
    );
  }

  /** Trees with any part in the box [x0, x1) x [z0, z1) (units). */
  trees(x0: number, z0: number, x1: number, z1: number): Tree[] {
    return treesIn(
      {
        ground: (xs, zs) => {
          const heights = new Int32Array(xs.length), materials = new Uint16Array(xs.length);
          const climate: Climate | null = this.temperature ? { temperature: new Float64Array(xs.length), moisture: new Float64Array(xs.length) } : null;
          for (let k = 0; k < xs.length; k++) {
            const h = this.heights(xs[k]!, zs[k]!, 1, 1);
            heights[k] = h[0]!;
            const c = this.climateSamples(xs[k]!, zs[k]!, 1, 1, 1, h);
            materials[k] = this.materialsWith(xs[k]!, zs[k]!, 1, 1, 1, h, c)[0]!;
            if (climate && c) {
              (climate.temperature as Float64Array)[k] = c.biomeTemperature[0]!;
              (climate.moisture as Float64Array)[k] = c.biomeMoisture[0]!;
            }
          }
          return { heights, materials, climate };
        },
      },
      this.treeSeed,
      this.treeDensity,
      x0, z0, x1, z1,
      this.ecotone,
      this.clumps,
    );
  }

  /**
   * Biome per sample for columns with the given heights (temperature falls with height), or null
   * for worlds without biomes.
   */
  biomes(x0: number, z0: number, w: number, d: number, step: number, heights: Int32Array): Uint8Array | null {
    return this.climateSamples(x0, z0, w, d, step, heights, true)?.biome ?? null;
  }

  /**
   * Per sample, or null without biomes: ground temperature (degrees C, colder with height); the
   * temperature and moisture biomes are classified from (shifted by local noise when borders are
   * ragged); and the biome. With `biomesOnly`, the shifted climate is left unshifted where the
   * shift can't change any biome in the block (saving the noise; the biomes are the same).
   */
  private climateSamples(x0: number, z0: number, w: number, d: number, step: number, heights: Int32Array, biomesOnly = false): { temperature: Float64Array; biomeTemperature: Float64Array; biomeMoisture: Float64Array; biome: Uint8Array } | null {
    if (!this.temperature || !this.moisture) return null;
    const temperature = this.interpolate(this.temperature, x0, z0, w, d, step);
    const m = this.interpolate(this.moisture, x0, z0, w, d, step);
    for (let k = 0; k < temperature.length; k++) temperature[k] = temperature[k]! - this.cooling * Math.max(0, heights[k]! - this.seaLevel);
    let biomeTemperature = temperature, biomeMoisture = m;
    let shift = this.ragged.degrees > 0;
    if (shift && biomesOnly) {
      let tLo = Infinity, tHi = -Infinity, mLo = Infinity, mHi = -Infinity;
      for (let k = 0; k < temperature.length; k++) {
        tLo = Math.min(tLo, temperature[k]!); tHi = Math.max(tHi, temperature[k]!);
        mLo = Math.min(mLo, m[k]!); mHi = Math.max(mHi, m[k]!);
      }
      // The noise stays within its amplitude (clamped below).
      const dt = this.ragged.degrees, dm = this.ragged.moisture;
      shift = !sameBiome(tLo - dt, tHi + dt, mLo - dm, mHi + dm);
    }
    if (shift) {
      const [nt, nm] = this.raggedNoise;
      // Scaled by the octaves' weight so each spans about -1..1.
      const ft = fractalGrid(nt, x0, z0, w, d, step), fm = fractalGrid(nm, x0, z0, w, d, step);
      const st = (2 / nt.reduce((a, o) => a + o.weight, 0)) * this.ragged.degrees, sm = (2 / nm.reduce((a, o) => a + o.weight, 0)) * this.ragged.moisture;
      const dt = this.ragged.degrees, dm = this.ragged.moisture;
      biomeTemperature = temperature.map((t, k) => t + Math.max(-dt, Math.min(dt, ft[k]! * st)));
      biomeMoisture = m.map((v, k) => v + Math.max(-dm, Math.min(dm, fm[k]! * sm)));
    }
    const biome = new Uint8Array(w * d);
    for (let k = 0; k < biome.length; k++) biome[k] = classifyBiome(biomeTemperature[k]!, biomeMoisture[k]!);
    return { temperature, biomeTemperature, biomeMoisture, biome };
  }

  /**
   * The climate on the terrain grid, for blending biome colours, or null where biomes don't blend
   * (no biomes, or sharp borders).
   */
  climate(): ClimateGrid | null {
    if (!this.temperature || !this.moisture || this.ecotone.degrees <= 0) return null;
    return {
      cols: this.cols,
      rows: this.rows,
      cell: PLATE_CELL,
      seaLevel: this.seaLevel,
      cooling: this.cooling,
      ecotone: this.ecotone,
      temperature: this.temperature,
      moisture: this.moisture,
    };
  }
}

/** The value below which a fraction `q` (0..1) of the field lies (just outside the range at 0 and 1). */
function quantile(field: Float32Array, q: number): number {
  const n = field.length;
  if (q <= 0 || q >= 1) {
    let lo = Infinity, hi = -Infinity;
    for (const v of field) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
    return q <= 0 ? lo - 1e-3 : hi + 1e-3;
  }
  // The k-th smallest and the one before it, as a full sort would give them (without sorting).
  const k = Math.min(n - 1, Math.floor(q * n));
  const a = Float32Array.from(field);
  selectKth(a, k);
  let below = a[k]!;
  if (k > 0) {
    below = -Infinity;
    for (let i = 0; i < k; i++) below = Math.max(below, a[i]!);
  }
  return (a[k]! + below) / 2;
}

/** Reorders `a` so a[k] is its k-th smallest, with everything before it no larger (quickselect). */
function selectKth(a: Float32Array, k: number): void {
  let lo = 0, hi = a.length - 1;
  while (hi > lo) {
    // Median-of-three pivot.
    const x = a[lo]!, y = a[(lo + hi) >> 1]!, z = a[hi]!;
    const p = x < y ? (y < z ? y : x < z ? z : x) : x < z ? x : y < z ? z : y;
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i]! < p) i++;
      while (a[j]! > p) j--;
      if (i <= j) {
        const t = a[i]!;
        a[i++] = a[j]!;
        a[j--] = t;
      }
    }
    // Now a[lo..j] <= p <= a[i..hi], and anything between equals p.
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return;
  }
}

/**
 * Cells of the lakes to fill: water bodies (4-connected groups of cells where `wet` is true)
 * smaller than `minSize` cells whose nearest cell is more than `reach` cells from open sea (a
 * body of at least `minSize` cells). X wraps if asked.
 */
function inlandLakes(wet: (i: number) => boolean, minSize: number, reach: number, cols: number, rows: number, wrap: boolean): number[] {
  const n = cols * rows;
  const body = new Int32Array(n).fill(-1);
  const bodies: number[][] = [];
  for (let s = 0; s < n; s++) {
    if (body[s] !== -1 || !wet(s)) continue;
    const cells: number[] = [];
    const stack = [s];
    body[s] = bodies.length;
    while (stack.length > 0) {
      const i = stack.pop()!;
      cells.push(i);
      const c = i % cols, r = (i - c) / cols;
      for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        let cc = c + a;
        const rr = r + b;
        if (wrap) cc = ((cc % cols) + cols) % cols;
        if (cc < 0 || cc >= cols || rr < 0 || rr >= rows) continue;
        const j = cc + cols * rr;
        if (body[j] === -1 && wet(j)) {
          body[j] = bodies.length;
          stack.push(j);
        }
      }
    }
    bodies.push(cells);
  }
  const toSea = new Float32Array(n).fill(Infinity);
  for (const cells of bodies) if (cells.length >= minSize) for (const i of cells) toSea[i] = 0;
  chamfer(toSea, cols, rows, wrap);
  const out: number[] = [];
  for (const cells of bodies) {
    if (cells.length >= minSize) continue;
    let nearest = Infinity;
    for (const i of cells) nearest = Math.min(nearest, toSea[i]!);
    if (nearest > reach) out.push(...cells);
  }
  return out;
}

/** Like chamfer, also carrying each source cell's label to the cells nearest it. */
function chamferLabel(dist: Float32Array, label: Int32Array, cols: number, rows: number, wrap: boolean): void {
  const at = (c: number, r: number) => {
    if (wrap) c = ((c % cols) + cols) % cols;
    return c < 0 || c >= cols || r < 0 || r >= rows ? -1 : c + cols * r;
  };
  const relax = (i: number, j: number, w: number) => {
    if (j >= 0 && dist[j]! + w < dist[i]!) {
      dist[i] = dist[j]! + w;
      label[i] = label[j]!;
    }
  };
  for (let pass = 0; pass < (wrap ? 2 : 1); pass++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = c + cols * r;
        relax(i, at(c - 1, r), 1); relax(i, at(c, r - 1), 1); relax(i, at(c - 1, r - 1), Math.SQRT2); relax(i, at(c + 1, r - 1), Math.SQRT2);
      }
    }
    for (let r = rows - 1; r >= 0; r--) {
      for (let c = cols - 1; c >= 0; c--) {
        const i = c + cols * r;
        relax(i, at(c + 1, r), 1); relax(i, at(c, r + 1), 1); relax(i, at(c + 1, r + 1), Math.SQRT2); relax(i, at(c - 1, r + 1), Math.SQRT2);
      }
    }
  }
}

/** In-place two-pass chamfer distance transform (cells): zeros are sources, others start at Infinity. */
function chamfer(dist: Float32Array, cols: number, rows: number, wrap: boolean): void {
  const at = (c: number, r: number) => {
    if (wrap) c = ((c % cols) + cols) % cols;
    return c < 0 || c >= cols || r < 0 || r >= rows ? -1 : c + cols * r;
  };
  const relax = (i: number, j: number, w: number) => {
    if (j >= 0 && dist[j]! + w < dist[i]!) dist[i] = dist[j]! + w;
  };
  for (let pass = 0; pass < (wrap ? 2 : 1); pass++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = c + cols * r;
        relax(i, at(c - 1, r), 1); relax(i, at(c, r - 1), 1); relax(i, at(c - 1, r - 1), Math.SQRT2); relax(i, at(c + 1, r - 1), Math.SQRT2);
      }
    }
    for (let r = rows - 1; r >= 0; r--) {
      for (let c = cols - 1; c >= 0; c--) {
        const i = c + cols * r;
        relax(i, at(c + 1, r), 1); relax(i, at(c, r + 1), 1); relax(i, at(c + 1, r + 1), Math.SQRT2); relax(i, at(c - 1, r + 1), Math.SQRT2);
      }
    }
  }
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Separable box blur of a grid field with the given radius (cells); X wraps if asked (edges
 * otherwise repeat). Running sums: each cell costs the same whatever the radius.
 */
function blur(src: Float32Array, cols: number, rows: number, radius: number, wrap: boolean): Float32Array {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const span = 2 * radius + 1;
  const col = (c: number) => (wrap ? ((c % cols) + cols) % cols : Math.max(0, Math.min(cols - 1, c)));
  const row = (r: number) => Math.max(0, Math.min(rows - 1, r));
  for (let r = 0; r < rows; r++) {
    const o = cols * r;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += src[col(k) + o]!;
    for (let c = 0; c < cols; c++) {
      tmp[c + o] = sum / span;
      sum += src[col(c + radius + 1) + o]! - src[col(c - radius) + o]!;
    }
  }
  const sums = new Float64Array(cols);
  for (let k = -radius; k <= radius; k++) {
    const o = cols * row(k);
    for (let c = 0; c < cols; c++) sums[c]! += tmp[c + o]!;
  }
  for (let r = 0; r < rows; r++) {
    const o = cols * r, add = cols * row(r + radius + 1), drop = cols * row(r - radius);
    for (let c = 0; c < cols; c++) {
      out[c + o] = sums[c]! / span;
      sums[c]! += tmp[c + add]! - tmp[c + drop]!;
    }
  }
  return out;
}
