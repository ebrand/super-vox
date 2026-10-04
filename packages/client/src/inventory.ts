import {
  ALL_ITEMS,
  HOTBAR_SLOTS,
  Item,
  RECIPES,
  RECIPE_GROUPS,
  cannotCraft,
  creativeHotbar,
  formatAmount,
  formatBlocks,
  Material,
  designMaterial,
  designOfItem,
  isBlock,
  itemName,
  stored,
  type GameMode,
  type ItemId,
  type MaterialId,
  type Recipe,
  type ServerMessage,
} from '@super-vox/shared';
import { TABLE_SLOTS, addToTable, available, couldMake, describeEntry, fillFor, matchRecipes, onTable, timesAvailable, type Table } from './crafting.js';
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
  [Item.CraftingTable]: { color: [0.33, 0.17, 0.07], glyph: '⊓' },
  [Item.WoodenPickaxe]: { color: [0.45, 0.29, 0.13], glyph: '⛏' },
  [Item.StonePickaxe]: { color: [0.22, 0.22, 0.23], glyph: '⛏' },
  [Item.WoodenAxe]: { color: [0.45, 0.29, 0.13], glyph: 'Γ' },
  [Item.StoneAxe]: { color: [0.22, 0.22, 0.23], glyph: 'Γ' },
  [Item.WoodenShovel]: { color: [0.45, 0.29, 0.13], glyph: '♠' },
  [Item.StoneShovel]: { color: [0.22, 0.22, 0.23], glyph: '♠' },
};

/** How an item looks in slots: built-in ones as ITEM_LOOK has them; designed objects, the colour of what they're mostly made of, and their initial. */
function lookOf(id: ItemId): { color: readonly [number, number, number]; glyph: string } | undefined {
  // (Built-in items keep their look, even placing a design: the crafting table.)
  if (ITEM_LOOK[id]) return ITEM_LOOK[id];
  const design = designOfItem(id);
  if (design) return { color: materialColor(designMaterial(design)), glyph: design.name.trim()[0]!.toUpperCase() };
  return undefined;
}

function colorOf(id: ItemId): string {
  return css(isBlock(id) ? materialColor(id) : (lookOf(id)?.color ?? [1, 0, 1]));
}

/** The window's tabs: those that work, and the stations still to come (shown, greyed, with why). */
type Tab = 'inventory' | 'crafting' | 'recipes';
const COMING: readonly { name: string; why: string }[] = [
  { name: 'Smelting', why: 'needs a furnace (coming with ores)' },
  { name: 'Cooking', why: 'needs a stove or campfire (coming with the furnace)' },
];

/** How the inventory tab orders things. */
type Sort = 'kind' | 'name' | 'amount';

/** What's being dragged (see DataTransfer): something from the inventory, or a hotbar slot. */
const DRAG_TYPE = 'application/x-super-vox';

/**
 * The hotbar (bottom of the screen; 1-0 or the wheel pick a slot) and the inventory window (E),
 * with tabs (see BACKLOG item 21):
 * - **Inventory:** what you have (survival) or everything (creative), as cards with how much;
 *   search and sort; click or drag one onto the hotbar; drag one to the bin to throw it away.
 * - **Crafting** (survival): a table of ingredients (nothing leaves the inventory until Make), what
 *   they could become, the recipe(s) they make (Make, or Cancel), and the recipes, any of which
 *   fills the table in one click.
 * The hotbar's along the top of every tab. Until the server sends an inventory (servers without
 * accounts), it's creative.
 */
export class InventoryUi {
  mode: GameMode = 'creative';
  private items = new Map<MaterialId, number>();
  private hotbar: (MaterialId | null)[] = creativeHotbar();
  private selected = 0;
  private tab: Tab = 'inventory';
  private table: Table = [];
  /** Of the recipes the table makes (when more than one does), the one chosen. */
  private chosen: string | null = null;
  private search = '';
  private sort: Sort = 'kind';
  /** Something to throw away, waiting for a yes. */
  private discarding: ItemId | null = null;
  private readonly bar: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly windowBar: HTMLElement;
  private readonly note: HTMLElement;
  private readonly body: HTMLElement;

