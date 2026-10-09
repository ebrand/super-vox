import { JOIN_M, MAX_GRADE, MIN_RADIUS_M, UNITS_PER_METER, type Track, type TrackPlan } from '@super-vox/shared';
import type { WorldMapOverlay } from './worldMap.js';

/**
 * Drawing a railway on the world map (M): "Draw track" on, each click a point of the route (one
 * near a track's end: from there); the server plans it as each point goes down (see the trackPlan
 * message): the line it'd follow, how long, how steep, how much cut and filled, the rails it'd
 * take, and its profile; or why it can't be. "Lay track" lays it. Laid track's drawn on the map too.
 */
export class TrackDrawer {
  private active = false;
  private points: { x: number; z: number }[] = [];
  private plan: TrackPlan | null = null;
  private error = '';
  private asked = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private laying = false;
  private tracks: Track[] = [];
  private readonly button: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  private readonly stats: HTMLDivElement;
  private readonly graph: HTMLCanvasElement;
  private readonly layButton: HTMLButtonElement;

  constructor(
    private readonly map: WorldMapOverlay,
    private readonly send: (msg: { type: 'track'; id: number; points: { x: number; z: number }[]; lay: boolean }) => void,
    /** Whether we may lay track (builders), and whether rails are paid for (survival). */
    private readonly canBuild: () => boolean,
  ) {
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.textContent = 'Draw track';
    this.button.title = 'Click points on the map for a railway; the track is laid along them (cut through hills, built up over dips)';
    this.button.onclick = () => this.setActive(!this.active);
    map.bar.append(this.button);
    this.panel = document.createElement('div');
    this.panel.className = 'track-panel';
    this.panel.hidden = true;
    this.panel.innerHTML =
      `<div class="track-help">Click the map for each point of the route (near a track's end: from it). Backspace takes the last away. Drag to look around.</div>` +
      '<div class="track-stats"></div><canvas class="track-profile" width="320" height="90"></canvas>' +
      '<div class="track-buttons"><button type="button" class="lay">Lay track</button> <button type="button" class="undo">Last point away</button> <button type="button" class="clear">Clear</button></div>';
    map.element.append(this.panel);
    this.stats = this.panel.querySelector('.track-stats')!;
    this.graph = this.panel.querySelector('.track-profile')!;
    this.layButton = this.panel.querySelector('button.lay')!;
    this.layButton.onclick = () => this.lay();
    (this.panel.querySelector('button.undo') as HTMLButtonElement).onclick = () => this.undo();
    (this.panel.querySelector('button.clear') as HTMLButtonElement).onclick = () => this.clear();
    map.clicked = (at) => {
      if (!this.active) return false;
      this.points.push(this.snap(at));
      this.ask();
      return true;
    };
    map.drawMore = (g, toX, toZ, near, dpr) => this.draw(g, toX, toZ, near, dpr);
    window.addEventListener('keydown', (e) => {
      if (!this.active || !map.isOpen || (e.code !== 'Backspace' && e.code !== 'Delete')) return;
      e.preventDefault();
      this.undo();
    });
    this.show();
  }

  /** The world's laid track (drawn on the map). */
  setTracks(tracks: Track[]): void {
    this.tracks = tracks;
    this.map.update();
  }

  /** The server's plan for what we asked (only the last asked counts). */
  planned(msg: { id: number; error?: string; laid?: boolean; plan?: TrackPlan }): void {
    if (msg.id !== this.asked) return;
    this.laying = false;
    this.plan = msg.plan ?? null;
    this.error = msg.error ?? '';
    if (msg.laid) {
      this.points = [];
      this.plan = null;
      this.error = '';
      this.stats.textContent = '';
      this.flash('Laid. Draw another, or close the map (M) to see it.');
      this.setActive(false);
      return;
    }
    this.show();
    this.map.update();
  }

  private setActive(on: boolean): void {
    this.active = on;
    this.button.classList.toggle('on', on);
    this.panel.hidden = !on && !this.flashed;
    this.show();
    this.map.update();
  }

  private flashed = false;
  private flash(text: string): void {
    this.flashed = true;
    this.panel.hidden = false;
    (this.panel.querySelector('.track-help') as HTMLElement).textContent = text;
    setTimeout(() => {
      this.flashed = false;
      if (!this.active) this.panel.hidden = true;
    }, 4000);
  }

  /** A point near a track's end: that end (the route joins it there). */
  private snap(at: { x: number; z: number }): { x: number; z: number } {
    const near = JOIN_M * UNITS_PER_METER;
    for (const t of this.tracks)
      for (const end of [t.points[0]!, t.points.at(-1)!]) if (Math.hypot(end.x - at.x, end.z - at.z) < near) return { x: end.x, z: end.z };
    return at;
  }

  private undo(): void {
    this.points.pop();
    this.ask();
  }

  private clear(): void {
    this.points = [];
    this.ask();
  }

