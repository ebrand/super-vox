/** A compass rose around the crosshair, turned so its N points to world north (-Z). */

const SIZE = 96; // px
const R = 38; // ring radius in the 100 x 100 view box

/**
 * Clockwise rotation (degrees) of the rose for a yaw (radians, 0 = facing -Z = north, increasing
 * counter-clockwise seen from above). Facing east, north is on the left: the rose turns -90°.
 */
export function roseRotation(yaw: number): number {
  const deg = (yaw * 180) / Math.PI;
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

const LABELS = [
  { text: 'N', angle: 0, color: '#ff6b5e' },
  { text: 'E', angle: 90, color: '#fff' },
  { text: 'S', angle: 180, color: '#fff' },
  { text: 'W', angle: 270, color: '#fff' },
];

export interface CompassRose {
  update(yaw: number): void;
}

export function createCompassRose(parent: HTMLElement): CompassRose {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.id = 'compass';
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('width', String(SIZE));
  svg.setAttribute('height', String(SIZE));
  svg.setAttribute('aria-hidden', 'true');
  Object.assign(svg.style, {
    position: 'fixed', left: '50%', top: '50%', margin: `${-SIZE / 2}px 0 0 ${-SIZE / 2}px`,
    pointerEvents: 'none', opacity: '0.55',
  });
  const rose = document.createElementNS(ns, 'g');
  svg.append(rose);
  const el = (name: string, attrs: Record<string, string | number>) => {
    const e = document.createElementNS(ns, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };
  // Ring with ticks every 15° (longer at 45°); the cardinal points get letters instead.
  rose.append(el('circle', { cx: 50, cy: 50, r: R, fill: 'none', stroke: '#fff', 'stroke-width': 0.8, 'stroke-opacity': 0.6 }));
  for (let a = 0; a < 360; a += 15) {
    if (a % 90 === 0) continue;
    const long = a % 45 === 0;
    rose.append(el('line', { x1: 50, y1: 50 - R, x2: 50, y2: 50 - R + (long ? 5 : 3), stroke: '#fff', 'stroke-width': long ? 1.2 : 0.8, transform: `rotate(${a} 50 50)` }));
  }
  // North pointer just inside the ring, below the N.
  rose.append(el('path', { d: `M50 ${50 - R + 8} l-3 6 h6 z`, fill: '#ff6b5e' }));
  const letters = LABELS.map(({ text, angle, color }) => {
    const rad = (angle * Math.PI) / 180;
    const x = 50 + Math.sin(rad) * (R + 0.5), y = 50 - Math.cos(rad) * (R + 0.5);
    const g = el('g', { transform: `translate(${x} ${y})` });
    g.append(el('circle', { r: 6, fill: 'rgba(0,0,0,0.45)' }));
    const t = el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: color, 'font-size': 9, 'font-weight': 700, 'font-family': 'system-ui, sans-serif' });
    t.textContent = text;
    const upright = el('g', {});
    upright.append(t);
    g.append(upright);
    rose.append(g);
    return upright;
  });
  parent.append(svg);

  let last = NaN;
  return {
    update(yaw: number) {
      const r = roseRotation(yaw);
      if (Math.abs(r - last) < 0.05) return;
      last = r;
      rose.setAttribute('transform', `rotate(${r} 50 50)`);
      // Letters stay upright on screen.
      for (const l of letters) l.setAttribute('transform', `rotate(${-r})`);
    },
  };
}