  constructor(
    parent: HTMLElement,
    /** Called when the hotbar is rearranged (to tell the server). */
    private readonly onHotbar: (hotbar: (ItemId | null)[]) => void,
    /** Called to make a recipe once (the server answers with the new inventory, or why not). */
    private readonly onCraft: (recipe: string) => void,
    /** Called to throw away an amount (stored: blocks by volume, items by count) of something. */
    private readonly onDiscard: (item: ItemId, amount: number) => void = () => {},
    /** Whether a placed crafting table is within reach (TABLE_REACH) of the player. */
    private readonly nearTable: () => boolean = () => false,
  ) {
    this.bar = document.createElement('div');
    this.bar.id = 'hotbar';
    this.panel = document.createElement('div');
    this.panel.id = 'inventory';
    this.panel.hidden = true;
    this.tabs = document.createElement('div');
    this.tabs.className = 'tabs';
    this.windowBar = document.createElement('div');
    this.windowBar.className = 'window-bar';
    this.note = document.createElement('p');
    this.note.className = 'note';
    this.body = document.createElement('div');
    this.body.className = 'body';
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = '1-0 picks a hotbar slot. E or Esc closes.';
    this.panel.append(this.tabs, this.windowBar, this.note, this.body, hint);
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

  /** Draws it again (the designs changed: new items and recipes, or names). */
  refresh(): void {
    this.render();
  }

  update(msg: InventoryMessage): void {
    this.note.textContent = '';
    this.mode = msg.mode;
    this.items = new Map(msg.items);
    this.hotbar = Array.from({ length: HOTBAR_SLOTS }, (_, i) => msg.hotbar[i] ?? null);
    if (this.mode === 'creative') this.tab = 'inventory';
    // (What's on the table can't be more than there is now.)
    this.table = this.table.map(([id, n]) => [id, Math.min(n, this.has(id))] as const).filter(([, n]) => n > 0);
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
    if (this.panel.hidden) this.closed();
    this.render();
  }

  close(): void {
    if (this.panel.hidden) return;
    this.panel.hidden = true;
    this.closed();
    this.render(); // (the hotbar at the bottom back)
  }

  /** Closing gives back what was on the table (it never left the inventory). */
  private closed(): void {
    this.table = [];
    this.chosen = null;
    this.discarding = null;
  }

  /**
   * Whether a crafting table is placed within reach (the server's rule too). Until one is, crafting
   * is just combining things, and the recipes that need one wait.
   */
  private hasTable(): boolean {
    return this.mode === 'creative' || this.nearTable();
  }

  /** How much of `id` there is to craft with (in recipes' terms; creative: unlimited). */
  private has(id: ItemId): number {
    return this.mode === 'creative' ? Infinity : available(id, this.items);
  }

  /** What there is (survival; creative: everything), searched and sorted. */
  private listed(): ItemId[] {
    let ids: ItemId[] =
      this.mode === 'creative'
        ? [...ALL_ITEMS]
        : // (Water is carried in buckets: the bucket shows it.)
          [...this.items.keys()].filter((m) => (this.items.get(m) ?? 0) > 0 && m !== Material.Water);
    const q = this.search.trim().toLowerCase();
    if (q) ids = ids.filter((m) => itemName(m).toLowerCase().includes(q));
    const kind = (m: ItemId) => (ALL_ITEMS.indexOf(m) < 0 ? 1e6 + m : ALL_ITEMS.indexOf(m));
    const by: Record<Sort, (a: ItemId, b: ItemId) => number> = {
      kind: (a, b) => kind(a) - kind(b),
      name: (a, b) => itemName(a).localeCompare(itemName(b)),
      amount: (a, b) => (this.items.get(b) ?? 0) / stored(b, 1) - (this.items.get(a) ?? 0) / stored(a, 1) || kind(a) - kind(b),
    };
    return ids.sort(by[this.sort]);
  }

  /** Puts `m` in hotbar slot `slot` (a thing sits in one slot: moving it empties where it was). */
  private toSlot(m: ItemId, slot: number): void {
    const hotbar = [...this.hotbar];
    const was = hotbar.indexOf(m);
    if (was >= 0) hotbar[was] = hotbar[slot] ?? null; // (swapping with what was there)
    hotbar[slot] = m;
    this.hotbar = hotbar;
    this.onHotbar(hotbar);
    this.render();
  }

  /** The first empty hotbar slot (else the selected one). */
  private freeSlot(): number {
    const i = this.hotbar.indexOf(null);
    return i >= 0 ? i : this.selected;
  }

  private addToTable(id: ItemId, n: number): void {
    this.table = addToTable(this.table, id, n, this.mode === 'creative' ? null : this.items);
    this.chosen = null;
    this.render();
  }

  /** Makes what the table holds (the recipe chosen, if it holds more than one), as many times as it does. */
  private make(): void {
    const matches = matchRecipes(this.table);
    const match = matches.find((m) => m.recipe.id === this.chosen) ?? (matches.length === 1 ? matches[0] : undefined);
    if (!match) return this.say(matches.length ? 'choose what to make' : 'that makes nothing');
    if (match.recipe.table && !this.hasTable()) return this.say('that needs a crafting table placed nearby');
    for (let i = 0; i < match.times; i++) this.onCraft(match.recipe.id);
    this.table = [];
    this.chosen = null;
    this.say(`making ${describeEntry(match.recipe.output[0], match.recipe.output[1] * match.times)}${match.recipe.table ? ' (at a crafting table)' : ''}`);
    this.render();
  }

  private swatch(m: ItemId | null, amount: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'swatch';
    if (m !== null) {
      el.style.background = colorOf(m);
      el.title = itemName(m);
      const glyph = lookOf(m)?.glyph;
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

  /** How much of `m` there is, for people (a bucket: the water it holds). */
  private amountText(m: ItemId): string {
    if (this.mode === 'creative') return '';
    if (m === Item.Bucket) return `${formatBlocks(this.items.get(Material.Water) ?? 0)} m³`;
    return formatAmount(m, this.items.get(m) ?? 0) + (isBlock(m) ? ' m³' : '');
  }

  /** A hotbar slot (in the bar at the bottom, or along the top of the window): click selects, drops land. */
  private slot(m: ItemId | null, i: number): HTMLElement {
    const slot = document.createElement('div');
    slot.className = 'slot' + (i === this.selected ? ' selected' : '') + (m !== null && this.amount(m) <= 0 ? ' empty' : '');
    const key = document.createElement('i');
    key.textContent = String((i + 1) % 10);
    slot.append(this.swatch(m, m === null ? '' : this.amountText(m).replace(' m³', '')), key);
    slot.addEventListener('click', () => this.select(i));
    if (m !== null) this.draggable(slot, `slot:${i}`);
    this.dropTarget(slot, (what) => {
      if (what.startsWith('item:')) this.toSlot(Number(what.slice(5)), i);
      else if (what.startsWith('slot:')) {
        const from = Number(what.slice(5)), id = this.hotbar[from];
        if (id !== null && id !== undefined && from !== i) this.toSlot(id, i);
      }
    });
    return slot;
  }

  private draggable(el: HTMLElement, what: string): void {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData(DRAG_TYPE, what);
      e.dataTransfer?.setData('text/plain', what);
    });
  }

  private dropTarget(el: HTMLElement, drop: (what: string) => void): void {
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('over');
      const what = e.dataTransfer?.getData(DRAG_TYPE) || e.dataTransfer?.getData('text/plain') || '';
      if (what) drop(what);
    });
  }

  private render(): void {
    this.bar.replaceChildren(...this.hotbar.map((m, i) => this.slot(m, i)));
    // (While the window's open, its own hotbar along the top is the one.)
    this.bar.style.visibility = this.panel.hidden ? '' : 'hidden';
    if (this.panel.hidden) return;
    // Tabs: those that work (in creative, only the inventory), then the stations to come, greyed.
    const tabs: HTMLElement[] = [];
    const tab = (label: string, on: boolean, click: (() => void) | null, why?: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab' + (on ? ' on' : '');
      b.textContent = label;
      b.disabled = click === null;
      if (why) b.title = why;
      if (click) b.addEventListener('click', click);
      tabs.push(b);
    };
    tab(this.mode === 'creative' ? 'Creative: everything' : 'Inventory', this.tab === 'inventory', () => this.show('inventory'));
    if (this.mode === 'survival') {
      tab('Crafting', this.tab === 'crafting', () => this.show('crafting'));
      tab('Recipes', this.tab === 'recipes', () => this.show('recipes'));
      for (const c of COMING) tab(c.name, false, null, c.why);
    }
    this.tabs.replaceChildren(...tabs);
    this.windowBar.replaceChildren(...this.hotbar.map((m, i) => this.slot(m, i)));
    this.body.replaceChildren(...(this.tab === 'crafting' ? this.craftingTab() : this.tab === 'recipes' ? this.recipesTab() : this.inventoryTab()));
  }

  private show(tab: Tab): void {
    this.tab = tab;
    this.discarding = null;
    this.render();
  }

  // ---- The inventory tab.

  private inventoryTab(): HTMLElement[] {
    const tools = document.createElement('div');
    tools.className = 'toolbar';
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search';
    search.value = this.search;
    search.addEventListener('input', () => {
      this.search = search.value;
      this.renderKeepingFocus(search);
    });
    const sort = document.createElement('select');
    for (const [v, label] of [['kind', 'By kind'], ['name', 'By name'], ['amount', 'By amount']] as const) sort.add(new Option(label, v, false, v === this.sort));
    sort.addEventListener('change', () => {
      this.sort = sort.value as Sort;
      this.render();
    });
    tools.append(search, sort);
    if (this.mode === 'survival') tools.append(this.bin());
    const grid = document.createElement('div');
    grid.className = 'grid';
    const listed = this.listed();
    grid.append(
      ...listed.map((m) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'item' + (this.hotbar[this.selected] === m ? ' current' : '');
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = itemName(m);
        const count = document.createElement('div');
        count.className = 'count';
        count.textContent = this.amountText(m);
        card.append(this.swatch(m, ''), label, count);
        card.title = 'click: into the selected hotbar slot · shift-click: into a free one · or drag it';
        card.addEventListener('click', (e) => this.toSlot(m, e.shiftKey ? this.freeSlot() : this.selected));
        this.draggable(card, `item:${m}`);
        return card;
      }),
    );
    if (!listed.length) {
      const none = document.createElement('p');
      none.className = 'hint';
      none.textContent = this.search ? 'Nothing by that name.' : 'Nothing yet: mine something.';
      grid.append(none);
    }
    return [tools, grid];
  }

  /** The bin: drop something on it, then say yes, and it's thrown away (all of it). */
  private bin(): HTMLElement {
    const bin = document.createElement('div');
    bin.className = 'bin';
    if (this.discarding === null) {
      bin.textContent = '🗑 drop here to throw away';
      this.dropTarget(bin, (what) => {
        const id = what.startsWith('item:') ? Number(what.slice(5)) : what.startsWith('slot:') ? this.hotbar[Number(what.slice(5))] : null;
        if (id === null || id === undefined || (this.items.get(id) ?? 0) <= 0) return;
        this.discarding = id;
        this.render();
      });
      return bin;
    }
    const id = this.discarding;
    bin.classList.add('asking');
    bin.append(`Throw away all ${this.amountText(id)} ${itemName(id)}? `);
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.textContent = 'Yes';
    yes.addEventListener('click', () => {
      this.onDiscard(id, this.items.get(id) ?? 0);
      this.discarding = null;
      this.render();
    });
    const no = document.createElement('button');
    no.type = 'button';
    no.textContent = 'No';
    no.addEventListener('click', () => {
      this.discarding = null;
      this.render();
    });
    bin.append(yes, no);
    return bin;
  }

  /** Re-renders, putting the caret back where it was (typing in the search box). */
  private renderKeepingFocus(input: HTMLInputElement): void {
    const at = input.selectionStart;
    this.render();
    const again = this.body.querySelector<HTMLInputElement>('input[type=search]');
    if (again) {
      again.focus();
      if (at !== null) again.setSelectionRange(at, at);
    }
  }

  // ---- The crafting tab.

  private craftingTab(): HTMLElement[] {
    // The table: its slots (filled ones show how much: click takes one off, shift-click all,
    // the wheel adds or takes one), then empty ones; drop things on it to add them.
    const table = document.createElement('div');
    table.className = 'table';
    for (let i = 0; i < TABLE_SLOTS; i++) {
      const entry = this.table[i];
      const slot = document.createElement('div');
      slot.className = 'tslot' + (entry ? '' : ' free');
      if (entry) {
        const [id, n] = entry;
        slot.append(this.swatch(id, String(n)));
        slot.title = `${describeEntry(id, n)} · click: one off · shift-click: all off · wheel: more or less`;
        slot.addEventListener('click', (e) => this.addToTable(id, e.shiftKey ? -n : -1));
        slot.addEventListener('wheel', (e) => {
          e.preventDefault();
          this.addToTable(id, e.deltaY < 0 ? 1 : -1);
        });
      }
      table.append(slot);
    }
    this.dropTarget(table, (what) => {
      const id = what.startsWith('item:') ? Number(what.slice(5)) : what.startsWith('slot:') ? this.hotbar[Number(what.slice(5))] : null;
      if (id !== null && id !== undefined) this.addToTable(id, 1);
    });
    // Without a crafting table to hand, just a place to combine things; with one, the table itself.
    const hasTable = this.hasTable();
    const tableBox = document.createElement('div');
    tableBox.className = 'station' + (hasTable ? ' wood' : '');
    tableBox.append(table);
    if (hasTable) {
      const caption = document.createElement('div');
      caption.className = 'caption';
      caption.textContent = 'Crafting table';
      tableBox.append(caption);
    }

    // What it could become, and what it makes.
    const could = document.createElement('p');
    could.className = 'could';
    const matches = matchRecipes(this.table);
    const might = couldMake(this.table).filter((r) => !matches.some((m) => m.recipe === r));
    could.textContent = !this.table.length
      ? hasTable
        ? 'Put things on the table (click or drag them below), or pick a recipe.'
        : 'Combine things (click or drag them below), or pick a recipe. A crafting table placed nearby makes more.'
      : might.length
        ? `could become: ${might.map((r) => itemName(r.output[0])).join(', ')}`
        : matches.length
          ? ''
          : 'that makes nothing';
    const result = document.createElement('div');
    result.className = 'result';
    if (matches.length) {
      const chosen = matches.length === 1 ? matches[0]!.recipe.id : this.chosen;
      for (const m of matches) {
        const [out, n] = m.recipe.output;
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'item' + (m.recipe.id === chosen ? ' current' : '');
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = itemName(out);
        const count = document.createElement('div');
        count.className = 'count';
        count.textContent = `${n * m.times}${isBlock(out) ? ' m³' : ''}` + (m.recipe.table && !hasTable ? ' · needs a crafting table' : '');
        if (m.recipe.table && !hasTable) card.classList.add('used');
        card.append(this.swatch(out, ''), label, count);
        card.addEventListener('click', () => {
          this.chosen = m.recipe.id;
          this.render();
        });
        result.append(card);
      }
      const actions = document.createElement('div');
      actions.className = 'actions';
      const make = document.createElement('button');
      make.type = 'button';
      make.className = 'primary';
      make.textContent = 'Make';
      const chosenMatch = matches.find((m) => m.recipe.id === chosen);
      make.disabled = !chosenMatch || (chosenMatch.recipe.table && !hasTable);
      make.addEventListener('click', () => this.make());
      actions.append(make);
      result.append(actions);
    }
    if (this.table.length) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.title = 'clear the table (nothing has left your inventory)';
      cancel.addEventListener('click', () => {
        this.table = [];
        this.chosen = null;
        this.render();
      });
      (result.querySelector('.actions') ?? result).append(cancel);
    }

    // Below: what you have (click: one onto the table; shift-click: all; or drag), and the recipes.
    const cols = document.createElement('div');
    cols.className = 'cols';
    const things = document.createElement('div');
    const thingsTitle = document.createElement('h3');
    thingsTitle.textContent = 'Your things';
    const grid = document.createElement('div');
    grid.className = 'grid small';
    for (const m of this.listed()) {
      const left = this.has(m) - onTable(this.table, m);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'item' + (left <= 0 ? ' used' : '');
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = itemName(m);
      const count = document.createElement('div');
      count.className = 'count';
      count.textContent = `${left}${isBlock(m) ? ' m³' : ''}`;
      card.append(this.swatch(m, ''), label, count);
      card.title = 'click: one onto the table · shift-click: all of it · or drag it';
      card.addEventListener('click', (e) => this.addToTable(m, e.shiftKey ? left : 1));
      this.draggable(card, `item:${m}`);
      grid.append(card);
    }
    things.append(thingsTitle, grid);
    const recipes = document.createElement('div');
    const recipesTitle = document.createElement('h3');
    recipesTitle.textContent = 'Recipes';
    const list = document.createElement('div');
    list.className = 'recipes';
    list.append(...RECIPES.map((r) => this.recipeButton(r)));
    recipes.append(recipesTitle, list);
    cols.append(things, recipes);
    return [tableBox, could, result, cols];
  }

  // ---- The recipes tab.

  /**
   * Every recipe, by group: what it makes, each ingredient with how much you have of what it needs
   * (dimmed where short), and Make (once) and Make all, straight off, no table to fill.
   */
  private recipesTab(): HTMLElement[] {
    const out: HTMLElement[] = [];
    const hasTable = this.hasTable();
    for (const { group, name } of RECIPE_GROUPS) {
      const recipes = RECIPES.filter((r) => r.group === group);
      if (!recipes.length) continue;
      const title = document.createElement('h3');
      title.textContent = name;
      const list = document.createElement('div');
      list.className = 'recipe-list';
      for (const recipe of recipes) {
        // (Those needing a crafting table wait for one.)
        const times = recipe.table && !hasTable ? 0 : timesAvailable(recipe, this.items);
        const row = document.createElement('div');
        row.className = 'recipe-row' + (times ? '' : ' cant');
        const [made, n] = recipe.output;
        const what = document.createElement('div');
        what.className = 'what';
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = `${itemName(made)} × ${n}${isBlock(made) ? ' m³' : ''}`;
        const where = document.createElement('div');
        where.className = 'where';
        where.textContent = recipe.table ? (hasTable ? 'at a crafting table' : 'needs a crafting table placed nearby') : 'anywhere';
        what.append(this.swatch(made, ''), label, where);
        const needs = document.createElement('div');
        needs.className = 'needs';
        for (const [id, k] of recipe.inputs) {
          const have = available(id, this.items);
          const need = document.createElement('span');
          need.className = 'need' + (have >= k ? '' : ' short');
          need.append(this.swatch(id, ''), `${itemName(id)} ${Math.min(have, 999)}/${k}${isBlock(id) ? ' m³' : ''}`);
          need.title = have >= k ? `you have ${have}` : `need ${k - have} more`;
          needs.append(need);
        }
        const actions = document.createElement('div');
        actions.className = 'actions';
        const make = (count: number, text: string) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = text;
          b.disabled = times < 1;
          b.title = times ? '' : (cannotCraft(recipe, this.items, hasTable) ?? '');
          b.addEventListener('click', () => {
            for (let i = 0; i < count; i++) this.onCraft(recipe.id);
            this.say(`making ${describeEntry(made, n * count)}${recipe.table ? ' (at a crafting table)' : ''}`);
          });
          return b;
        };
        actions.append(make(1, 'Make'));
        if (times > 1) actions.append(make(times, `Make all (${times})`));
        row.append(what, needs, actions);
        list.append(row);
      }
      out.push(title, list);
    }
    return out;
  }

  /** A recipe: clicking fills the table with it (dimmed, with why, when there isn't enough). */
  private recipeButton(recipe: Recipe): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    // (A table placed near is the server's to judge in the end; it's worked out here to show.)
    const why = cannotCraft(recipe, this.items, this.hasTable());
    b.className = 'recipe' + (why ? ' cant' : '');
    const [out, n] = recipe.output;
    const text = document.createElement('div');
    text.className = 'label';
    text.textContent = `${recipe.inputs.map(([id, k]) => describeEntry(id, k)).join(' + ')} → ${describeEntry(out, n)}` + (recipe.table ? ' · needs a crafting table' : '');
    b.append(this.swatch(out, ''), text);
    b.title = why ?? 'put it on the table';
    b.addEventListener('click', () => {
      if (recipe.table && !this.hasTable()) return this.say('that needs a crafting table placed nearby');
      const filled = fillFor(recipe, this.items);
      if (typeof filled === 'string') return this.say(filled);
      this.table = filled;
      this.chosen = recipe.id;
      this.say('');
      this.render();
    });
    return b;
  }
}
