import {
  HOTBAR_SLOTS,
  PLACEABLE,
  creativeHotbar,
  formatBlocks,
  materialName,
  type GameMode,
  type MaterialId,
  type ServerMessage,
} from '@super-vox/shared';
import { materialColor } from './materials.js';

type InventoryMessage = Extract<ServerMessage, { type: 'inventory' }>;

const css = (c: readonly [number, number, number]) => `rgb(${c.map((v) => Math.round(Math.min(1, v) * 255)).join(' ')})`;

/**
 * The hotbar (bottom of the screen; 1-9 pick a slot) and the inventory screen (E): in survival,
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

  constructor(
    parent: HTMLElement,
    /** Called when the hotbar is rearranged (to tell the server). */
    private readonly onHotbar: (hotbar: (MaterialId | null)[]) => void,
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
    this.panel.append(this.title, hint, this.grid);
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

  /** The material in the selected slot, if any. */
  get material(): MaterialId | null {
    return this.hotbar[this.selected] ?? null;
  }

  /** How much of a material there is (survival; Infinity in creative). */
  amount(m: MaterialId): number {
    return this.mode === 'creative' ? Infinity : (this.items.get(m) ?? 0);
  }

  update(msg: InventoryMessage): void {
    this.mode = msg.mode;
    this.items = new Map(msg.items);
    this.hotbar = Array.from({ length: HOTBAR_SLOTS }, (_, i) => msg.hotbar[i] ?? null);
    this.render();
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
    if (this.mode === 'creative') return [...PLACEABLE];
    return [...this.items.keys()].filter((m) => (this.items.get(m) ?? 0) > 0).sort((a, b) => PLACEABLE.indexOf(a) - PLACEABLE.indexOf(b));
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

  private swatch(m: MaterialId | null, amount: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'swatch';
    if (m !== null) {
      el.style.background = css(materialColor(m));
      el.title = materialName(m);
      const n = document.createElement('span');
      n.textContent = amount;
      el.append(n);
    }
    return el;
  }

  private render(): void {
    const amountText = (m: MaterialId) => (this.mode === 'creative' ? '' : formatBlocks(this.items.get(m) ?? 0));
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
        label.textContent = materialName(m) + (this.mode === 'creative' ? '' : ` · ${amountText(m)}`);
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
  }
}
