import * as THREE from 'three';
import {
  DESIGN_SPEEDS,
  JOIN_M,
  MAX_CUT_M,
  MAX_FILL_M,
  MAX_GRADE,
  SAMPLE_M,
  TRACK_REACH_M,
  UNITS_PER_METER,
  freeEnds,
  radiusFor,
  segmentLine,
  type Track,
  type TrackPlan,
} from '@super-vox/shared';

const M = UNITS_PER_METER;

/** What's asked of the server (see the track message). */
export interface TrackAsk {
  type: 'track';
  id: number;
  from: { x: number; z: number };
  heading: number | null;
  to: { x: number; z: number };
  curve: boolean;
  speed: number;
  lay: boolean;
}

export interface TrackModeHooks {
  scene: THREE.Scene;
  /** The game's camera: its field of view and shape (and, where it is, where we stand). */
  camera: THREE.PerspectiveCamera;
  /** Which way we face (radians, as the camera's yaw). */
  yaw: () => number;
  /** Whether there's ground at a point (metres): undefined where nothing's known yet. Asked for afresh each time it's needed. */
  solid: () => (x: number, y: number, z: number) => boolean | undefined;
  send: (msg: TrackAsk) => void;
  /** Whether we may lay track here, and whether it's survival (track near where we stand only). */
  canBuild: () => boolean;
  survival: () => boolean;
  /** Something else has the keys (the map, the inventory, chat): leave them be. */
  busy: () => boolean;
  /** Esc with nothing being laid: back to the other tools. */
  exit: () => void;
}

type Tool = 'straight' | 'curve';
/** Where a segment starts (units; y metres): a track's free end (its heading out), or anywhere (no heading). */
interface Start {
  x: number;
  z: number;
  y: number;
  heading: number | null;
}

/** Colours: laid as asked, slower for its curve, can't be. */
const GOOD = new THREE.Color(0x3fb950), SLOWER = new THREE.Color(0xf0b429), BAD = new THREE.Color(0xff5c5c), ASKING = new THREE.Color(0xd0d7de);
/** Laid track, from above. */
const LAID = new THREE.Color(0x79c0ff);
const END_COLOUR = 0xffd23f, START_COLOUR = 0x3fb950;
const HELP =
  "Click a track's end (a yellow post) to go on from it, a point along a track to branch from it (curve: 2), or anywhere to start a straight; click again to lay it. " +
  'Right-click or Esc: stop. 1 straight, 2 curve, [ ] design speed. Drag: move · right-drag: turn · wheel: nearer, further · WASD: move · Tab: on.';

/**
 * Track mode (Tab, see EditTool): laying railways seen from above, as a building game does. The
 * camera leaves us where we stand and looks down on the ground ahead (orbiting it: drag to move
 * over the ground, right-drag to turn and tip, the wheel nearer or further); the world's drawn in
 * full detail around where it looks. A segment at a time (see segmentLine): click where it starts
 * (a track's free end: on from it; or anywhere, for a straight), aim, and the server plans it as it
 * goes (see the trackPlan message): its line over the ground, coloured by how fast it may be taken
 * for the design speed chosen (green as fast; amber, a tighter curve's slower; red, can't be, and
 * why), with its profile; click to lay it, and go on from its end.
 */
