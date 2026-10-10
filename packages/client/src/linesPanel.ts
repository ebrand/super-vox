import { DWELL_S, type Line } from '@super-vox/shared';
import type { WorldMapOverlay } from './worldMap.js';

/** A station as the map shows it: where it is (units). */
export interface StationPoint {
  id: number;
  name: string;
  x: number;
  z: number;
}

/**
 * Railway lines on the map (M): a "Lines" button, and a panel listing the world's lines (their
 * stations, how each is doing; End stops one), and making one: "New line", then click stations on
 * the map in order, set how long trains stop at each, Start (its train: the one standing at its
 * first station). The stations and the line being made are drawn on the map (see TrackMap).
 */
export class LinesPanel {
  private open = false;
  private picking: number[] | null = null;
  private lines: readonly Line[] = [];
  private stations: readonly StationPoint[] = [];
  private note = '';
  private readonly button: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  /** Told the line being made has changed (to draw it). */
  onPicking: ((ids: readonly number[] | null) => void) | null = null;

  constructor(
    private readonly map: WorldMapOverlay,
    /** Asks the server (answered with whether it could: `done`, with why not). */
    private readonly request: (msg: { type: 'lineCreate'; stations: number[]; dwell: number } | { type: 'lineDelete'; line: number }, done: (error: string | null) => void) => void,
  ) {
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.textContent = 'Lines';
    this.button.title = 'Railway lines: trains that run between stations on their own';
    this.button.onclick = () => {
      this.open = !this.open;
      if (!this.open) this.setPicking(null);
      this.show();
    };
    map.bar.append(this.button);
    this.panel = document.createElement('div');
    this.panel.className = 'lines-panel';
    this.panel.hidden = true;
    map.element.append(this.panel);
    map.clicked = (at, perPixel) => {
      if (!this.picking) return false;
      // The station nearest the click (within a dozen pixels, or 30 m).
      let best: StationPoint | null = null, bd = Math.max(30 * 16, 12 * perPixel);
      for (const s of this.stations) {
        const d = Math.hypot(s.x - at.x, s.z - at.z);
        if (d < bd) (bd = d), (best = s);
      }
      if (best && this.picking.at(-1) !== best.id) this.setPicking([...this.picking, best.id]);
      this.show();
      return true;
    };
    this.show();
  }

  update(lines: readonly Line[], stations: readonly StationPoint[]): void {
    this.lines = lines;
    this.stations = stations;
    if (this.open) this.show();
  }

  private setPicking(ids: number[] | null): void {
    this.picking = ids;
    this.onPicking?.(ids);
  }

  private nameOf = (id: number) => this.stations.find((s) => s.id === id)?.name ?? '(gone)';

  private show(): void {
    this.button.classList.toggle('on', this.open);
    this.panel.hidden = !this.open;
    if (!this.open) return;
    const el = (tag: string, text = '', cls = '') => {
      const e = document.createElement(tag);
      if (text) e.textContent = text;
      if (cls) e.className = cls;
      return e;
    };
    const parts: HTMLElement[] = [el('h3', 'Railway lines')];
    if (!this.lines.length && !this.picking) parts.push(el('p', this.stations.length < 2 ? 'Put two stations beside your track first (craft them; right-click track).' : 'No lines yet.', 'hint'));
    for (const l of this.lines) {
      const row = el('div', '', 'line-row');
      row.append(el('b', l.name), el('div', `${l.stations.map(this.nameOf).join(' → ')} · stops ${l.dwell < 60 ? `${l.dwell} s` : `${Math.round((l.dwell / 60) * 10) / 10} min`}`, 'hint'), el('div', l.train === null ? 'no train' : l.status));
      const end = el('button', 'End') as HTMLButtonElement;
      end.type = 'button';
      end.onclick = () => this.request({ type: 'lineDelete', line: l.id }, (e) => ((this.note = e ?? ''), this.show()));
      row.append(end);
      parts.push(row);
    }
    if (!this.picking) {
      const make = el('button', 'New line') as HTMLButtonElement;
      make.type = 'button';
      make.onclick = () => {
        this.note = '';
        this.setPicking([]);
        this.show();
      };
      parts.push(make);
    } else {
      parts.push(el('p', this.picking.length ? this.picking.map(this.nameOf).join(' → ') : 'Click stations on the map, in the order the line goes.', 'picked'));
      const dwell = el('label', 'Stop at each for ') as HTMLLabelElement;
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0.5';
      input.max = '30';
      input.step = '0.5';
      input.value = String(DWELL_S / 60);
      dwell.append(input, document.createTextNode(' min'));
      const start = el('button', 'Start') as HTMLButtonElement;
      start.type = 'button';
      start.disabled = this.picking.length < 2;
      start.title = 'its train: the one standing at its first station (an engine, no one in it)';
      start.onclick = () =>
        this.request({ type: 'lineCreate', stations: this.picking!, dwell: Math.round(Math.max(0.5, Number(input.value) || 2) * 60) }, (e) => {
          this.note = e ?? '';
          if (!e) this.setPicking(null);
          this.show();
        });
      const undo = el('button', 'Last away') as HTMLButtonElement;
      undo.type = 'button';
      undo.onclick = () => (this.setPicking(this.picking!.slice(0, -1)), this.show());
      const cancel = el('button', 'Cancel') as HTMLButtonElement;
      cancel.type = 'button';
      cancel.onclick = () => (this.setPicking(null), this.show());
      const buttons = el('div', '', 'buttons');
      buttons.append(start, undo, cancel);
      parts.push(dwell, buttons);
    }
    if (this.note) parts.push(el('p', `✗ ${this.note}`, 'bad'));
    this.panel.replaceChildren(...parts);
  }
}
