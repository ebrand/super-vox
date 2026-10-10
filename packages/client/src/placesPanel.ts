import { UNITS_PER_METER } from '@super-vox/shared';
import type { WorldMapOverlay } from './worldMap.js';

/** A place on the map (see PlacesPanel): what kind, its name, where (units), and a word about it. */
export interface Place {
  kind: 'village' | 'camp' | 'post';
  name: string;
  x: number;
  z: number;
  about: string;
}

const KIND: Record<Place['kind'], string> = { village: 'Villages', camp: 'Outlaw camps', post: 'Trading posts' };
/** Directions, a sixteenth of a turn each (north: -z). */
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/**
 * Places on the map (M): a "Places" button, and a list of the world's villages, outlaw camps and
 * trading posts, nearest first, each with how far and which way it is from you. Show: the map
 * there; Go: off there (where travel's allowed: creative).
 */
export class PlacesPanel {
  private open = false;
  private places: readonly Place[] = [];
  private readonly button: HTMLButtonElement;
  private readonly panel: HTMLDivElement;

  constructor(
    private readonly map: WorldMapOverlay,
    /** Where we are (units). */
    private readonly here: () => { x: number; z: number },
    /** The world's width, if it wraps east-west (units); else null. */
    private readonly wrap: number | null,
  ) {
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.textContent = 'Places';
    this.button.title = 'Villages, outlaw camps and trading posts: how far, which way; show one on the map, or go there';
    this.button.onclick = () => {
      this.open = !this.open;
      this.show();
    };
    map.bar.append(this.button);
    this.panel = document.createElement('div');
    this.panel.className = 'lines-panel places-panel';
    this.panel.hidden = true;
    map.element.append(this.panel);
  }

  update(places: readonly Place[]): void {
    this.places = places;
    if (this.open) this.show();
  }

  /** From here to (x, z) (units): how far (m), and which way. */
  private toward(x: number, z: number): { m: number; way: string } {
    const h = this.here();
    let dx = x - h.x;
    if (this.wrap !== null) dx = ((((dx + this.wrap / 2) % this.wrap) + this.wrap) % this.wrap) - this.wrap / 2;
    const dz = z - h.z, a = Math.atan2(dx, -dz);
    return { m: Math.hypot(dx, dz) / UNITS_PER_METER, way: POINTS[(Math.round(a / (Math.PI / 8)) + 16) % 16]! };
  }

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
    const parts: HTMLElement[] = [el('h3', 'Places')];
    for (const kind of ['village', 'camp', 'post'] as const) {
      const these = this.places.filter((p) => p.kind === kind).map((p) => ({ p, ...this.toward(p.x, p.z) })).sort((a, b) => a.m - b.m);
      parts.push(el('b', KIND[kind]));
      if (!these.length)
        parts.push(el('p', kind === 'village' ? 'None yet: wanderers come near players, and found a hamlet where a few of them meet (on open, flat land).' : kind === 'camp' ? 'None yet: loners come to the wild near players, and set up camp where two meet.' : 'None.', 'hint'));
      for (const { p, m, way } of these) {
        const row = el('div', '', 'line-row');
        const far = m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
        row.append(el('div', p.name), el('div', `${far} ${way} · ${p.about}`, 'hint'));
        const show = el('button', 'Show') as HTMLButtonElement;
        show.type = 'button';
        show.onclick = () => this.map.centerOn(p.x, p.z);
        row.append(show);
        if (this.map.canTravel) {
          const go = el('button', 'Go') as HTMLButtonElement;
          go.type = 'button';
          go.title = 'off there (creative)';
          // (Beside it, not in its middle: a village's middle may be a cottage's door, a camp's its fire.)
          go.onclick = () => this.map.travelTo(p.x + 6 * UNITS_PER_METER, p.z + 6 * UNITS_PER_METER);
          row.append(go);
        }
        parts.push(row);
      }
    }
    this.panel.replaceChildren(...parts);
  }
}
