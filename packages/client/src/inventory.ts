import {
  ALL_ITEMS,
  HOTBAR_SLOTS,
  Item,
  RECIPES,
  cannotCraft,
  creativeHotbar,
  describeRecipe,
  formatAmount,
  formatBlocks,
  Material,
  isBlock,
  itemName,
  type GameMode,
  type ItemId,
  type MaterialId,
  type Recipe,
  type ServerMessage,
} from '@super-vox/shared';
import { materialColor } from './materials.js';

type InventoryMessage = Extract<ServerMessage, { type: 'inventory' }>;

/** Wheel travel (pixels) per hotbar step: about one mouse-wheel notch. */
const WHEEL_STEP = 40;

/** Whole hotbar steps in `travel + deltaY` wheel pixels (down = next), and the travel left over. */
export function wheelSteps(travel: number, deltaY: number): { steps: number; travel: number } {
  const t = travel + deltaY;
  const steps = Math.trunc(t / WHEEL_STEP) || 0; // (never -0)
  return { steps, travel: t - steps * WHEEL_STEP };
}

/** A linear-light colour (as the renderer keeps them) for CSS (sRGB). */
const css = (c: readonly [number, number, number]) => `rgb(${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) ** (1 / 2.2) * 255)).join(' ')})`;

/** How items that aren't blocks look in slots: a colour and a glyph. */
const ITEM_LOOK: Record<number, { color: readonly [number, number, number]; glyph: string }> = {
  [Item.Stick]: { color: [0.2, 0.12, 0.06], glyph: '/' },
  [Item.WoodenSword]: { color: [0.45, 0.29, 0.13], glyph: '†' },
  [Item.StoneSword]: { color: [0.22, 0.22, 0.23], glyph: '†' },
  [Item.Fence]: { color: [0.45, 0.29, 0.13], glyph: '#' },
  [Item.Gate]: { color: [0.45, 0.29, 0.13], glyph: 'H' },
  [Item.Door]: { color: [0.33, 0.17, 0.07], glyph: '▯' },
  [Item.Bucket]: { color: [0.45, 0.29, 0.13], glyph: 'U' },
  [Item.Pork]: { color: [0.93, 0.6, 0.6], glyph: 'p' },
};

function colorOf(id: ItemId): string {
  return css(isBlock(id) ? materialColor(id) : (ITEM_LOOK[id]?.color ?? [1, 0, 1]));
}

/**
 * The hotbar (bottom of the screen; 1-9 or the wheel pick a slot) and the inventory screen (E): in survival,
 * the materials you have and how much (in blocks); in creative, everything placeable. Clicking a
 * material in the inventory puts it in the selected hotbar slot. Until the server sends an
 * inventory (servers without accounts), it's creative.
 */
export class InventoryUi {
  mode: GameMode = 'creative';
  private items = new Map<MaterialId, number>();
  private hotbar: (MaterialId | null)[] = creativeHotbar();
  private selected = 0;
  private readonly bar: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly title: HTMLElement;
  private readonly recipes: HTMLElement;
  private readonly note: HTMLElement;