  /** Asks for a plan of the route as it is now (a moment after the last change). */
  private ask(): void {
    this.plan = null;
    this.error = '';
    this.show();
    this.map.update();
    if (this.timer) clearTimeout(this.timer);
    if (this.points.length < 2) return;
    this.timer = setTimeout(() => {
      this.send({ type: 'track', id: ++this.asked, points: this.points, lay: false });
    }, 150);
  }

  private lay(): void {
    if (this.points.length < 2 || !this.plan || this.laying) return;
    this.laying = true;
    this.send({ type: 'track', id: ++this.asked, points: this.points, lay: true });
    this.show();
  }

  private show(): void {
    const help = this.panel.querySelector('.track-help') as HTMLElement;
    if (!this.flashed) help.textContent = "Click the map for each point of the route (near a track's end: from it). Backspace takes the last away. Drag to look around.";
    const p = this.plan;
    const lines: string[] = [];
    if (this.points.length < 2) lines.push(this.points.length ? 'One point: another, for a route.' : '');
    else if (!p && !this.error) lines.push('working it out…');
    if (p) {
      lines.push(`${Math.round(p.length)} m · steepest ${(p.maxGrade * 100).toFixed(1)}% (${(MAX_GRADE * 100).toFixed(0)}% at most) · tightest curve ${Number.isFinite(p.minRadius) ? `${Math.round(p.minRadius)} m` : 'none'} (${MIN_RADIUS_M} m at least)`);
      lines.push(`cut up to ${p.maxCut.toFixed(1)} m · filled up to ${p.maxFill.toFixed(1)} m${p.rails ? ` · ${p.rails} rails` : ''}`);
    }
    if (this.error) lines.push(`✗ ${this.error}`);
    this.stats.textContent = lines.filter(Boolean).join('\n');
    this.stats.classList.toggle('bad', !!this.error);
    this.layButton.disabled = !p || !!this.error || this.laying || !this.canBuild();
    this.layButton.textContent = this.laying ? 'Laying…' : 'Lay track';
    this.layButton.title = this.canBuild() ? '' : "you can't build here";
    this.drawProfile();
  }

  /** The profile: the ground (brown) and the track (light), how high along how far. */
  private drawProfile(): void {
    const g = this.graph.getContext('2d')!, w = this.graph.width, h = this.graph.height;
    g.clearRect(0, 0, w, h);
    const prof = this.plan?.profile ?? [];
    this.graph.hidden = prof.length < 2;
    if (prof.length < 2) return;
    const s1 = prof.at(-1)!.s || 1, ys = prof.flatMap((p) => [p.y, p.ground]);
    const lo = Math.min(...ys) - 1, hi = Math.max(...ys) + 1;
    const X = (s: number) => 4 + ((w - 8) * s) / s1, Y = (y: number) => h - 4 - ((h - 8) * (y - lo)) / (hi - lo);
    g.fillStyle = 'rgba(140, 100, 60, 0.6)';
    g.beginPath();
    g.moveTo(X(0), h);
    for (const p of prof) g.lineTo(X(p.s), Y(p.ground));
    g.lineTo(X(s1), h);
    g.fill();
    g.strokeStyle = '#e6e6e6';
    g.lineWidth = 2;
    g.beginPath();
    prof.forEach((p, i) => (i ? g.lineTo(X(p.s), Y(p.y)) : g.moveTo(X(p.s), Y(p.y))));
    g.stroke();
    g.fillStyle = '#9aa4ae';
    g.font = '10px system-ui';
    g.fillText(`${hi.toFixed(0)} m`, 4, 10);
    g.fillText(`${lo.toFixed(0)} m`, 4, h - 2);
  }

  private draw(g: CanvasRenderingContext2D, toX: (x: number) => number, toZ: (z: number) => number, near: (x: number) => number, dpr: number): void {
    const line = (pts: readonly { x: number; z: number }[], colour: string, width: number, dash: number[] = []) => {
      if (pts.length < 2) return;
      g.strokeStyle = colour;
      g.lineWidth = width * dpr;
      g.setLineDash(dash.map((d) => d * dpr));
      g.beginPath();
      const x0 = near(pts[0]!.x) - pts[0]!.x;
      pts.forEach((p, i) => (i ? g.lineTo(toX(p.x + x0), toZ(p.z)) : g.moveTo(toX(p.x + x0), toZ(p.z))));
      g.stroke();
      g.setLineDash([]);
    };
    // Laid track: dark rails on a pale bed.
    for (const t of this.tracks) {
      line(t.points, 'rgba(220, 210, 190, 0.9)', 4);
      line(t.points, 'rgba(40, 40, 44, 0.95)', 1.6);
    }
    if (!this.active) return;
    // The route as drawn, and the line it'd be laid on.
    line(this.points, 'rgba(255, 255, 255, 0.7)', 1.5, [5, 4]);
    if (this.plan) line(this.plan.line, this.error ? '#ff7b72' : '#ffd23f', 3);
    g.fillStyle = '#ffd23f';
    g.strokeStyle = '#000';
    g.lineWidth = 1.5 * dpr;
    for (const p of this.points) {
      g.beginPath();
      g.arc(toX(near(p.x)), toZ(p.z), 4.5 * dpr, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
  }
}
