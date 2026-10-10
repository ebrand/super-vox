import { Item, Material, isWater, type ItemId, type MaterialId } from '@super-vox/shared';
import { materialColor } from './materials.js';

/**
 * Icons for inventory slots, as small SVG pictures (32 x 32): blocks as cubes in their own colour
 * (lit from above; grass with its green top, ores with their specks, TNT with its band, water and
 * leaves with theirs), and items as pictures of what they are (a pickaxe, a sword, a bucket, a
 * torch, coins...), tools in their material's colours. Null for what has no icon of its own
 * (players' designs: they keep their colour and initial).
 */

type Rgb = readonly [number, number, number];

/** A linear-space colour, scaled by `k` (light), as CSS. */
const css = (c: Rgb, k = 1) => `rgb(${c.map((v) => Math.round(Math.min(1, Math.max(0, v * k)) ** (1 / 2.2) * 255)).join(' ')})`;

const WOOD: Rgb = [0.33, 0.18, 0.07];
const DARK_WOOD: Rgb = [0.18, 0.09, 0.03];
const STONE: Rgb = [0.3, 0.3, 0.32];
const IRON: Rgb = [0.62, 0.63, 0.66];
const COPPER: Rgb = [0.72, 0.35, 0.16];
const GOLD: Rgb = [0.95, 0.68, 0.16];
const FLAME: Rgb = [1, 0.62, 0.12];
const WATER: Rgb = [0.12, 0.32, 0.75];

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="100%" height="100%" aria-hidden="true">${body}</svg>`;
const poly = (points: string, fill: string, extra = '') => `<polygon points="${points}" fill="${fill}"${extra}/>`;
const OUTLINE = ' stroke="rgb(0 0 0 / 0.45)" stroke-width="0.8" stroke-linejoin="round"';

/** A cube in `top`, with its sides `side` (default: the same colour), lit from above; `over`: drawn on its faces. */
function cube(top: Rgb, side: Rgb = top, over = ''): string {
  return svg(
    poly('16,3 29,10 16,17 3,10', css(top, 1.35), OUTLINE) +
      poly('3,10 16,17 16,30 3,23', css(side, 0.95), OUTLINE) +
      poly('16,17 29,10 29,23 16,30', css(side, 0.68), OUTLINE) +
      over,
  );
}

/** Specks on a cube's three faces (ores, gravel, leaves), at fixed spots so every icon of a kind matches. */
function specks(color: Rgb, size = 1.6): string {
  const spots = [
    [10, 9], [17, 6], [21, 11], [14, 12], // top
    [6, 15], [10, 21], [7, 24], [12, 17], // left
    [20, 21], [24, 16], [22, 26], [26, 22], // right
  ];
  return spots.map(([x, y]) => `<rect x="${x! - size / 2}" y="${y! - size / 2}" width="${size}" height="${size}" fill="${css(color, 1.1)}"/>`).join('');
}

/** A tool's handle, a diagonal stick from bottom left toward top right. */
const handle = (x1 = 6, y1 = 27, x2 = 22, y2 = 11, w = 3, color: Rgb = WOOD) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgb(0 0 0 / 0.5)" stroke-width="${w + 1.4}" stroke-linecap="round"/>` +
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${css(color, 1.2)}" stroke-width="${w}" stroke-linecap="round"/>`;

