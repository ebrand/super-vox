import { BLOCK_VOLUME, Item, isBlock, type ItemId } from './items.js';
import { Material } from './materials.js';
import { UNITS_PER_METER } from './units.js';
import { avatarText, defaultAvatar, type Avatar } from './avatar.js';

/**
 * Trading posts: a market stall where a trader buys raw goods (ore, ingots, coal, timber, pork) and
 * sells finished ones (tools, rails, rolling stock, a radio...), for coins (copper; gold is worth
 * GOLD_COPPER of them). The world places them (see tradingPosts): one near where players start, then
 * one in each POST_CELL_M square of open, flat land; each its own trader, its own prices (what it
 * wants most, it pays more for), all from the world's seed: nothing kept, the same every time.
 */

/** A gold coin's worth in copper ones. */
export const GOLD_COPPER = 10;
/** One post to a square this big (m), where there's somewhere for one. */
export const POST_CELL_M = 3000;
/** How near a trader (m) you trade. */
export const TRADE_REACH_M = 6;
/** A piece: an eighth of a block (ore, coal: as smelting and fuelling take them). */
const PIECE = BLOCK_VOLUME / 8;

/** Something bought or sold: how much a lot is (as inventories keep it: blocks by volume, items by count), and its price (copper coins a lot). */
export interface Offer {
  item: ItemId;
  lot: number;
  price: number;
}

export interface TradingPost {
  id: number;
  /** Where the stall stands (units: the ground at its middle), and the way its counter faces (a heading). */
  x: number;
  y: number;
  z: number;
  heading: number;
  name: string;
  trader: { name: string; look: string };
  /** What it pays for, and what it sells. */
  buys: Offer[];
  sells: Offer[];
}

/** What's bought, by kind (a post wanting a kind pays half again for it). */
const BUYS: Record<'ore' | 'timber' | 'food', Offer[]> = {
  ore: [
    { item: Material.Coal, lot: PIECE, price: 1 },
    { item: Material.RawIron, lot: PIECE, price: 2 },
    { item: Item.IronIngot, lot: 1, price: 3 },
  ],
  timber: [
    { item: Material.Wood, lot: BLOCK_VOLUME, price: 1 },
    { item: Material.Planks, lot: BLOCK_VOLUME * 2, price: 1 },
    { item: Item.Stick, lot: 16, price: 1 },
  ],
  food: [
    { item: Item.Pork, lot: 1, price: 1 },
    { item: Item.CookedPork, lot: 1, price: 2 },
  ],
};
/** What's sold: everywhere, and at some posts. */
const SELLS_EVERYWHERE: Offer[] = [
  { item: Item.Torch, lot: 4, price: 1 },
  { item: Item.Bucket, lot: 1, price: 8 },
  { item: Item.IronPickaxe, lot: 1, price: 12 },
  { item: Item.IronAxe, lot: 1, price: 12 },
  { item: Item.IronShovel, lot: 1, price: 8 },
  { item: Item.IronSword, lot: 1, price: 10 },
];
const SELLS_SOME: Offer[][] = [
  // A rail depot.
  [
    { item: Item.Rail, lot: 8, price: 4 },
    { item: Item.Engine, lot: 1, price: 60 },
    { item: Item.FlatbedCar, lot: 1, price: 24 },
    { item: Item.PassengerCar, lot: 1, price: 30 },
  ],
  // A general store.
  [
    { item: Item.Radio, lot: 1, price: 25 },
    { item: Item.Bow, lot: 1, price: 8 },
    { item: Item.CraftingTable, lot: 1, price: 2 },
    { item: Item.GeologistsHammer, lot: 1, price: 2 },
  ],
];
const KINDS = ['ore', 'timber', 'food'] as const;
const PLACE_NAMES = ['Ashford', 'Bramble', 'Cinder', 'Dunmore', 'Elmstead', 'Fallow', 'Greywater', 'Hollin', 'Ironbridge', 'Juniper', 'Kestrel', 'Larkhill', 'Millbrook', 'Northgate', 'Oakhurst', 'Pinecroft', 'Quarry', 'Redcliff', 'Stonebay', 'Thornwick', 'Underhill', 'Valewood', 'Westmarch', 'Yarrow'];
const TRADER_NAMES = ['Ada', 'Bram', 'Cora', 'Dell', 'Edda', 'Finn', 'Greta', 'Hal', 'Ines', 'Jory', 'Kit', 'Lena', 'Milo', 'Nell', 'Otto', 'Pia', 'Quill', 'Rosa', 'Sven', 'Tilda', 'Ulf', 'Vera', 'Wren', 'Yuri'];

