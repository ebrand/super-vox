import { formatHours, type ClockChange, type DayClock } from '@super-vox/shared';
import { LIGHTING_LIMITS, defaultLighting, type Lighting } from './lighting.js';

/** The world clock as the panel sees it: read it, and ask the server to change it (resolves to an error message or null). */
export interface TimeControls {
  read(): { hours: number; clock: DayClock } | null;
  change(c: ClockChange): Promise<string | null>;
}

const DAY_LENGTHS: [string, number | 'real'][] = [['6 min', 6], ['12 min', 12], ['24 min', 24], ['48 min', 48], ['2 hours', 120], ['Real time', 'real']];

const FIELDS: { key: keyof Lighting; label: string; step: number; unit?: string }[] = [
  { key: 'noonSunHeight', label: 'Noon sun height', step: 1, unit: '°' },
  { key: 'noonSunDirection', label: 'Noon sun direction', step: 1, unit: '°' },
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

  private timeLabel: HTMLSpanElement | null = null;
  private timeRange: HTMLInputElement | null = null;
  private dayLength: HTMLSelectElement | null = null;
  private frozen: HTMLInputElement | null = null;
  private timeError: HTMLDivElement | null = null;

  constructor(private lighting: Lighting, private readonly onChange: (l: Lighting) => void, private readonly time: TimeControls | null = null) {
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
    if (time) this.buildTime(root, time);
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

  /** World time: the clock, and (where the server allows it) controls to set it. */
  private buildTime(root: HTMLDivElement, time: TimeControls): void {
    const box = document.createElement('div');
    Object.assign(box.style, { borderBottom: '1px solid #444', paddingBottom: '6px', marginBottom: '6px' });
    const line = document.createElement('div');
    Object.assign(line.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' });
    this.timeLabel = document.createElement('span');
    const day = (this.dayLength = document.createElement('select'));
    day.title = 'Length of a day';
    for (const [label, v] of DAY_LENGTHS) day.append(new Option(label, String(v)));
    line.append(this.timeLabel, day);
    const range = (this.timeRange = document.createElement('input'));
    range.type = 'range';
    range.min = '0';
    range.max = '23.99';
    range.step = '0.05';
    range.style.width = '100%';
    range.title = 'Time of day';
    const freezeLabel = document.createElement('label');
    const frozen = (this.frozen = document.createElement('input'));
    frozen.type = 'checkbox';
    freezeLabel.append(frozen, ' Stop time');
    const err = (this.timeError = document.createElement('div'));
    err.style.color = '#ff7b72';
    box.append(line, range, freezeLabel, err);
    root.append(box);
    const send = async (c: ClockChange) => {
      const e = await time.change(c);
      err.textContent = e ?? '';
    };
    for (const el of [range, day, frozen]) el.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).code !== 'KeyL') e.stopPropagation(); });
    let dragging = false;
    range.addEventListener('input', () => {
      dragging = true;
      this.timeLabel!.textContent = formatHours(Number(range.value));
    });
    range.addEventListener('change', () => {
      dragging = false;
      void send({ hours: Number(range.value) });
    });
    day.addEventListener('change', () => void send({ dayMinutes: day.value === 'real' ? 'real' : Number(day.value) }));
    frozen.addEventListener('change', () => void send({ frozen: frozen.checked }));
    this.isDragging = () => dragging;
  }

  private isDragging: () => boolean = () => false;

  /** Shows the current world time (call every frame or so while open). */
  updateTime(): void {
    if (!this.time || !this.isOpen || !this.timeLabel) return;
    const t = this.time.read();
    if (!t) return;
    const len = t.clock.dayMinutes === 'real' ? 'real time' : `${t.clock.dayMinutes}-min day`;
    if (!this.isDragging()) {
      this.timeLabel.textContent = `${formatHours(t.hours)} · ${len}${t.clock.frozen ? ' · stopped' : ''}`;
      this.timeRange!.value = String(t.hours);
    }
    if (document.activeElement !== this.dayLength) {
      const v = String(t.clock.dayMinutes);
      if (![...this.dayLength!.options].some((o) => o.value === v)) this.dayLength!.append(new Option(`${v} min`, v));
      this.dayLength!.value = v;
    }
    this.frozen!.checked = t.clock.frozen;
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