export class TrackMode {
  active = false;
  /** What the camera orbits (metres): the ground it looks at. The world's drawn in detail round it. */
  readonly focus = new THREE.Vector3();
  /** The camera's place and turn while laying track (copied to the game's camera to draw). */
  readonly view: THREE.PerspectiveCamera;
  private yaw = 0;
  private pitch = 0.9;
  private distance = 80;
  private tool: Tool = 'straight';
  private speed: number = DESIGN_SPEEDS[2];
  private start: Start | null = null;
  /** Where the mouse is (client pixels), and the ground under it (units; y metres). */
  private mouse: { x: number; y: number } | null = null;
  private hover: { x: number; z: number; y: number } | null = null;
  private ends: ReturnType<typeof freeEnds> = [];
  // Planning: the last asked (its id and what), what's waiting to be asked, and the answer to the last.
  private asked = 0;
  private askedKey = '';
  private askedAt = 0;
  private answered = true;
  private pending: TrackAsk | null = null;
  private plan: { key: string; plan: TrackPlan | null; error: string } | null = null;
  private laying = false;
  private note = '';
  private readonly keys = new Set<string>();
  private drag: { button: number; x: number; y: number; moved: number; grab: THREE.Vector3 | null } | null = null;
  private readonly overlay: HTMLDivElement;
  private readonly stats: HTMLDivElement;
  private readonly graph: HTMLCanvasElement;
  private readonly group = new THREE.Group();
  private readonly ribbonMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  private ribbon: THREE.Mesh | null = null;
  private readonly posts = new THREE.Group();
  /** Laid track, drawn over everything (under trees, it can't be seen from above). */
  private readonly laid = new THREE.Group();
  private readonly laidMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  private readonly postGeometry = new THREE.CylinderGeometry(0.25, 0.25, 5, 8).translate(0, 2.5, 0);
  private readonly endMaterial = new THREE.MeshBasicMaterial({ color: END_COLOUR, depthTest: false, transparent: true, opacity: 0.9 });
  private readonly startMaterial = new THREE.MeshBasicMaterial({ color: START_COLOUR, depthTest: false, transparent: true, opacity: 0.95 });
  private readonly startPost = new THREE.Mesh(this.postGeometry, this.startMaterial);