const pickaxe = (head: Rgb) => svg(handle() + `<path d="M6 10 Q16 0 28 11 L25 14.5 Q16 7.5 9 13 Z" fill="${css(head, 1.2)}"${OUTLINE}/>`);
const axe = (head: Rgb) => svg(handle() + `<path d="M17 6 L25 4 Q29 10 25 17 L19 13 Z" fill="${css(head, 1.2)}"${OUTLINE}/>`);
const shovel = (head: Rgb) => svg(handle(9, 24, 24, 9) + `<path d="M5 27 L4 20 Q6 16 11 17 L15 21 Q16 26 12 28 Z" fill="${css(head, 1.2)}"${OUTLINE}/>`);
const sword = (blade: Rgb) =>
  svg(
    `<path d="M28 3 L27.5 7 L14 21.5 L10.5 18 L24 4.5 Z" fill="${css(blade, 1.35)}"${OUTLINE}/><path d="M27 4.5 L12.5 19.5" stroke="rgb(255 255 255 / 0.35)" stroke-width="0.8"/>` +
      `<line x1="9" y1="17" x2="15" y2="23" stroke="${css(DARK_WOOD, 1.4)}" stroke-width="2.6" stroke-linecap="round"/>` +
      handle(5, 27, 11, 21, 2.6, DARK_WOOD),
  );
const coin = (c: Rgb) =>
  svg(`<circle cx="16" cy="16" r="11" fill="${css(c, 0.8)}"${OUTLINE}/><circle cx="16" cy="16" r="8" fill="${css(c, 1.15)}"/><path d="M11 13 Q14 9 19 10" stroke="rgb(255 255 255 / 0.6)" stroke-width="1.5" fill="none"/>`);
const lump = (c: Rgb, shine = 0.4) =>
  svg(`<path d="M6 20 L9 11 L17 7 L25 11 L27 20 L20 26 L11 25 Z" fill="${css(c)}"${OUTLINE}/><path d="M10 12 L16 9 L19 12" stroke="rgb(255 255 255 / ${shine})" stroke-width="1.4" fill="none"/>`);
const drumstick = (meat: Rgb) =>
  svg(`<ellipse cx="19" cy="13" rx="9" ry="7.5" transform="rotate(-35 19 13)" fill="${css(meat, 1.1)}"${OUTLINE}/><line x1="12" y1="20" x2="6" y2="26" stroke="rgb(240 232 214)" stroke-width="3.2" stroke-linecap="round"/><circle cx="5.5" cy="26.5" r="2.4" fill="rgb(240 232 214)"/>`);

/** A bow: its arc (the wood: tips at (8, 4) and (28, 24)), and its string; and an arrow across it (as it's drawn in the inventory). */
const BOW_ARC =
  `<path d="M8 4 Q26 6 28 24" stroke="${css(WOOD, 1.3)}" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="M8 4 Q26 6 28 24" stroke="rgb(0 0 0 / 0.35)" stroke-width="0.8" fill="none" transform="translate(0.8 0.8)"/>`;
const BOW = BOW_ARC + `<line x1="8" y1="4" x2="28" y2="24" stroke="rgb(235 230 220)" stroke-width="0.8"/>`;

/** A bow's wood alone (no string, no arrow), for the one in your own hand: its string's drawn apart, to be pulled (see heldItem.ts). */
export const BOW_ARC_SVG = svg(BOW_ARC);
const ARROW_ON_BOW = `<line x1="5" y1="27" x2="22" y2="10" stroke="${css(WOOD, 1.1)}" stroke-width="1.4"/><path d="M22 10 L24 6 L26 8 Z" fill="${css(IRON, 1.2)}"/><path d="M5 27 L4 24 M5 27 L8 28" stroke="rgb(235 230 220)" stroke-width="1.2"/>`;

/** The picture an item's held model is made from (see itemModels.ts): its icon, but a bow without the arrow drawn across it. */
export function heldSvg(id: ItemId): string | null {
  return id === Item.Bow ? svg(BOW) : iconSvg(id);
}