  constructor(
    parent: HTMLElement,
    /** Called when the hotbar is rearranged (to tell the server). */
    private readonly onHotbar: (hotbar: (ItemId | null)[]) => void,
    /** Called to make a recipe (the server answers with the new inventory, or why not). */
    private readonly onCraft: (recipe: string) => void,
  ) {
    this.bar = document.createElement('div');
    this.bar.id = 'hotbar';
    this.panel = document.createElement('div');
    this.panel.id = 'inventory';
    this.panel.hidden = true;
    this.title = document.createElement('h2');
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Click a material to put it in the selected hotbar slot (1-9 picks the slot). E or Esc closes.';
    this.grid = document.createElement('div');
    this.grid.className = 'grid';
    const crafting = document.createElement('h3');
    crafting.textContent = 'Crafting';
    this.note = document.createElement('p');
    this.note.className = 'note';
    this.recipes = document.createElement('div');
    this.recipes.className = 'recipes';
    this.panel.append(this.title, hint, this.grid, crafting, this.note, this.recipes);
    parent.append(this.bar, this.panel);
    this.render();
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  /** Off for players who can't build (not signed in): no hotbar, no inventory. */
  set enabled(on: boolean) {
    this.bar.hidden = !on;
    if (!on) this.panel.hidden = true;
  }

  get enabled(): boolean {
    return !this.bar.hidden;
  }

  /** What's in the selected slot, if anything (a material, or an item; see isBlock). */
  get material(): ItemId | null {
    return this.hotbar[this.selected] ?? null;
  }

  /** Shows a line in the inventory (e.g. why something couldn't be made). */
  say(text: string): void {
    this.note.textContent = text;
  }

  /** How much of a material there is (survival; Infinity in creative). */
  amount(m: MaterialId): number {
    return this.mode === 'creative' ? Infinity : (this.items.get(m) ?? 0);
  }

  update(msg: InventoryMessage): void {
    this.note.textContent = '';
    this.mode = msg.mode;
    this.items = new Map(msg.items);
    this.hotbar = Array.from({ length: HOTBAR_SLOTS }, (_, i) => msg.hotbar[i] ?? null);
    this.render();
  }

  private wheelTravel = 0;
  private lastWheel = 0;

  /** Steps through the hotbar with the mouse wheel (deltaY pixels; one step per notch). */
  scroll(deltaY: number, now = performance.now()): void {
    const r = wheelSteps(now - this.lastWheel > 300 ? 0 : this.wheelTravel, deltaY);
    this.lastWheel = now;
    this.wheelTravel = r.travel;
    if (r.steps) this.select((((this.selected + r.steps) % HOTBAR_SLOTS) + HOTBAR_SLOTS) % HOTBAR_SLOTS);
  }

  select(slot: number): void {
    if (slot < 0 || slot >= HOTBAR_SLOTS) return;
    this.selected = slot;
    this.render();
  }

  toggle(): void {
    if (!this.enabled) return;
    this.panel.hidden = !this.panel.hidden;
    this.render();
  }

  close(): void {
    this.panel.hidden = true;
  }

  /** Materials the inventory screen lists. */
  private listed(): MaterialId[] {
    if (this.mode === 'creative') return [...ALL_ITEMS];
    // (Water is carried in buckets: the bucket shows it.)
    return [...this.items.keys()].filter((m) => (this.items.get(m) ?? 0) > 0 && m !== Material.Water).sort((a, b) => ALL_ITEMS.indexOf(a) - ALL_ITEMS.indexOf(b));
  }

  private place(m: MaterialId): void {
    const hotbar = [...this.hotbar];
    // A material sits in one slot: moving it empties where it was.
    const was = hotbar.indexOf(m);
    if (was >= 0) hotbar[was] = null;
    hotbar[this.selected] = m;
    this.hotbar = hotbar;
    this.onHotbar(hotbar);
    this.render();
  }

  private swatch(m: ItemId | null, amount: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'swatch';
    if (m !== null) {
      el.style.background = colorOf(m);
      el.title = itemName(m);
      const glyph = ITEM_LOOK[m]?.glyph;
      if (glyph) {
        const g = document.createElement('b');
        g.textContent = glyph;
        el.append(g);
      }
      const n = document.createElement('span');
      n.textContent = amount;
      el.append(n);
    }
    return el;
  }

  private render(): void {
    // A bucket shows the water it holds (in m³).
    const amountText = (m: ItemId) =>
      this.mode === 'creative' ? '' : m === Item.Bucket ? `${formatBlocks(this.items.get(Material.Water) ?? 0)} m³` : formatAmount(m, this.items.get(m) ?? 0);
    this.bar.replaceChildren(
      ...this.hotbar.map((m, i) => {
        const slot = document.createElement('div');
        slot.className = 'slot' + (i === this.selected ? ' selected' : '') + (m !== null && this.amount(m) <= 0 ? ' empty' : '');
        const key = document.createElement('i');
        key.textContent = String(i + 1);
        slot.append(this.swatch(m, m === null ? '' : amountText(m)), key);
        slot.addEventListener('click', () => this.select(i));
        return slot;
      }),
    );
    if (this.panel.hidden) return;
    this.title.textContent = this.mode === 'creative' ? 'Creative: everything' : 'Inventory';
    const listed = this.listed();
    this.grid.replaceChildren(
      ...listed.map((m) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'item' + (this.hotbar[this.selected] === m ? ' current' : '');
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = itemName(m) + (this.mode === 'creative' ? '' : ` · ${amountText(m)}`);
        item.append(this.swatch(m, ''), label);
        item.addEventListener('click', () => this.place(m));
        return item;
      }),
    );
    if (!listed.length) {
      const none = document.createElement('p');
      none.className = 'hint';
      none.textContent = 'Nothing yet: mine something.';
      this.grid.append(none);
    }
    this.recipes.replaceChildren(...RECIPES.map((r) => this.recipeButton(r)));
  }

  /** A recipe, dimmed (with the reason) when you can't make it; the server has the last word. */
  private recipeButton(recipe: Recipe): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    // Whether a table is near is the server's to judge: here only the ingredients count.
    const why = this.mode === 'creative' ? 'creative: everything is already yours' : cannotCraft(recipe, this.items, true);
    b.className = 'recipe' + (why ? ' cant' : '');
    const [out] = recipe.output;
    const text = document.createElement('div');
    text.className = 'label';
    text.textContent = describeRecipe(recipe) + (recipe.table ? ' · at a crafting table' : '');
    b.append(this.swatch(out, ''), text);
    b.title = why ?? 'make it';
    b.addEventListener('click', () => {
      if (why) this.say(why);
      else this.onCraft(recipe.id);
    });
    return b;
  }
}