  constructor(private readonly hooks: TrackModeHooks) {
    this.view = new THREE.PerspectiveCamera(hooks.camera.fov, hooks.camera.aspect, hooks.camera.near, hooks.camera.far);
    this.group.add(this.laid, this.posts, this.startPost);
    this.group.visible = false;
    this.group.renderOrder = 20;
    this.startPost.visible = false;
    this.startPost.renderOrder = 21;
    hooks.scene.add(this.group);
    this.overlay = document.createElement('div');
    this.overlay.className = 'track-mode';
    this.overlay.hidden = true;
    this.overlay.innerHTML =
      '<div class="track-panel">' +
      '<div class="track-row"><b>Track</b> <button type="button" data-tool="straight">Straight (1)</button> <button type="button" data-tool="curve">Curve (2)</button></div>' +
      `<div class="track-row">Design speed ${DESIGN_SPEEDS.map((s) => `<button type="button" data-speed="${s}">${s}</button>`).join(' ')} km/h</div>` +
      '<div class="track-stats"></div><canvas class="track-profile" width="320" height="90"></canvas>' +
      `<div class="track-help">${HELP}</div></div>`;
    document.body.append(this.overlay);
    this.stats = this.overlay.querySelector('.track-stats')!;
    this.graph = this.overlay.querySelector('.track-profile')!;
    const panel = this.overlay.querySelector('.track-panel') as HTMLElement;
    for (const b of panel.querySelectorAll<HTMLButtonElement>('button[data-tool]')) b.onclick = () => this.setTool(b.dataset.tool as Tool);
    for (const b of panel.querySelectorAll<HTMLButtonElement>('button[data-speed]')) b.onclick = () => this.setSpeed(Number(b.dataset.speed));
    // (The panel's own clicks aren't the ground's.)
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'contextmenu'] as const) panel.addEventListener(type, (e) => e.stopPropagation());
    this.overlay.addEventListener('contextmenu', (e) => e.preventDefault());
    this.overlay.addEventListener('pointerdown', (e) => this.pointerDown(e));
    this.overlay.addEventListener('pointermove', (e) => this.pointerMove(e));
    this.overlay.addEventListener('pointerup', (e) => this.pointerUp(e));
    this.overlay.addEventListener('pointerleave', () => {
      this.mouse = null;
      this.hover = null;
    });
    this.overlay.addEventListener('wheel', (e) => {
      e.preventDefault();
      const px = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1);
      this.distance = Math.max(12, Math.min(600, this.distance * Math.exp(px * 0.0015)));
    }, { passive: false });
    // (Ahead of the game's own keys: these mean something else here.)
    window.addEventListener('keydown', (e) => this.keyDown(e), true);
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this.show();
  }

  /** On (from where we stand, looking ahead of us), or off. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.overlay.hidden = !on;
    this.group.visible = on;
    this.keys.clear();
    this.drag = null;
    if (on) {
      const p = this.hooks.camera.position;
      this.yaw = this.hooks.yaw();
      this.pitch = 0.9;
      this.distance = 80;
      // (The ground some way ahead.)
      this.focus.set(p.x - Math.sin(this.yaw) * 30, p.y - 1.6, p.z - Math.cos(this.yaw) * 30);
      this.focus.y = this.groundUnder(this.focus.x, this.focus.z, p.y + 40) ?? this.focus.y;
      this.place();
    } else {
      this.start = null;
      this.hover = null;
      this.plan = null;
      this.clearRibbon();
    }
    this.show();
  }

  /** The world's laid track: its free ends are where segments go on from. */
  setTracks(tracks: readonly Track[]): void {
    this.ends = freeEnds(tracks);
    for (const m of this.laid.children) (m as THREE.Mesh).geometry.dispose();
    this.laid.clear();
    for (const t of tracks) {
      const m = new THREE.Mesh(ribbonGeometry(t.points.filter((_, i) => i % 2 === 0 || i === t.points.length - 1).map((p) => ({ x: p.x / M, y: p.y / M, z: p.z / M })), 1.2, LAID), this.laidMaterial);
      m.renderOrder = 19;
      this.laid.add(m);
    }
    this.posts.clear();
    for (const e of this.ends) {
      const post = new THREE.Mesh(this.postGeometry, this.endMaterial);
      post.position.set(e.x / M, e.y / M, e.z / M);
      post.renderOrder = 21;
      this.posts.add(post);
    }
  }

  /** The server's plan for what was asked (only the last asked counts). */
  planned(msg: { id: number; error?: string; laid?: boolean; plan?: TrackPlan }): void {
    if (msg.id !== this.asked) return;
    this.answered = true;
    if (this.laying) {
      this.laying = false;
      if (msg.laid && msg.plan) {
        // Laid: go on from its end.
        const end = msg.plan.end, last = msg.plan.line.at(-1)!;
        this.start = { x: end.x, z: end.z, y: last.y / M, heading: end.heading };
        this.plan = null;
        this.askedKey = '';
        this.note = `laid ${Math.round(msg.plan.length)} m: go on from its end, or right-click to stop`;
      } else {
        this.note = '';
        this.plan = { key: this.askedKey, plan: msg.plan ?? null, error: msg.error ?? 'not laid' };
      }
    } else this.plan = { key: this.askedKey, plan: msg.plan ?? null, error: msg.error ?? '' };
    if (this.pending) {
      const next = this.pending;
      this.pending = null;
      this.sendAsk(next);
    }
    this.show();
  }

  /** Each frame: moved over the ground by the keys, the camera placed, the segment aimed at. */
  frame(dt: number): void {
    if (!this.active) return;
    if (!this.hooks.busy()) {
      const f = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) - (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
      const r = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
      if (f || r) {
        const v = this.distance * 0.9 * Math.min(dt, 0.1);
        const sx = -Math.sin(this.yaw), sz = -Math.cos(this.yaw);
        this.moveFocus(this.focus.x + (sx * f - sz * r) * v, this.focus.z + (sz * f + sx * r) * v);
      }
    }
    this.view.aspect = this.hooks.camera.aspect;
    this.view.fov = this.hooks.camera.fov;
    this.view.updateProjectionMatrix();
    this.place();
    if (this.mouse && !this.drag) this.aim();
  }

  /** The camera, `distance` back from the focus along the way it looks (turned `yaw`, tipped down `pitch`). */
  private place(): void {
    const c = Math.cos(this.pitch);
    const back = new THREE.Vector3(Math.sin(this.yaw) * c, Math.sin(this.pitch), Math.cos(this.yaw) * c).multiplyScalar(this.distance);
    this.view.position.copy(this.focus).add(back);
    this.view.lookAt(this.focus);
    this.view.updateMatrixWorld();
  }

  /** Moves what's looked at (metres), kept near us in survival; on the ground there. */
  private moveFocus(x: number, z: number): void {
    if (this.hooks.survival()) {
      const p = this.hooks.camera.position, dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz), most = TRACK_REACH_M;
      if (d > most) (x = p.x + (dx * most) / d), (z = p.z + (dz * most) / d);
    }
    this.focus.x = x;
    this.focus.z = z;
    const g = this.groundUnder(x, z, this.focus.y + 60);
    if (g !== null) this.focus.y = g;
  }

  /** The top of the ground (metres) at x, z, looking down from `from`; null if nothing's known there. */
  private groundUnder(x: number, z: number, from: number): number | null {
    const solid = this.hooks.solid();
    for (let y = from; y > from - 400; y -= 0.5) if (solid(x, y, z)) return Math.floor(y * 2 + 1) / 2;
    return null;
  }

  /** The ground (metres) a screen point looks at, or null. */
  private pick(clientX: number, clientY: number): THREE.Vector3 | null {
    const r = this.overlay.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.view);
    const o = ray.ray.origin, d = ray.ray.direction, solid = this.hooks.solid();
    const at = (t: number) => solid(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t) === true;
    let t = 0, step = 0.25;
    while (t < 4000) {
      step = Math.max(0.25, Math.min(8, t * 0.004));
      if (at(t + step)) {
        // (Narrowed down to the surface.)
        let lo = t, hi = t + step;
        for (let i = 0; i < 10; i++) {
          const mid = (lo + hi) / 2;
          if (at(mid)) hi = mid;
          else lo = mid;
        }
        return new THREE.Vector3(o.x + d.x * hi, o.y + d.y * hi, o.z + d.z * hi);
      }
      t += step;
    }
    return null;
  }

  /** The free track end near a point (units), if one's within JOIN_M. */
  private endNear(x: number, z: number): (typeof this.ends)[number] | null {
    let best: (typeof this.ends)[number] | null = null, d = JOIN_M * M;
    for (const e of this.ends) {
      const de = Math.hypot(e.x - x, e.z - z);
      if (de < d) (d = de), (best = e);
    }
    return best;
  }

  /** The ground under the mouse; the segment to it shown, and planned. */
  private aim(): void {
    const g = this.mouse && this.pick(this.mouse.x, this.mouse.y);
    this.hover = g ? { x: g.x * M, z: g.z * M, y: g.y } : null;
    // (Near a free end, with nothing started: that end's where it'd start.)
    const near = !this.start && this.hover ? this.endNear(this.hover.x, this.hover.z) : null;
    this.endMaterial.opacity = near ? 1 : 0.85;
    for (const post of this.posts.children) post.scale.setScalar(near && Math.hypot(post.position.x * M - near.x, post.position.z * M - near.z) < 1 ? 1.6 : 1);
    if (!this.start || !this.hover) {
      this.clearRibbon();
      return;
    }
    const ask: TrackAsk = { type: 'track', id: 0, from: { x: this.start.x, z: this.start.z }, heading: this.start.heading, to: { x: Math.round(this.hover.x), z: Math.round(this.hover.z) }, curve: this.tool === 'curve', speed: this.speed, lay: false };
    const key = keyOf(ask);
    if (key === this.askedKey || (this.pending && keyOf(this.pending) === key)) return this.drawRibbon();
    // The line at once (its heights guessed), the plan when it comes.
    if (!this.laying) {
      if (!this.answered && performance.now() - this.askedAt < 1500) this.pending = ask;
      else this.sendAsk(ask);
    }
    this.drawRibbon();
  }

  private sendAsk(ask: TrackAsk): void {
    ask.id = ++this.asked;
    this.askedKey = keyOf(ask);
    this.askedAt = performance.now();
    this.answered = false;
    this.hooks.send(ask);
  }

  /** The segment being aimed: the plan's line (coloured by speed, or red: why not), or (asked, not yet answered) the line as it'd go. */
  private drawRibbon(): void {
    this.clearRibbon();
    const start = this.start;
    if (!start || !this.hover) return;
    const current = this.plan && this.plan.key === this.askedKey ? this.plan : null;
    let pts: { x: number; y: number; z: number }[], colour: THREE.Color;
    if (current?.plan) {
      pts = current.plan.line.map((p) => ({ x: p.x / M, y: p.y / M, z: p.z / M }));
      colour = current.error ? BAD : current.plan.speed < this.speed ? SLOWER : GOOD;
    } else {
      const seg = segmentLine({ from: start, heading: start.heading, to: this.hover, curve: this.tool === 'curve' }, SAMPLE_M * M * 2);
      if (typeof seg === 'string') {
        // (Can't be: a line straight to the aim, red.)
        pts = [{ x: start.x / M, y: start.y, z: start.z / M }, { x: this.hover.x / M, y: this.hover.y, z: this.hover.z / M }];
        colour = BAD;
      } else {
        const n = seg.line.length - 1;
        pts = seg.line.map((p, i) => ({ x: p.x / M, y: start.y + ((this.hover!.y - start.y) * i) / Math.max(1, n), z: p.z / M }));
        colour = current?.error ? BAD : ASKING;
      }
    }
    this.ribbon = new THREE.Mesh(ribbonGeometry(pts, 1.8, colour), this.ribbonMaterial);
    this.ribbon.renderOrder = 20;
    this.group.add(this.ribbon);
    this.startPost.visible = true;
    this.startPost.position.set(start.x / M, start.y, start.z / M);
  }

  private clearRibbon(): void {
    if (this.ribbon) {
      this.ribbon.geometry.dispose();
      this.ribbon.removeFromParent();
      this.ribbon = null;
    }
    this.startPost.visible = !!this.start;
    if (this.start) this.startPost.position.set(this.start.x / M, this.start.y, this.start.z / M);
  }

  private pointerDown(e: PointerEvent): void {
    this.overlay.setPointerCapture(e.pointerId);
    // (Dragging the ground: the point grabbed kept under the mouse.)
    const grab = e.button === 0 || e.button === 1 ? this.pick(e.clientX, e.clientY) : null;
    this.drag = { button: e.button, x: e.clientX, y: e.clientY, moved: 0, grab };
  }

  private pointerMove(e: PointerEvent): void {
    this.mouse = { x: e.clientX, y: e.clientY };
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    d.moved += Math.abs(dx) + Math.abs(dy);
    d.x = e.clientX;
    d.y = e.clientY;
    if (d.moved < 5) return;
    this.overlay.classList.add('dragging');
    if (d.button === 2) {
      // Turned round the focus, and tipped.
      this.yaw -= dx * 0.005;
      this.pitch = Math.max(0.25, Math.min(1.5, this.pitch + dy * 0.005));
      this.place();
      return;
    }
    if (!d.grab) return;
    // Where the mouse's ray meets the grabbed point's level: the focus moved so the point's under it.
    const r = this.overlay.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.view);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -d.grab.y), new THREE.Vector3());
    if (!hit) return;
    this.moveFocus(this.focus.x + d.grab.x - hit.x, this.focus.z + d.grab.z - hit.z);
    this.place();
  }

  private pointerUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    this.overlay.classList.remove('dragging');
    if (!d || d.moved >= 5) return;
    this.mouse = { x: e.clientX, y: e.clientY };
    if (e.button === 2) return this.stop();
    if (e.button === 0) this.click();
  }

  private click(): void {
    this.aim();
    if (!this.hover) return;
    if (!this.start) {
      // From a track's end (its way, its height), or from here (a straight).
      const end = this.endNear(this.hover.x, this.hover.z);
      this.start = end ? { x: end.x, z: end.z, y: end.y / M, heading: end.heading } : { x: Math.round(this.hover.x), z: Math.round(this.hover.z), y: this.hover.y, heading: null };
      this.note = end ? '' : this.tool === 'curve' ? "a curve goes on from a track's end: a straight from here first" : '';
      this.plan = null;
      this.askedKey = '';
      this.aim();
      this.show();
      return;
    }
    // Laid if it's been planned as aimed now, and can be.
    const current = this.plan && this.plan.key === this.askedKey ? this.plan : null;
    if (!current?.plan || current.error || this.laying) return;
    if (!this.hooks.canBuild()) {
      this.note = "you can't build here";
      return this.show();
    }
    const ask: TrackAsk = { type: 'track', id: 0, from: { x: this.start.x, z: this.start.z }, heading: this.start.heading, to: { x: Math.round(this.hover.x), z: Math.round(this.hover.z) }, curve: this.tool === 'curve', speed: this.speed, lay: true };
    this.pending = null;
    this.laying = true;
    this.note = 'laying…';
    this.sendAsk(ask);
    this.show();
  }

  /** Nothing being laid: nothing started. */
  private stop(): void {
    this.start = null;
    this.plan = null;
    this.askedKey = '';
    this.note = '';
    this.clearRibbon();
    this.show();
  }

  private setTool(tool: Tool): void {
    this.tool = tool;
    this.askedKey = '';
    this.show();
  }

  private setSpeed(speed: number): void {
    this.speed = speed;
    this.askedKey = '';
    this.show();
  }

  private keyDown(e: KeyboardEvent): void {
    if (!this.active || this.hooks.busy() || e.metaKey || e.ctrlKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    const take = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (/^(Key[WASD]|Arrow(Up|Down|Left|Right))$/.test(e.code)) {
      this.keys.add(e.code);
      return take();
    }
    if (e.repeat) return;
    if (e.code === 'Digit1' || e.code === 'Digit2') {
      take();
      return this.setTool(e.code === 'Digit1' ? 'straight' : 'curve');
    }
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      take();
      const i = DESIGN_SPEEDS.indexOf(this.speed as (typeof DESIGN_SPEEDS)[number]) + (e.code === 'BracketLeft' ? -1 : 1);
      return this.setSpeed(DESIGN_SPEEDS[Math.max(0, Math.min(DESIGN_SPEEDS.length - 1, i))]!);
    }
    if (e.code === 'Escape') {
      take();
      if (this.start) this.stop();
      else this.hooks.exit();
    }
  }

  private show(): void {
    for (const b of this.overlay.querySelectorAll<HTMLButtonElement>('button[data-tool]')) b.classList.toggle('on', b.dataset.tool === this.tool);
    for (const b of this.overlay.querySelectorAll<HTMLButtonElement>('button[data-speed]')) b.classList.toggle('on', Number(b.dataset.speed) === this.speed);
    const current = this.plan && this.plan.key === this.askedKey ? this.plan : null;
    const p = current?.plan ?? null;
    const lines: string[] = [];
    if (!this.start) lines.push(this.ends.length ? "Start: a track's end (yellow), or anywhere for a straight." : 'Start: click the ground (a straight first; curves go on from its end).');
    else if (!current) lines.push('working it out…');
    if (p) {
      const radius = p.radius === null ? 'straight' : `${p.radius} m radius`;
      lines.push(`${Math.round(p.length)} m · ${radius} · ${p.speed} km/h · track ${(p.maxGrade * 100).toFixed(1)}%, ground ${(p.groundGrade * 100).toFixed(1)}% at its steepest (${(MAX_GRADE * 100).toFixed(0)}% at most)`);
      lines.push(`cut ${p.maxCut.toFixed(1)} m (${MAX_CUT_M} at most) · built up ${p.maxFill.toFixed(1)} m (${MAX_FILL_M} at most)${p.rails ? ` · ${p.rails} rails` : ''}`);
      if (p.speed < this.speed) lines.push(`⚠ slower: ${this.speed} km/h needs a ${Math.ceil(radiusFor(this.speed))} m radius at least`);
    }
    if (current?.error) lines.push(`✗ ${current.error}`);
    if (this.note) lines.push(this.note);
    this.stats.textContent = lines.join('\n');
    this.stats.classList.toggle('bad', !!current?.error);
    this.drawProfile(p);
  }

  /** The profile: the ground (brown) and the track (light), how high along how far. */
  private drawProfile(plan: TrackPlan | null): void {
    const g = this.graph.getContext('2d')!, w = this.graph.width, h = this.graph.height;
    g.clearRect(0, 0, w, h);
    const prof = plan?.profile ?? [];
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
}

const keyOf = (a: TrackAsk) => `${a.from.x},${a.from.z},${a.heading},${a.to.x},${a.to.z},${a.curve},${a.speed}`;

/** A flat strip `width` m wide along points (metres), a little over them, in one colour. */
export function ribbonGeometry(pts: readonly { x: number; y: number; z: number }[], width: number, colour: THREE.Color): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  pts.forEach((p, i) => {
    const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(pts.length - 1, i + 1)]!;
    let dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    (dx /= l), (dz /= l);
    const sx = -dz * (width / 2), sz = dx * (width / 2);
    pos.push(p.x + sx, p.y + 0.3, p.z + sz, p.x - sx, p.y + 0.3, p.z - sz);
    col.push(colour.r, colour.g, colour.b, colour.r, colour.g, colour.b);
    if (i > 0) {
      const k = 2 * i;
      idx.push(k - 2, k - 1, k, k - 1, k + 1, k);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}