/** The pictures of items (not blocks). */
const ITEM_ICONS: Readonly<Partial<Record<ItemId, string>>> = {
  [Item.Stick]: svg(handle(7, 26, 25, 7, 3.2)),
  [Item.WoodenPickaxe]: pickaxe(WOOD),
  [Item.StonePickaxe]: pickaxe(STONE),
  [Item.IronPickaxe]: pickaxe(IRON),
  [Item.WoodenAxe]: axe(WOOD),
  [Item.StoneAxe]: axe(STONE),
  [Item.IronAxe]: axe(IRON),
  [Item.WoodenShovel]: shovel(WOOD),
  [Item.StoneShovel]: shovel(STONE),
  [Item.IronShovel]: shovel(IRON),
  [Item.WoodenSword]: sword(WOOD),
  [Item.StoneSword]: sword(STONE),
  [Item.IronSword]: sword(IRON),
  [Item.GeologistsHammer]: svg(handle(6, 27, 18, 13, 2.8) + `<path d="M12 6 L26 13 L24 16 L21 14 L14 11 L11 9 Z" fill="${css(IRON, 1.1)}"${OUTLINE}/>`),
  [Item.Bucket]: svg(
    `<path d="M9 9 Q16 1 23 9" stroke="${css(IRON, 0.9)}" stroke-width="1.6" fill="none"/>` +
      `<path d="M7 10 L25 10 L22 27 L10 27 Z" fill="${css(WOOD, 1.25)}"${OUTLINE}/><ellipse cx="16" cy="10" rx="9" ry="2" fill="${css(WATER, 1.3)}"/>` +
      `<line x1="8" y1="16" x2="24" y2="16" stroke="${css(IRON, 0.8)}" stroke-width="1.4"/><line x1="9" y1="22" x2="23" y2="22" stroke="${css(IRON, 0.8)}" stroke-width="1.4"/>`,
  ),
  [Item.Torch]: svg(
    `<rect x="14" y="13" width="4" height="15" rx="1" fill="${css(WOOD, 1.3)}"${OUTLINE}/>` +
      `<path d="M16 3 Q22 9 19 13 L13 13 Q10 9 16 3 Z" fill="${css(FLAME, 1)}"/><path d="M16 7 Q19 10 17.5 13 L14.5 13 Q13 10 16 7 Z" fill="rgb(255 240 170)"/>`,
  ),
  [Item.Fence]: svg(
    [6, 14.5, 23].map((x) => `<rect x="${x}" y="6" width="3.5" height="22" fill="${css(WOOD, 1.25)}"${OUTLINE}/>`).join('') +
      [11, 19].map((y) => `<rect x="4" y="${y}" width="24" height="3" fill="${css(WOOD, 1.05)}"${OUTLINE}/>`).join(''),
  ),
  [Item.Gate]: svg(
    `<rect x="5" y="8" width="22" height="18" fill="none" stroke="${css(WOOD, 1.25)}" stroke-width="3.2"/>` +
      `<line x1="6" y1="25" x2="26" y2="9" stroke="${css(WOOD, 1.05)}" stroke-width="2.6"/><line x1="16" y1="8" x2="16" y2="26" stroke="${css(WOOD, 1.05)}" stroke-width="2.4"/>`,
  ),
  [Item.Door]: svg(
    `<rect x="8" y="3" width="16" height="26" rx="1" fill="${css(WOOD, 1.15)}"${OUTLINE}/>` +
      `<rect x="11" y="6" width="10" height="8" fill="${css(WOOD, 0.85)}"/><rect x="11" y="17" width="10" height="9" fill="${css(WOOD, 0.85)}"/><circle cx="21.5" cy="16" r="1.2" fill="${css(GOLD)}"/>`,
  ),
  [Item.Pork]: drumstick([0.92, 0.42, 0.45]),
  [Item.CookedPork]: drumstick([0.45, 0.2, 0.08]),
  [Item.IronIngot]: svg(`<path d="M6 21 L10 13 L26 13 L22 21 Z" fill="${css(IRON, 0.85)}"${OUTLINE}/><path d="M10 13 L13 9 L28 9 L26 13 Z" fill="${css(IRON, 1.3)}"${OUTLINE}/><path d="M22 21 L26 13 L28 9 L28 15 L24 22 Z" fill="${css(IRON, 0.6)}"${OUTLINE}/>`),
  [Item.CopperCoin]: coin(COPPER),
  [Item.GoldCoin]: coin(GOLD),
  [Item.CraftingTable]: craftingTable(),
  [Item.Bow]: svg(BOW + ARROW_ON_BOW),
  // A radio: a dark case, a copper speaker grille, a dial, and its aerial up from a corner.
  [Item.Radio]: svg(
    `<line x1="23" y1="11" x2="27" y2="2" stroke="${css(IRON, 1.1)}" stroke-width="1.6" stroke-linecap="round"/><circle cx="27" cy="2.5" r="1.3" fill="${css(IRON, 1.3)}"/>` +
      `<rect x="4" y="11" width="24" height="16" rx="2.5" fill="rgb(70 66 62)"${OUTLINE}/>` +
      `<rect x="7" y="14" width="10" height="10" rx="1" fill="${css(COPPER, 0.8)}"/><path d="M8 16 H16 M8 18.5 H16 M8 21 H16" stroke="${css(COPPER, 1.35)}" stroke-width="1"/>` +
      `<circle cx="22.5" cy="19" r="3.2" fill="${css(IRON, 1.15)}"${OUTLINE}/><line x1="22.5" y1="19" x2="24.3" y2="17" stroke="rgb(40 38 36)" stroke-width="1"/>`,
  ),
  // Rails: two steel rails on three sleepers, seen at a slant.
  [Item.Rail]: svg(
    `<g transform="translate(2.5 0.5)"><path d="M10.25 6.05 L2.75 16.55 M17.25 10.25 L9.75 20.75 M24.25 14.45 L16.75 24.95" stroke="${css(WOOD, 1.1)}" stroke-width="3.2"/>` +
      `<path d="M6 6 L26 18 M1 13 L21 25" stroke="${css(IRON, 0.6)}" stroke-width="2.6" stroke-linecap="round"/><path d="M6 6 L26 18 M1 13 L21 25" stroke="${css(IRON, 1.35)}" stroke-width="1" stroke-linecap="round"/></g>`,
  ),
  // Rolling stock, side on: a steam engine (boiler, chimney, cab), a flatbed, a passenger car.
  [Item.Engine]: svg(
    `<rect x="3" y="13" width="17" height="8" rx="3" fill="rgb(40 44 48)"${OUTLINE}/><rect x="19" y="8" width="10" height="13" fill="rgb(52 70 58)"${OUTLINE}/><rect x="21" y="10" width="6" height="4" fill="rgb(230 200 120)"/>` +
      `<rect x="6" y="7" width="3.5" height="7" fill="rgb(40 44 48)"${OUTLINE}/><rect x="2" y="21" width="28" height="2.5" fill="rgb(150 40 36)"/>` +
      `<circle cx="8" cy="25.5" r="3" fill="rgb(30 30 32)"${OUTLINE}/><circle cx="15.5" cy="25.5" r="3" fill="rgb(30 30 32)"${OUTLINE}/><circle cx="24" cy="25.5" r="3" fill="rgb(30 30 32)"${OUTLINE}/>`,
  ),
  [Item.FlatbedCar]: svg(
    `<rect x="2" y="17" width="28" height="4" fill="${css(WOOD, 1.25)}"${OUTLINE}/><path d="M5 17 V12 M27 17 V12" stroke="${css(DARK_WOOD, 1.3)}" stroke-width="1.6"/><rect x="3" y="21" width="26" height="2" fill="rgb(40 40 44)"/>` +
      `<circle cx="8" cy="25" r="2.6" fill="rgb(30 30 32)"${OUTLINE}/><circle cx="24" cy="25" r="2.6" fill="rgb(30 30 32)"${OUTLINE}/>`,
  ),
  [Item.PassengerCar]: svg(
    `<rect x="2" y="9" width="28" height="13" rx="2" fill="rgb(120 30 34)"${OUTLINE}/><rect x="2" y="7" width="28" height="3" rx="1.5" fill="rgb(60 60 64)"/>` +
      `<rect x="5" y="12" width="4" height="4" fill="rgb(230 210 150)"/><rect x="11" y="12" width="4" height="4" fill="rgb(230 210 150)"/><rect x="17" y="12" width="4" height="4" fill="rgb(230 210 150)"/><rect x="23" y="12" width="4" height="4" fill="rgb(230 210 150)"/>` +
      `<circle cx="8" cy="25" r="2.6" fill="rgb(30 30 32)"${OUTLINE}/><circle cx="24" cy="25" r="2.6" fill="rgb(30 30 32)"${OUTLINE}/>`,
  ),
  [Item.Boat]: svg(
    `<path d="M3 15 L29 15 L25 23 Q16 26 7 23 Z" fill="${css(WOOD, 1.2)}"${OUTLINE}/><path d="M5 18 L27 18" stroke="${css(DARK_WOOD, 1.2)}" stroke-width="1"/>` +
      `<path d="M2 25 Q6 23 10 25 T18 25 T26 25 T30 25" stroke="${css(WATER, 1.4)}" stroke-width="1.6" fill="none"/><line x1="20" y1="6" x2="13" y2="20" stroke="${css(DARK_WOOD, 1.3)}" stroke-width="1.6" stroke-linecap="round"/>`,
  ),
  [Item.Furnace]: cube(STONE, STONE, `<path d="M6 19 L13 22.5 L13 27 L6 23.5 Z" fill="rgb(20 12 8)"/><path d="M7.5 23 Q9.5 19.5 11.5 23.5 Z" fill="${css(FLAME)}"/>`),
  [Item.Stove]: cube(IRON, STONE, `<ellipse cx="12" cy="10" rx="3" ry="1.6" fill="rgb(30 30 30)"/><ellipse cx="20" cy="10" rx="3" ry="1.6" fill="rgb(30 30 30)"/>`),
  [Item.Anvil]: svg(`<path d="M4 9 L28 9 L24 14 L19 14 L19 20 L24 26 L8 26 L13 20 L13 14 L8 14 Z" fill="${css([0.16, 0.16, 0.18], 1.3)}"${OUTLINE}/><path d="M4 9 L28 9 L27 10.5 L5 10.5 Z" fill="rgb(255 255 255 / 0.3)"/>`),
  [Item.SmithingTable]: cube(DARK_WOOD, WOOD, `<rect x="10" y="7.5" width="5" height="2" fill="${css(IRON, 1.2)}"/><line x1="18" y1="7" x2="22" y2="11" stroke="${css(IRON, 1.2)}" stroke-width="1.5"/>`),
  [Item.Bed]: svg(`<rect x="3" y="15" width="26" height="8" fill="${css([0.6, 0.08, 0.08], 1.2)}"${OUTLINE}/><rect x="3" y="12" width="8" height="6" rx="1" fill="rgb(240 240 240)"${OUTLINE}/><rect x="3" y="22" width="3" height="5" fill="${css(WOOD, 1.2)}"/><rect x="26" y="22" width="3" height="5" fill="${css(WOOD, 1.2)}"/>`),
};

