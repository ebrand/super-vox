import { BLOCK_VOLUME, Item, isBlock, type ItemId } from './items.js';
import { Material } from './materials.js';

/**
 * Furnaces and stoves (stations placed as the designs standing in for them): fuel and something
 * to smelt or cook go in, and over time what's made comes out. Everyone at one sees the same
 * contents (the server keeps them). Nothing runs in between: what's happened since it was last
 * looked at is worked out from the time (see advance), so it keeps going with no one near.
 */
export type StationKind = 'furnace' | 'stove';
export const STATION_KINDS: readonly StationKind[] = ['furnace', 'stove'];

export function isStationKind(v: unknown): v is StationKind {
  return v === 'furnace' || v === 'stove';
}

/** An amount of something: blocks by volume (see BLOCK_VOLUME), items by count. */
export interface Stack {
  item: ItemId;
  amount: number;
}

export type StationSlot = 'fuel' | 'input' | 'output';

/**
 * What's in a station. `burn`: seconds of fuel left burning (`burnTotal`: what the last piece gave,
 * for its gauge); `progress`: seconds into the thing being made; `at`: when (ms) it was last
 * brought up to date.
 */
export interface StationState {
  fuel: Stack | null;
  input: Stack | null;
  output: Stack | null;
  burn: number;
  burnTotal: number;
  progress: number;
  at: number;
}

export function emptyStation(now: number): StationState {
  return { fuel: null, input: null, output: null, burn: 0, burnTotal: 0, progress: 0, at: now };
}

/** An eighth of a block (a 1/2 m voxel): blocks are smelted and burnt in pieces this size. */
const PIECE = BLOCK_VOLUME / 8;

/** What each station makes: from `unit` of `input` (volume, or a count), one `output`, taking `seconds`. */
export const STATION_RECIPES: Readonly<Record<StationKind, readonly { input: ItemId; unit: number; output: ItemId; seconds: number }[]>> = {
  // (A block of raw iron: 8 ingots.)
  furnace: [
    { input: Material.RawIron, unit: PIECE, output: Item.IronIngot, seconds: 10 },
    // (Coins: a piece of raw copper or gold makes one.)
    { input: Material.RawCopper, unit: PIECE, output: Item.CopperCoin, seconds: 6 },
    { input: Material.RawGold, unit: PIECE, output: Item.GoldCoin, seconds: 12 },
  ],
  stove: [{ input: Item.Pork, unit: 1, output: Item.CookedPork, seconds: 10 }],
};

/** What burns, and for how long: `seconds` for each `unit` (volume, or a count). */
export const FUELS: Readonly<Record<ItemId, { unit: number; seconds: number }>> = {
  // A block of coal (8 pieces) smelts 64 ingots; of wood 16, of planks 4.
  [Material.Coal]: { unit: PIECE, seconds: 80 },
  [Material.Wood]: { unit: PIECE, seconds: 20 },
  [Material.Planks]: { unit: PIECE, seconds: 5 },
  [Item.Stick]: { unit: 1, seconds: 5 },
};

/** Most of what's made a station holds: once the output's this full, it stops till some is taken. */
export const STATION_OUTPUT_MAX = 64;

/** The recipe `input` makes in a `kind`, if any. */
export function stationRecipe(kind: StationKind, input: ItemId): (typeof STATION_RECIPES)[StationKind][number] | undefined {
  return STATION_RECIPES[kind].find((r) => r.input === input);
}

/** Why `item` can't go in `slot` of a `kind` holding `s` (null: it can). */
export function refusePut(kind: StationKind, s: StationState, slot: StationSlot, item: ItemId): string | null {
  if (slot === 'output') return "nothing goes in the output: it's where things come out";
  const name = kind === 'furnace' ? 'a furnace' : 'a stove';
  if (slot === 'fuel' && !FUELS[item]) return `that doesn't burn: coal, wood, planks or sticks`;
  if (slot === 'input' && !stationRecipe(kind, item)) return kind === 'furnace' ? `${name} smelts raw iron` : `${name} cooks pork`;
  const there = s[slot];
  if (there && there.item !== item) return `there's something else in it: take that out first`;
  return null;
}

/** Whether `s` can make something now (fuel aside): something to make it from, and room for it. */
function canMake(kind: StationKind, s: StationState): boolean {
  const r = s.input && stationRecipe(kind, s.input.item);
  if (!r || s.input!.amount < r.unit) return false;
  return !s.output || (s.output.item === r.output && s.output.amount < STATION_OUTPUT_MAX);
}

