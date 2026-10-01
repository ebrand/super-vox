import { LIGHTING_LIMITS, defaultLighting, type Lighting } from './lighting.js';

const FIELDS: { key: keyof Lighting; label: string; step: number; unit?: string }[] = [
  { key: 'sunElevation', label: 'Sun height', step: 1, unit: '°' },
  { key: 'sunAzimuth', label: 'Sun direction', step: 1, unit: '°' },
  { key: 'sunStrength', label: 'Sun strength', step: 0.01 },
  { key: 'sunWarmth', label: 'Sun warmth', step: 0.01 },
  { key: 'skyLight', label: 'Sky light (shade)', step: 0.01 },
  { key: 'groundLight', label: 'Ground bounce', step: 0.01 },
  { key: 'cornerShading', label: 'Corner shading', step: 0.01 },
  { key: 'haze', label: 'Haze', step: 0.05 },
  { key: 'exposure', label: 'Exposure', step: 0.01 },
];

/**
 * A panel of lighting sliders over the game: every change calls `onChange` (which applies and
 * saves it). Hidden until toggled.
 */
export class LightingPanel {
  readonly root: HTMLDivElement;
  private readonly inputs = new Map<keyof Lighting, { range: HTMLInputElement; value: HTMLSpanElement }>();

  constructor(private lighting: Lighting, private readonly onChange: (l: Lighting) => void) {
    const root = (this.root = document.createElement('div'));
    root.id = 'lighting';
    Object.assign(root.style, {
      position: 'fixed', right: '8px', top: '40px', width: '270px', padding: '10px 12px', display: 'none',
      background: 'rgba(20, 24, 30, 0.85)', color: '#e6e6e6', font: '12px system-ui, sans-serif', borderRadius: '6px', zIndex: '10',
    });
    const title = document.createElement('div');
    title.textContent = 'Lighting (L to close)';
    Object.assign(title.style, { fontWeight: '600', marginBottom: '6px' });
    root.append(title);
    for (const f of FIELDS) {
      const [lo, hi] = LIGHTING_LIMITS[f.key];
      const row = document.createElement('label');
      Object.assign(row.style, { display: 'grid', gridTemplateColumns: '1fr 44px', gap: '0 6px', marginBottom: '4px' });
      const name = document.createElement('span');
      name.textContent = f.label;
      const value = document.createElement('span');
      value.style.textAlign = 'right';
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(lo);
      range.max = String(hi);
      range.step = String(f.step);
      range.dataset.key = f.key;
      range.style.gridColumn = '1 / 3';
      // Keys go to the slider, not the game (but L still closes the panel).
      range.addEventListener('keydown', (e) => {
        if (e.code !== 'KeyL') e.stopPropagation();
      });
      range.addEventListener('input', () => {
        this.lighting = { ...this.lighting, [f.key]: Number(range.value) };
        this.show(f.key);
        this.onChange(this.lighting);
      });
      row.append(name, value, range);
      root.append(row);
      this.inputs.set(f.key, { range, value });
    }
    const reset = document.createElement('button');
    reset.textContent = 'Reset to defaults';
    reset.style.marginTop = '4px';
    reset.addEventListener('click', () => this.set(defaultLighting()));
    root.append(reset);
    this.set(lighting, false);
  }

  get isOpen(): boolean {
    return this.root.style.display !== 'none';
  }

  toggle(): void {
    this.root.style.display = this.isOpen ? 'none' : 'block';
  }

  /** Shows `l` on the sliders (and applies it unless `notify` is false). */
  set(l: Lighting, notify = true): void {
    this.lighting = { ...l };
    for (const key of this.inputs.keys()) this.show(key);
    if (notify) this.onChange(this.lighting);
  }

  private show(key: keyof Lighting): void {
    const f = FIELDS.find((x) => x.key === key)!, el = this.inputs.get(key)!, v = this.lighting[key];
    el.range.value = String(v);
    el.value.textContent = f.unit ? `${Math.round(v)}${f.unit}` : v.toFixed(2);
  }
}