function craftingTable(): string {
  return cube(WOOD, DARK_WOOD, `<path d="M9.5 6.75 L22.5 13.25 M9.5 13.25 L22.5 6.75" stroke="${css(DARK_WOOD, 1.2)}" stroke-width="0.9"/><rect x="5" y="15" width="3" height="5" fill="${css(IRON)}"/><rect x="22" y="18" width="4" height="2" fill="${css(IRON)}"/>`);
}

/** Pictures of blocks with more to them than a colour (by material). */
const BLOCK_ICONS: Readonly<Partial<Record<MaterialId, () => string>>> = {
  [Material.Grass]: () => cube(materialColor(Material.Grass), materialColor(Material.Dirt), `<path d="M3 10 L16 17 L29 10 L29 13 L16 20 L3 13 Z" fill="${css(materialColor(Material.Grass), 0.9)}"/>`),
  [Material.CoalOre]: () => cube(STONE, STONE, specks([0.02, 0.02, 0.02], 2.2)),
  [Material.IronOre]: () => cube(STONE, STONE, specks([0.7, 0.45, 0.32], 2.2)),
  [Material.CopperOre]: () => cube(STONE, STONE, specks([0.25, 0.65, 0.5], 2.2)),
  [Material.GoldOre]: () => cube(STONE, STONE, specks(GOLD, 2.2)),
  [Material.Gravel]: () => cube(materialColor(Material.Gravel), materialColor(Material.Gravel), specks([0.2, 0.18, 0.16], 1.8)),
  [Material.Cobblestone]: () => cube(STONE, STONE, `<path d="M8 8 L14 11 M18 6 L22 11 M10 13 L16 15 M6 16 L6 22 M11 22 L11 27 M21 19 L21 25 M25 15 L25 22" stroke="rgb(0 0 0 / 0.35)" stroke-width="1"/>`),
  [Material.Planks]: () => cube(materialColor(Material.Planks), materialColor(Material.Planks), `<path d="M6 8.5 L19 15 M10 6.5 L23 13 M3 16 L16 23 M16 23 L29 16" stroke="rgb(0 0 0 / 0.3)" stroke-width="0.9"/>`),
  [Material.Wood]: () => cube(materialColor(Material.Planks), materialColor(Material.Wood), `<ellipse cx="16" cy="10" rx="6" ry="3" fill="none" stroke="rgb(0 0 0 / 0.3)" stroke-width="0.9"/><ellipse cx="16" cy="10" rx="2.6" ry="1.3" fill="none" stroke="rgb(0 0 0 / 0.3)" stroke-width="0.9"/>`),
  [Material.TNT]: () => cube([0.7, 0.06, 0.04], [0.7, 0.06, 0.04], `<path d="M3 15 L16 22 L16 25 L3 18 Z M16 22 L29 15 L29 18 L16 25 Z" fill="rgb(235 235 225)"/><path d="M16 10 Q17 6 20 5" stroke="rgb(60 50 40)" stroke-width="1.3" fill="none"/><circle cx="20.5" cy="4.8" r="1.4" fill="rgb(255 200 80)"/>`),
  [Material.C4]: () => cube([0.55, 0.5, 0.36], [0.55, 0.5, 0.36], `<path d="M8 19 Q12 14 18 20 Q22 24 26 18" stroke="rgb(200 30 20)" stroke-width="1.2" fill="none"/><rect x="12" y="7.5" width="8" height="3" fill="rgb(30 30 30)"/>`),
  [Material.Coal]: () => lump([0.03, 0.03, 0.035], 0.3),
  [Material.RawIron]: () => lump([0.55, 0.36, 0.26]),
  [Material.RawCopper]: () => lump([0.68, 0.36, 0.2]),
  [Material.RawGold]: () => lump(GOLD, 0.6),
  [Material.Snow]: () => cube(materialColor(Material.Snow), materialColor(Material.Snow), specks([1, 1, 1], 1.4)),
};

/** Leaves: the cube in their green, with darker specks (gaps in the leaves). */
const LEAVES = new Set<MaterialId>([Material.Leaves, Material.Needles, Material.JungleLeaves, Material.AcaciaLeaves]);

/** The icon (an SVG, as markup) for item or block `id`, or null for one without (players' designs). */
export function iconSvg(id: ItemId): string | null {
  const item = ITEM_ICONS[id];
  if (item) return item;
  if (id >= 1000) return null;
  if (isWater(id)) return cube(WATER, WATER, `<path d="M6 9 Q9 7.5 12 9 T18 9 M14 12.5 Q17 11 20 12.5 T26 12.5" stroke="rgb(255 255 255 / 0.55)" stroke-width="1" fill="none"/>`);
  const special = BLOCK_ICONS[id];
  if (special) return special();
  const c = materialColor(id);
  if (LEAVES.has(id)) return cube(c, c, specks([c[0] * 0.45, c[1] * 0.45, c[2] * 0.45], 2));
  return cube(c);
}