/** Whether it's working now (making something, with fuel burning or to burn). */
export function stationWorking(kind: StationKind, s: StationState): boolean {
  return canMake(kind, s) && (s.burn > 0 || (s.fuel !== null && s.fuel.amount > 0));
}

/** Lights the next piece of fuel, if there is any: true if it did. */
function burnPiece(s: StationState): boolean {
  if (!s.fuel) return false;
  const f = FUELS[s.fuel.item]!;
  // (A last piece smaller than a whole one burns for its share.)
  const amount = Math.min(f.unit, s.fuel.amount);
  s.burn += (f.seconds * amount) / f.unit;
  s.burnTotal = (f.seconds * amount) / f.unit;
  s.fuel.amount -= amount;
  if (s.fuel.amount <= 0) s.fuel = null;
  return true;
}

/**
 * Brings `s` up to `now` (ms): fuel burns only while something's being made (lit a piece at a time,
 * as needed); each thing made takes its recipe's time, its input used and its output added; it
 * stops when there's nothing to make it from, no room for what's made, or no fuel (what was being
 * made then starts again). Changes `s`; true if anything but the time changed.
 */
export function advance(kind: StationKind, s: StationState, now: number): boolean {
  let t = Math.max(0, (now - s.at) / 1000);
  s.at = Math.max(s.at, now);
  let changed = false;
  while (t > 0) {
    const r = s.input && stationRecipe(kind, s.input.item);
    if (!r || !canMake(kind, s)) {
      if (s.progress !== 0) (s.progress = 0), (changed = true);
      break;
    }
    if (s.burn <= 0) {
      if (!burnPiece(s)) {
        if (s.progress !== 0) (s.progress = 0), (changed = true);
        break;
      }
      changed = true;
    }
    const step = Math.min(t, s.burn, r.seconds - s.progress);
    t -= step;
    s.burn = Math.max(0, s.burn - step);
    s.progress += step;
    if (step > 0) changed = true;
    if (s.progress >= r.seconds - 1e-9) {
      s.progress = 0;
      s.input!.amount -= r.unit;
      if (s.input!.amount <= 0) s.input = null;
      s.output = s.output ? { ...s.output, amount: s.output.amount + 1 } : { item: r.output, amount: 1 };
    }
  }
  return changed;
}

/** Puts `amount` of `item` in `slot` (check refusePut first). */
export function put(s: StationState, slot: 'fuel' | 'input', item: ItemId, amount: number): void {
  const there = s[slot];
  s[slot] = { item, amount: (there?.amount ?? 0) + amount };
}

/** Takes `amount` (default: everything) out of `slot`; what was making stops if its input all goes (see advance). */
export function take(s: StationState, slot: StationSlot, amount?: number): Stack | null {
  const there = s[slot];
  if (!there) return null;
  const n = amount === undefined ? there.amount : Math.min(amount, there.amount);
  if (n <= 0) return null;
  const left = there.amount - n;
  s[slot] = left > 0 ? { item: there.item, amount: left } : null;
  if (slot === 'input' && left <= 0) s.progress = 0;
  return { item: there.item, amount: n };
}

/** How much of `item` is one piece for `slot` of a `kind`: a fuel's or a recipe's unit (an eighth of a block, or one); 1 for what comes out. */
export function stationPiece(kind: StationKind, slot: StationSlot, item: ItemId): number {
  if (slot === 'fuel') return FUELS[item]?.unit ?? 1;
  if (slot === 'input') return stationRecipe(kind, item)?.unit ?? 1;
  return 1;
}

/** An amount in a slot for people: blocks to a 1/8, items counted. */
export function stackLabel(st: Stack): string {
  return isBlock(st.item) ? `${Math.round((st.amount / BLOCK_VOLUME) * 8) / 8} m³` : String(st.amount);
}

/** Whether a value read back (from disk) is a station's state. */
export function isStationState(v: unknown): v is StationState {
  const s = v as StationState;
  const stack = (x: unknown) => x === null || (typeof x === 'object' && Number.isFinite((x as Stack).item) && Number.isFinite((x as Stack).amount));
  return typeof s === 'object' && s !== null && stack(s.fuel) && stack(s.input) && stack(s.output) && [s.burn, s.burnTotal, s.progress, s.at].every(Number.isFinite);
}