/** A repeatable random number in [0, 1) from a string. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A post's offers and people, from its seed: what it wants (paid half again for), what it sells besides what everyone does. */
function stock(seed: string, place: string, who: string): Pick<TradingPost, 'buys' | 'sells' | 'name' | 'trader'> {
  const want = KINDS[Math.floor(hash(`${seed}:want`) * KINDS.length)]!;
  const buys = KINDS.flatMap((k) => BUYS[k].map((o) => ({ ...o, price: k === want ? Math.ceil(o.price * 1.5) : o.price })));
  const extra = SELLS_SOME[Math.floor(hash(`${seed}:sells`) * SELLS_SOME.length)]!;
  // (Its prices a little its own: up to a fifth either way.)
  const sells = [...SELLS_EVERYWHERE, ...extra].map((o) => ({ ...o, price: Math.max(1, Math.round(o.price * (0.8 + 0.4 * hash(`${seed}:${o.item}`)))) }));
  const name = `${place} trading post`;
  const look: Avatar = { ...defaultAvatar(who), figure: hash(`${seed}:figure`) < 0.5 ? 'man' : 'woman', shirt: ['#6b8e23', '#8b4513', '#4682b4', '#a0522d', '#556b2f'][Math.floor(hash(`${seed}:shirt`) * 5)]! };
  return { buys, sells, name, trader: { name: `${who} the trader`, look: avatarText(look) } };
}

/**
 * The trading posts of a world (`seed`: its name), `width` by `depth` m: one near `spawn` (m), then
 * one in each POST_CELL_M square where `site` finds a place for it (open, flat land: the ground's
 * height there, units, or null) near one of a few spots tried in it.
 */
export function tradingPosts(seed: string, width: number, depth: number, spawn: { x: number; z: number }, site: (x: number, z: number) => number | null): TradingPost[] {
  const posts: TradingPost[] = [];
  const M = UNITS_PER_METER;
  // (Names dealt out in a shuffled order: none the same till they've all been used, then numbered.)
  const dealt = (names: readonly string[], salt: string) => {
    const order = names.map((n, i) => ({ n, k: hash(`${seed}:${salt}:${i}`) })).sort((a, b) => a.k - b.k).map((e) => e.n);
    return (i: number) => order[i % order.length]! + (i >= order.length ? ` ${Math.floor(i / order.length) + 1}` : '');
  };
  const place = dealt(PLACE_NAMES, 'places'), who = dealt(TRADER_NAMES, 'traders');
  const add = (x: number, z: number, y: number, key: string) => {
    const i = posts.length;
    posts.push({ id: i + 1, x: Math.round(x * M), y, z: Math.round(z * M), heading: hash(`${key}:heading`) * Math.PI * 2, ...stock(`${seed}:${key}`, place(i), who(i)) });
  };
  // Near where players start: within a few hundred metres, the first place found.
  for (let i = 0; i < 40; i++) {
    const a = hash(`${seed}:home:${i}:a`) * Math.PI * 2, r = 60 + 340 * hash(`${seed}:home:${i}:r`);
    const x = spawn.x + Math.cos(a) * r, z = spawn.z + Math.sin(a) * r;
    if (x < 0 || z < 0 || x >= width || z >= depth) continue;
    const y = site(x * M, z * M);
    if (y !== null) {
      add(x, z, y, 'home');
      break;
    }
  }
  for (let cz = 0; cz * POST_CELL_M < depth; cz++)
    for (let cx = 0; cx * POST_CELL_M < width; cx++) {
      const key = `${cx},${cz}`;
      for (let i = 0; i < 6; i++) {
        const x = (cx + 0.15 + 0.7 * hash(`${seed}:${key}:${i}:x`)) * POST_CELL_M, z = (cz + 0.15 + 0.7 * hash(`${seed}:${key}:${i}:z`)) * POST_CELL_M;
        if (x >= width || z >= depth) continue;
        // (Not on top of the one near spawn.)
        if (posts.some((p) => Math.hypot(p.x / M - x, p.z / M - z) < POST_CELL_M / 3)) break;
        const y = site(x * M, z * M);
        if (y === null) continue;
        add(x, z, y, key);
        break;
      }
    }
  return posts;
}

/** An amount for people, as traders deal in it: "4", "1/8 block", "3/8 block", "2 blocks". */
export function lotLabel(item: ItemId, amount: number): string {
  if (!isBlock(item)) return String(amount);
  const eighths = Math.round((amount / BLOCK_VOLUME) * 8);
  if (eighths % 8 === 0) return `${eighths / 8} block${eighths === 8 ? '' : 's'}`;
  return eighths < 8 ? `${eighths}/8 block` : `${(eighths / 8).toFixed(3).replace(/0+$/, '')} blocks`;
}

/** Copper coins' worth of `copper` copper and `gold` gold coins. */
export const worth = (copper: number, gold: number) => copper + gold * GOLD_COPPER;

/**
 * Paying `price` (copper's worth) from `copper` and `gold` coins: the copper first, then gold (change
 * given in copper). How many of each go, and the change; null if they haven't enough.
 */
export function pay(price: number, copper: number, gold: number): { copper: number; gold: number; change: number } | null {
  if (worth(copper, gold) < price) return null;
  const c = Math.min(copper, price), rest = price - c, g = Math.ceil(rest / GOLD_COPPER);
  return { copper: c, gold: g, change: g * GOLD_COPPER - rest };
}

/** Coins for `price` (copper's worth): as many gold as it makes, the rest copper. */
export const coins = (price: number) => ({ gold: Math.floor(price / GOLD_COPPER), copper: price % GOLD_COPPER });
